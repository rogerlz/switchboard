const path = require("path");
const { spawn } = require("child_process");
const { TIMEOUTS, killProcess } = require("../utils/process");

const TAR_KILL_GRACE_MS = 1000;

function tarExtractionFlags(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "-xjf";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "-xzf";
  // bsdtar and modern GNU tar auto-detect the format on extraction (zip included).
  return "-xf";
}

function runSystemTar(
  archivePath,
  destDir,
  { timeoutMs = TIMEOUTS.INSTALL, killGraceMs = TAR_KILL_GRACE_MS, spawnImpl = spawn } = {}
) {
  return new Promise((resolve, reject) => {
    const cwd = path.dirname(archivePath);
    const archiveArg = path.basename(archivePath);
    const destArg = path.relative(cwd, destDir) || ".";
    let tarProcess;

    try {
      tarProcess = spawnImpl("tar", [tarExtractionFlags(archivePath), archiveArg, "-C", destArg], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      reject(new Error(`Failed to start tar process: ${err.message}`));
      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killGraceTimer = null;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      callback(value);
    };

    const timeoutError = () => new Error(`tar extraction timed out after ${timeoutMs}ms`);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcess(tarProcess, "SIGKILL");

      // Normally close follows kill immediately. Do not let a broken process
      // implementation turn the safety timeout into another indefinite wait.
      killGraceTimer = setTimeout(() => finish(reject, timeoutError()), killGraceMs);
    }, timeoutMs);

    tarProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    tarProcess.on("close", (code) => {
      if (timedOut) {
        finish(reject, timeoutError());
      } else if (code === 0) {
        finish(resolve);
      } else {
        finish(reject, new Error(`tar extraction failed with code ${code}: ${stderr}`));
      }
    });

    tarProcess.on("error", (err) => {
      finish(reject, new Error(`Failed to start tar process: ${err.message}`));
    });
  });
}

module.exports = { runSystemTar };
