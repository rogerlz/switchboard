const { app } = require("electron");
const os = require("os");
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Only these subdirs resolve through getCacheRoot(). yt-dlp is read from the
// home cache directly by its manager (and tolerates non-ASCII paths), so it
// must stay put.
const RELOCATED_SUBDIRS = ["whisper-models", "parakeet-models", "diarization-models", "models"];

let migratedRootPair = null;

function rollbackMigration(completedMoves) {
  for (const move of completedMoves.reverse()) {
    try {
      if (!fs.existsSync(move.to)) continue;

      if (move.copied) {
        fs.cpSync(move.to, move.from, { recursive: true });
        fs.rmSync(move.to, { recursive: true, force: true });
      } else if (!fs.existsSync(move.from)) {
        fs.renameSync(move.to, move.from);
      }
    } catch {}
  }
}

function migrateLegacyModelDirs(legacyRoot, targetRoot) {
  const rootPair = `${legacyRoot}\0${targetRoot}`;
  if (migratedRootPair === rootPair) return true;

  const completedMoves = [];
  let staging = null;
  try {
    ensureDir(targetRoot);

    for (const subdir of RELOCATED_SUBDIRS) {
      const from = path.join(legacyRoot, subdir);
      const to = path.join(targetRoot, subdir);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;

      try {
        fs.renameSync(from, to);
        completedMoves.push({ from, to, copied: false });
      } catch {
        // Cross-volume move: copy to a staging dir first so an interrupted
        // copy can never be mistaken for a complete model dir.
        staging = `${to}.migrating`;
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(from, staging, { recursive: true });
        fs.renameSync(staging, to);
        staging = null;
        completedMoves.push({ from, to, copied: true });
      }
    }

    for (const move of completedMoves) {
      if (move.copied) fs.rmSync(move.from, { recursive: true, force: true });
    }

    migratedRootPair = rootPair;
    return true;
  } catch {
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {}
    }
    rollbackMigration(completedMoves);
    return false;
  }
}

function getCacheRoot() {
  const homeDir = app?.getPath?.("home") || os.homedir();
  const homeCache = path.join(homeDir, ".cache", "openwhispr");
  const targetRoot = process.env.OPENWHISPR_CACHE_ROOT || homeCache;

  if (targetRoot === homeCache) return homeCache;
  return migrateLegacyModelDirs(homeCache, targetRoot) ? targetRoot : homeCache;
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = {
  getCacheRoot,
  getModelsDirForService,
};
