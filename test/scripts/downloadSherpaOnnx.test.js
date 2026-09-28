const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const {
  BINARIES,
  MACOS_ARM64_ONNXRUNTIME,
  SHERPA_ONNX_VERSION,
  findObsoleteLibraries,
  isCompleteInstall,
} = require("../../scripts/download-sherpa-onnx");

test("removes only libraries from the previous sherpa-onnx install", () => {
  const obsolete = findObsoleteLibraries(
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"],
    ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"],
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib", "libllama.dylib"]
  );

  assert.deepEqual(obsolete, ["libonnxruntime.1.27.0.dylib"]);
});

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a malformed marker is not a complete install", (t) => {
  const dir = makeBinDir(t);
  const binary = path.join(dir, "sherpa-onnx-ws-darwin-arm64");
  const marker = path.join(dir, ".sherpa-onnx-darwin-arm64.json");
  fs.writeFileSync(binary, "");
  fs.writeFileSync(marker, JSON.stringify({ version: SHERPA_ONNX_VERSION, libraries: [null] }));

  assert.equal(
    isCompleteInstall(marker, [binary], { platformArch: "darwin-arm64", binDir: dir }),
    false
  );
});

test(
  "a macOS marker written before the arm64 ONNX Runtime slice is not a complete install",
  { skip: process.platform !== "darwin" && "the slice is only replaced on macOS hosts" },
  (t) => {
    const dir = makeBinDir(t);
    const binary = path.join(dir, "sherpa-onnx-ws-darwin-arm64");
    fs.writeFileSync(binary, "");
    const marker = path.join(dir, ".sherpa-onnx-darwin-arm64.json");
    const options = { platformArch: "darwin-arm64", binDir: dir };

    fs.writeFileSync(marker, JSON.stringify({ version: SHERPA_ONNX_VERSION, libraries: [] }));
    assert.equal(isCompleteInstall(marker, [binary], options), false);

    fs.writeFileSync(
      marker,
      JSON.stringify({
        version: SHERPA_ONNX_VERSION,
        libraries: [],
        onnxRuntime: MACOS_ARM64_ONNXRUNTIME.marker,
      })
    );
    assert.equal(isCompleteInstall(marker, [binary], options), true);
  }
);

test("a failed macOS upgrade still removes obsolete libraries when retried", async (t) => {
  const root = makeBinDir(t);
  const binDir = path.join(root, "resources", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const config = BINARIES["darwin-arm64"];
  const binaryPaths = [config.outputName, config.onlineOutputName, config.diarizeOutputName].map(
    (name) => path.join(binDir, name)
  );
  const markerPath = path.join(binDir, ".sherpa-onnx-darwin-arm64.json");
  const obsoleteLibrary = path.join(binDir, "libonnxruntime.1.27.0.dylib");
  fs.writeFileSync(obsoleteLibrary, "old runtime");
  fs.copyFileSync(obsoleteLibrary, path.join(binDir, "libonnxruntime.dylib"));
  fs.writeFileSync(path.join(binDir, "libllama.dylib"), "unrelated runtime");
  for (const binaryPath of binaryPaths) fs.writeFileSync(binaryPath, "old binary");
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      version: "1.13.4",
      libraries: ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib"],
      onnxRuntime: "arm64-1.27.0",
    })
  );

  const sourcePath = require.resolve("../../scripts/download-sherpa-onnx");
  const requireFromDownloader = createRequire(sourcePath);
  let failDownload = true;
  const downloadBinary = vm.runInNewContext(
    `${fs.readFileSync(sourcePath, "utf8")}\ndownloadBinary;`,
    {
      __dirname: path.join(root, "scripts"),
      module: { exports: {} },
      // Stub network and native extraction; marker and library operations use the filesystem.
      process: { ...process, platform: "linux" },
      console,
      require(name) {
        if (name === "./lib/download-utils") {
          return {
            ...requireFromDownloader(name),
            async downloadFile(_url, destination) {
              if (failDownload) throw new Error("simulated download failure");
              fs.writeFileSync(destination, "fixture archive");
            },
          };
        }
        if (name === "child_process") {
          return {
            execFileSync(command, args, { cwd }) {
              assert.equal(command, "tar");
              const extractDir = path.resolve(cwd, args[args.indexOf("-C") + 1]);
              for (const name of [
                config.binaryPath,
                config.onlineBinaryPath,
                config.diarizeBinaryPath,
              ]) {
                fs.writeFileSync(path.join(extractDir, name), "new binary");
              }
              fs.writeFileSync(path.join(extractDir, "libonnxruntime.dylib"), "new runtime");
            },
          };
        }
        return requireFromDownloader(name);
      },
    },
    { filename: sourcePath }
  );

  assert.equal(await downloadBinary("darwin-arm64", config), false);
  assert.equal(await downloadBinary("darwin-arm64", config), false);
  assert.equal(
    isCompleteInstall(markerPath, binaryPaths, { platformArch: "darwin-arm64", binDir }),
    false
  );

  failDownload = false;
  assert.equal(await downloadBinary("darwin-arm64", config), true);
  assert.equal(fs.existsSync(obsoleteLibrary), false);
  assert.equal(fs.readFileSync(path.join(binDir, "libonnxruntime.dylib"), "utf8"), "new runtime");
  assert.equal(fs.readFileSync(path.join(binDir, "libllama.dylib"), "utf8"), "unrelated runtime");
});
