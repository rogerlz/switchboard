const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { findLibrariesInDir } = require("../../scripts/lib/download-utils");
const {
  BINARIES,
  WHISPER_CPP_TAG,
  downloadAllBinaries,
  isCompleteInstall,
} = require("../../scripts/download-whisper-cpp");

test("all-platform mode reports failure after attempting every configured download", async () => {
  const attempts = [];
  const download = async (platformArch) => {
    attempts.push(platformArch);
    return platformArch !== "darwin-x64";
  };

  assert.equal(await downloadAllBinaries({ assets: [] }, false, download), false);
  assert.deepEqual(attempts, Object.keys(BINARIES));
});

test("cached install is complete only for the current tag", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-install-test-"));
  const binaryPath = path.join(tempDir, BINARIES["darwin-arm64"].outputName);
  const markerPath = path.join(tempDir, ".whisper-cpp-darwin-arm64.json");
  fs.writeFileSync(binaryPath, "binary");

  try {
    assert.equal(isCompleteInstall(markerPath, binaryPath), false);
    fs.writeFileSync(markerPath, JSON.stringify({ version: "0.0.9" }));
    assert.equal(isCompleteInstall(markerPath, binaryPath), false);
    fs.writeFileSync(markerPath, JSON.stringify({ version: WHISPER_CPP_TAG }));
    assert.equal(isCompleteInstall(markerPath, binaryPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findLibrariesInDir propagates traversal errors by default", () => {
  const missingDir = path.join(os.tmpdir(), `missing-library-dir-${process.pid}-${Date.now()}`);

  assert.throws(() => findLibrariesInDir(missingDir, "*.dylib"), { code: "ENOENT" });
});

test("findLibrariesInDir supports explicit best-effort traversal", () => {
  const missingDir = path.join(os.tmpdir(), `missing-library-dir-${process.pid}-${Date.now()}`);

  assert.deepEqual(findLibrariesInDir(missingDir, "*.dylib", { ignoreReadErrors: true }), []);
});
