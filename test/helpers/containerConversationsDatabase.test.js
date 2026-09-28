const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    const database = new DatabaseManager();
    return database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("container scope migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const columns = db.db.pragma("table_info('agent_conversations')").map((col) => col.name);
  assert.ok(columns.includes("space_id"));
  assert.ok(columns.includes("folder_id"));

  const noteColumns = db.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(noteColumns.includes("updated_by_user_id"));
  assert.ok(
    db.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'optimistic_folder_delete_rows'"
      )
      .get()
  );

  db.db.close();

  const db2 = new DatabaseManager();
  const indexes = db2.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_conversations'"
    )
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_agent_conversations_container"));
  assert.ok(
    db2.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'optimistic_folder_delete_rows'"
      )
      .get()
  );
});

test("searchNotes filters by folder", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = db.getSpace(db.getPrivateSpaceId());
  const folder = db.createFolder("Docs", space.id).folder;

  db.saveNote("Roadmap planning", "quarterly roadmap", "personal", null, null, folder.id, space.id);
  db.saveNote("Roadmap ideas", "more roadmap", "personal", null, null, null, space.id);

  const spaceHits = db.searchNotes("roadmap", 10, space.id);
  assert.equal(spaceHits.length, 2);

  const folderHits = db.searchNotes("roadmap", 10, space.id, folder.id);
  assert.equal(folderHits.length, 1);
  assert.equal(folderHits[0].folder_id, folder.id);
});
