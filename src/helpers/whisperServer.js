const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { isPortAvailable, getAvailableParallelism } = require("../utils/serverUtils");
const { convertToWav, isPcm16Mono16kWav } = require("./ffmpegUtils");
const { createAbortError } = require("./abortError");
const sidecarPidFile = require("./sidecarPidFile");
const { sanitizeWhisperVadConfig, DEFAULT_WHISPER_VAD_CONFIG } = require("./whisperVadConfig");
const {
  computeTranscriptionTimeoutMs,
  PCM16_MONO_16K_BYTES_PER_SECOND,
} = require("./transcriptionTimeout");

const PORT_RANGE_START = 8178;
const PORT_RANGE_END = 8199;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_WHISPER_THREADS = 4;
const MAX_AUTO_WHISPER_THREADS = 12;
const MAX_MANUAL_WHISPER_THREADS = 64;
const AUTO_THREAD_RATIO = 0.75;
// Decoder anti-hallucination thresholds sent with /inference requests. whisper.cpp's
// defaults (entropy 2.4, logprob -1.0) let a mostly-silent 30s decode window pass the
// repetition check and emit training-data outro boilerplate ("Thank you for watching",
// "Продолжение следует..."). These values cut the hallucinated-tail rate from 2.25% to
// 0.06% over 4,814 real dictations. See #1458. The raised entropy also sends more
// windows into whisper.cpp's temperature-fallback loop (re-decoding a window up to
// ~6x), which a continuous load cannot afford: meeting chunks pass
// skipDecoderThresholds to keep the server defaults — they already have RMS-gate,
// VAD, and holdback/dedup hallucination protection.
const INFERENCE_DECODER_FIELDS = Object.freeze({
  entropy_thold: "2.8",
  logprob_thold: "-1.25",
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parsePositiveInteger(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return parsed > 0 ? parsed : null;
}

function createThreadResolution(threads, source, availableParallelism) {
  return { threads, source, availableParallelism };
}

function resolveWhisperThreads(options = {}, runtime = {}) {
  const availableParallelism =
    parsePositiveInteger(runtime.availableParallelism) || getAvailableParallelism();

  const explicitThreads = parsePositiveInteger(options.threads);
  if (explicitThreads) {
    return createThreadResolution(
      clamp(explicitThreads, 1, MAX_MANUAL_WHISPER_THREADS),
      "options",
      availableParallelism
    );
  }

  const env = runtime.env || process.env;
  const envThreads = env.WHISPER_THREADS;
  const shouldAutoTune = !envThreads || String(envThreads).trim().toLowerCase() === "auto";

  if (!shouldAutoTune) {
    const parsedEnvThreads = parsePositiveInteger(envThreads);
    if (parsedEnvThreads) {
      return createThreadResolution(
        clamp(parsedEnvThreads, 1, MAX_MANUAL_WHISPER_THREADS),
        "env",
        availableParallelism
      );
    }
  }

  const autoThreads = clamp(
    Math.floor(availableParallelism * AUTO_THREAD_RATIO),
    DEFAULT_WHISPER_THREADS,
    MAX_AUTO_WHISPER_THREADS
  );

  if (autoThreads <= DEFAULT_WHISPER_THREADS) {
    return createThreadResolution(
      null,
      shouldAutoTune ? "default" : "invalid-env",
      availableParallelism
    );
  }

  return createThreadResolution(
    autoThreads,
    shouldAutoTune ? "auto" : "invalid-env-auto",
    availableParallelism
  );
}

function shouldFallbackToDefaultThreads(resolution) {
  return (
    resolution.threads && (resolution.source === "auto" || resolution.source === "invalid-env-auto")
  );
}

function getThreadSignature(resolution) {
  return `threads:${resolution.threads || "default"}`;
}

function isVadActive(options = {}) {
  return options.vadEnabled === true && !!options.vadModelPath;
}

function getVadSignature(options = {}) {
  if (!isVadActive(options)) return "vad:off";
  const vadConfig = sanitizeWhisperVadConfig(options.vadConfig || DEFAULT_WHISPER_VAD_CONFIG);
  return `vad:on:${options.vadModelPath}:${JSON.stringify(vadConfig)}`;
}

function buildWhisperServerArgs({
  modelPath,
  port,
  language,
  threads,
  vadEnabled = false,
  vadModelPath = null,
  vadConfig,
}) {
  const args = ["--model", modelPath, "--host", "127.0.0.1", "--port", String(port)];

  if (threads) args.push("--threads", String(threads));

  // whisper.cpp defaults to English when --language is omitted;
  // explicitly pass "auto" to enable language auto-detection
  args.push("--language", language || "auto");

  // whisper.cpp v1.9.x turned token timestamps on for every request and forces max_len=60
  // when it is unset, so the server wraps segments at 60 characters. split_on_word is off,
  // so the wrap lands on a token boundary and breaks words mid-word ("abschalten" -> "abs" +
  // "chalten"); we join segments into one string, so the break surfaces as a stray space.
  // See #1348.
  //
  // Raise max_len to switch the wrap off rather than passing --no-timestamps, which took the
  // decoder's timestamp tokens with it: without them whisper.cpp advances `seek` a full 30s
  // window no matter where the decode actually stopped, silently discarding the audio in
  // between. See #2150. A segment covers at most one 30s window; the longest measured is
  // 186 characters.
  args.push("--max-len", "4096");

  if (isVadActive({ vadEnabled, vadModelPath })) {
    const cfg = sanitizeWhisperVadConfig(vadConfig || DEFAULT_WHISPER_VAD_CONFIG);
    args.push(
      "--vad",
      "--vad-model",
      vadModelPath,
      "--vad-threshold",
      String(cfg.threshold),
      "--vad-min-speech-duration-ms",
      String(cfg.minSpeechDurationMs),
      "--vad-min-silence-duration-ms",
      String(cfg.minSilenceDurationMs),
      "--vad-max-speech-duration-s",
      String(cfg.maxSpeechDurationS),
      "--vad-speech-pad-ms",
      String(cfg.speechPadMs),
      "--vad-samples-overlap",
      String(cfg.samplesOverlap)
    );
  }

  return args;
}

function shouldRetryAfterServerReplaced({ isConnectionError, stopRequested, ready, sameModel }) {
  // A concurrent caller already restarted the server; retry only if it is up
  // and still serving the same model (a model switch must not answer for it).
  return !!isConnectionError && !stopRequested && !!ready && !!sameModel;
}

class WhisperServerManager {
  constructor() {
    this.process = null;
    this.hostname = "127.0.0.1";
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedServerBinaryPath = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;
    this.startGeneration = 0;
    this._stopRequested = false;
    this.vadSignature = "vad:off";
    this.threadSignature = "threads:default";
  }

  getFFmpegPath() {
    if (this.cachedFFmpegPath) return this.cachedFFmpegPath;

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
        this.cachedFFmpegPath = unpackedPath;
        return unpackedPath;
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
        this.cachedFFmpegPath = ffmpegPath;
        return ffmpegPath;
      }
    } catch (err) {
      debugLogger.debug("Bundled FFmpeg not available", { error: err.message });
    }

    const pathDirs = (process.env.PATH || "").split(":");
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", ...pathDirs]) {
      if (!dir) continue;
      const candidate = path.join(dir, "ffmpeg");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      this.cachedFFmpegPath = candidate;
      return candidate;
    }

    debugLogger.debug("FFmpeg not found");
    return null;
  }

  getServerBinaryPath() {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    const binaryName = `whisper-server-${process.platform}-${process.arch}`;
    const genericName = "whisper-server";

    const candidates = [];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "bin", genericName)
      );
    }

    candidates.push(
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", "bin", genericName)
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          fs.statSync(candidate);
          this.cachedServerBinaryPath = candidate;
          return candidate;
        } catch {
          // Can't access binary
        }
      }
    }

    return null;
  }

  isAvailable() {
    return this.getServerBinaryPath() !== null;
  }

  async findAvailablePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    const threadResolution = resolveWhisperThreads(options);
    const nextThreadSignature = getThreadSignature(threadResolution);
    const nextVadSignature = getVadSignature(options);
    if (
      this.ready &&
      this.modelPath === modelPath &&
      this.vadSignature === nextVadSignature &&
      this.threadSignature === nextThreadSignature
    ) {
      return;
    }

    if (this.process) {
      await this.stop();
    }

    this.vadSignature = nextVadSignature;
    this.threadSignature = nextThreadSignature;
    this.startupPromise = this._doStart(modelPath, { ...options, threadResolution });
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    this.startGeneration += 1;
    this._stopRequested = false;
    const threadResolution = options.threadResolution || resolveWhisperThreads(options);
    const serverBinary = this.getServerBinaryPath();
    if (!serverBinary) throw new Error("whisper-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;

    const ffmpegPath = this.getFFmpegPath();
    const spawnEnv = { ...process.env };

    // Add the whisper-server directory to PATH so any companion libraries are found
    const serverBinaryDir = path.dirname(serverBinary);
    spawnEnv.PATH = serverBinaryDir + ":" + (process.env.PATH || "");

    const args = buildWhisperServerArgs({
      modelPath,
      port: this.port,
      language: options.language,
      threads: threadResolution.threads,
      vadEnabled: options.vadEnabled === true,
      vadModelPath: options.vadModelPath || null,
      vadConfig: options.vadConfig,
    });

    // FFmpeg is required for pre-converting audio to 16kHz mono WAV
    this.canConvert = !!ffmpegPath;
    if (ffmpegPath) {
      const ffmpegDir = path.dirname(ffmpegPath);
      spawnEnv.PATH = ffmpegDir + ":" + spawnEnv.PATH;
    } else {
      debugLogger.warn("FFmpeg not found - whisper-server will only accept 16kHz mono WAV");
    }

    debugLogger.debug("Starting whisper-server", {
      port: this.port,
      modelPath,
      args,
      cwd: serverBinaryDir,
      threads: threadResolution,
    });

    this.process = spawn(serverBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
      cwd: serverBinaryDir,
      detached: true,
    });
    sidecarPidFile.write("whisper", this.process.pid);

    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("whisper-server stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("whisper-server stderr", { data: data.toString().trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("whisper-server process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      sidecarPidFile.clear("whisper");
    });

    try {
      await this.waitForReady(() => ({ stderr: stderrBuffer, exitCode }));
    } catch (err) {
      // An intentional stop() during startup is not a thread failure
      if (err.isStopped) throw err;
      if (shouldFallbackToDefaultThreads(threadResolution)) {
        const defaultThreadResolution = createThreadResolution(
          null,
          "auto-fallback",
          threadResolution.availableParallelism
        );
        debugLogger.warn("Auto whisper thread count failed, falling back to default", {
          selectedThreads: threadResolution.threads,
          availableParallelism: threadResolution.availableParallelism,
          stderr: stderrBuffer.slice(0, 200),
        });
        await this.stop();
        this.threadSignature = getThreadSignature(threadResolution);
        return this._doStart(modelPath, {
          ...options,
          threadResolution: defaultThreadResolution,
        });
      }
      throw err;
    }

    this.startHealthCheck();

    debugLogger.info("whisper-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      threads: threadResolution.threads || DEFAULT_WHISPER_THREADS,
      threadSource: threadResolution.source,
      availableParallelism: threadResolution.availableParallelism,
    });
  }

  async waitForReady(getProcessInfo, timeoutMs = STARTUP_TIMEOUT_MS) {
    const startTime = Date.now();
    let pollCount = 0;

    // Poll every 100ms during startup (faster than ongoing health checks at 5000ms)
    // This saves 0-400ms average vs 500ms polling
    const STARTUP_POLL_INTERVAL_MS = 100;

    while (Date.now() - startTime < timeoutMs) {
      if (this._stopRequested) {
        throw Object.assign(new Error("whisper-server startup interrupted by stop"), {
          isStopped: true,
        });
      }
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(
          `whisper-server process died during startup${details ? `: ${details}` : ""}`
        );
      }

      pollCount++;
      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("whisper-server ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`whisper-server failed to start within ${timeoutMs}ms`);
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          path: "/",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (!(await this.checkHealth())) {
        debugLogger.warn("whisper-server health check failed");
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("whisper-server is not running");
    }

    // Debug: Log audio buffer info
    debugLogger.debug("whisper-server transcribe called", {
      bufferLength: audioBuffer?.length || 0,
      bufferType: audioBuffer?.constructor?.name,
      firstBytes:
        audioBuffer?.length >= 16
          ? Array.from(audioBuffer.slice(0, 16))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
          : "too short",
    });

    // signal is optional; only cancellable uploads pass one.
    const { language, initialPrompt, signal, skipDecoderThresholds } = options;
    if (signal?.aborted) throw createAbortError("whisper-server transcription cancelled");

    // whisper.cpp wants 16 kHz mono PCM16; a renderer PCM tap delivers exactly that.
    let finalBuffer = audioBuffer;
    if (!isPcm16Mono16kWav(audioBuffer)) {
      if (!this.canConvert) {
        throw new Error("FFmpeg not found - required for audio conversion");
      }
      finalBuffer = await this._convertToWav(audioBuffer);
    }

    const boundary = `----WhisperBoundary${Date.now()}`;
    const parts = [];
    const fileName = "audio.wav";
    const contentType = "audio/wav";

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    parts.push(finalBuffer);
    parts.push("\r\n");

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language || "auto"}\r\n`
    );

    if (!skipDecoderThresholds) {
      for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
        parts.push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${value}\r\n`
        );
      }
    }

    // Add initial prompt for custom dictionary words
    if (initialPrompt) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `${initialPrompt}\r\n`
      );
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
    );
    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part));
    const body = Buffer.concat(bodyParts);

    const generation = this.startGeneration;
    const modelPath = this.modelPath;

    try {
      return await this._postInference(body, boundary, signal);
    } catch (err) {
      // A cancel is not a server failure: rethrow before the retry logic so it
      // never triggers a server restart.
      if (err?.name === "AbortError") throw err;
      return await this._retryAfterRequestFailure(err, body, boundary, generation, modelPath);
    }
  }

  _postInference(body, boundary, signal) {
    // Multipart boilerplate adds under a kilobyte, so body length tracks audio length.
    const timeoutMs = computeTranscriptionTimeoutMs(body.length / PCM16_MONO_16K_BYTES_PER_SECOND);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("whisper-server request cancelled"));
        return;
      }

      const startTime = Date.now();

      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            removeAbortListener();
            debugLogger.debug("whisper-server transcription completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
              responseLength: data.length,
              responsePreview: data.slice(0, 500),
            });

            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse whisper-server response: ${e.message}`));
            }
          });
        }
      );

      // whisper-server has no mid-inference cancellation: destroying the
      // request frees this pipeline immediately, but the server finishes its
      // in-flight decode on its own.
      const onAbort = () => {
        req.destroy();
        reject(createAbortError("whisper-server request cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);

      req.on("error", (error) => {
        removeAbortListener();
        const err = new Error(`whisper-server request failed: ${error.message}`);
        err.isConnectionError = true;
        err.code = error.code;
        reject(err);
      });
      req.on("timeout", () => {
        removeAbortListener();
        req.destroy();
        reject(new Error("whisper-server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async _retryAfterRequestFailure(err, body, boundary, generation, modelPath) {
    if (!err?.isConnectionError || this._stopRequested || this.startGeneration === generation) {
      throw err;
    }

    // Another start already replaced the server (model or VAD reload): retry
    // only against a ready server holding the same model.
    const pending = this.startupPromise;
    if (pending) await pending.catch(() => {});
    if (
      !shouldRetryAfterServerReplaced({
        isConnectionError: true,
        stopRequested: this._stopRequested,
        ready: this.ready,
        sameModel: this.modelPath === modelPath,
      })
    ) {
      throw err;
    }
    return await this._postInference(body, boundary);
  }

  async _convertToWav(audioBuffer) {
    const tempDir = require("os").tmpdir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `whisper-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `whisper-output-${timestamp}.wav`);

    try {
      fs.writeFileSync(tempInputPath, audioBuffer);
      await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });
      return fs.readFileSync(tempWavPath);
    } finally {
      for (const f of [tempInputPath, tempWavPath]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  async stop() {
    this._stopRequested = true;
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping whisper-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping whisper-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
  }
}

module.exports = WhisperServerManager;
module.exports.buildWhisperServerArgs = buildWhisperServerArgs;
module.exports.INFERENCE_DECODER_FIELDS = INFERENCE_DECODER_FIELDS;
module.exports.getVadSignature = getVadSignature;
module.exports.resolveWhisperThreads = resolveWhisperThreads;
module.exports.shouldRetryAfterServerReplaced = shouldRetryAfterServerReplaced;
