const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { createAbortError } = require("./abortError");

let cachedFFmpegPath = null;

function getFFmpegPath() {
  if (cachedFFmpegPath) return cachedFFmpegPath;

  try {
    const ffmpegPath = path.normalize(require("ffmpeg-static"));

    // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
    const unpackedPath = ffmpegPath.includes("app.asar")
      ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
      : null;

    if (unpackedPath && fs.existsSync(unpackedPath)) {
      try {
        fs.accessSync(unpackedPath, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(unpackedPath, 0o755);
        } catch (chmodErr) {
          debugLogger.warn("Failed to chmod FFmpeg", { error: chmodErr.message });
        }
      }
      cachedFFmpegPath = unpackedPath;
      return unpackedPath;
    }

    // Try original path (development or if not in ASAR). An in-asar path passes
    // existsSync but can never be spawned, so fall through to system FFmpeg instead.
    if (!unpackedPath && fs.existsSync(ffmpegPath)) {
      try {
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
      } catch {
        debugLogger.debug("FFmpeg exists but not executable", { ffmpegPath });
        throw new Error("Not executable");
      }
      cachedFFmpegPath = ffmpegPath;
      return ffmpegPath;
    }
  } catch (err) {
    debugLogger.debug("Bundled FFmpeg not available", { error: err.message });
  }

  const pathDirs = (process.env.PATH || "").split(":").map((entry) => entry.replace(/^"|"$/g, ""));
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", ...pathDirs]) {
    if (!dir) continue;
    const candidate = path.join(dir, "ffmpeg");
    if (!fs.existsSync(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    cachedFFmpegPath = candidate;
    return candidate;
  }

  debugLogger.debug("FFmpeg not found");
  return null;
}

function isWavFormat(buffer) {
  if (!buffer || buffer.length < 12) return false;

  return (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x41 && // A
    buffer[10] === 0x56 && // V
    buffer[11] === 0x45 // E
  );
}

// Shared spawn/abort/exit handling for the one-shot conversions below. Resolves
// once ffmpeg exits cleanly and has written a non-empty output file.
function runFFmpegConversion(args, outputPath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      reject(
        new Error(
          "FFmpeg not found - the bundled FFmpeg is missing from this install and no system FFmpeg was found on PATH; reinstalling OpenWhispr should fix this"
        )
      );
      return;
    }

    const proc = spawn(ffmpegPath, [...args, "-y", outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // an uncaught throw here would escape the abort dispatch
      }
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      reject(new Error(`FFmpeg process error: ${error.message}`));
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      if (code !== 0) {
        const stderrPreview = stderr.slice(-500).trim();
        debugLogger.debug("FFmpeg conversion failed", { code, stderr: stderrPreview });
        reject(
          new Error(`FFmpeg exited with code ${code}${stderrPreview ? `: ${stderrPreview}` : ""}`)
        );
        return;
      }

      if (!fs.existsSync(outputPath)) {
        reject(new Error("FFmpeg conversion produced no output file"));
        return;
      }

      const stats = fs.statSync(outputPath);
      if (stats.size === 0) {
        reject(new Error("FFmpeg conversion produced empty output file"));
        return;
      }

      debugLogger.debug("FFmpeg conversion complete", { outputSize: stats.size });
      resolve();
    });
  });
}

function convertToWav(inputPath, outputPath, options = {}) {
  const { sampleRate = 16000, channels = 1, signal } = options;

  debugLogger.debug("Converting audio with FFmpeg", {
    input: inputPath,
    output: outputPath,
    sampleRate,
    channels,
  });

  return runFFmpegConversion(
    ["-i", inputPath, "-ar", String(sampleRate), "-ac", String(channels), "-c:a", "pcm_s16le"],
    outputPath,
    { signal }
  );
}

let reencodeSequence = 0;

function parseWavFormat(wavBuffer) {
  if (!isWavFormat(wavBuffer)) return null;

  let offset = 12; // Skip RIFF header (4) + size (4) + WAVE (4)
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      return {
        audioFormat: wavBuffer.readUInt16LE(offset + 8),
        channels: wavBuffer.readUInt16LE(offset + 10),
        sampleRate: wavBuffer.readUInt32LE(offset + 12),
        bitsPerSample: wavBuffer.readUInt16LE(offset + 22),
      };
    }

    offset += 8 + chunkSize;
  }

  return null;
}

// Local engines take 16 kHz mono PCM16 WAV as-is; anything else goes through FFmpeg.
function isPcm16Mono16kWav(buffer) {
  const format = parseWavFormat(buffer);
  return (
    format?.audioFormat === 1 &&
    format.channels === 1 &&
    format.sampleRate === 16000 &&
    format.bitsPerSample === 16
  );
}

function wavToFloat32Samples(wavBuffer) {
  if (!isWavFormat(wavBuffer)) {
    throw new Error("Buffer is not a valid WAV file");
  }

  // Parse WAV header to find data chunk
  let offset = 12; // Skip RIFF header (4) + size (4) + WAVE (4)
  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;

  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      bitsPerSample = wavBuffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset < 0) {
    throw new Error("WAV data chunk not found");
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / bytesPerSample);
  const float32 = Buffer.alloc(numSamples * 4);

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample;
    const intVal =
      bitsPerSample === 16 ? wavBuffer.readInt16LE(sampleOffset) : wavBuffer.readInt8(sampleOffset);
    const maxVal = bitsPerSample === 16 ? 32768 : 128;
    float32.writeFloatLE(intVal / maxVal, i * 4);
  }

  return float32;
}

function computeFloat32RMS(float32Buffer) {
  const numSamples = float32Buffer.length / 4;
  if (numSamples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const val = float32Buffer.readFloatLE(i * 4);
    sumSquares += val * val;
  }

  return Math.sqrt(sumSquares / numSamples);
}

module.exports = {
  getFFmpegPath,
  isWavFormat,
  parseWavFormat,
  isPcm16Mono16kWav,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
};
