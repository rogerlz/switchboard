const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const debugLogger = require("./debugLogger");
const { buildNoteSearchQuery } = require("./noteSearch");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { parseEventTime } = require("./calendarAvailability");
const { app } = require("electron");

// An optimistically deleted folder still holds its server-side name until the
// DELETE is confirmed, so it must keep blocking reuse of that name.
const FOLDER_NAME_TAKEN_FILTER = `(deleted_at IS NULL OR EXISTS (
  SELECT 1 FROM optimistic_folder_delete_rows r
  WHERE r.folder_id = folders.id AND r.entity_type = 'folder'
))`;

// A meeting synced by both a REST provider (Google/Microsoft) and Apple
// (Calendar.app mirrors the same accounts) would double-fire reminders and
// duplicate UI rows; suppress the Apple copy when a REST row occupies the same
// time slot + title (REST rows have richer conference data). datetime()
// normalizes the providers' timestamp formats (Google stores offset-form
// RFC3339, Apple/Microsoft store UTC "Z" form). REST rows are never collapsed
// — Google and Microsoft are never mirrors of each other.
function dedupedEventsQuery(where) {
  return `SELECT * FROM (
    SELECT *, MAX(provider != 'apple') OVER (
      PARTITION BY datetime(start_time), datetime(end_time), COALESCE(summary, '')
    ) AS has_synced
    FROM calendar_events
    WHERE ${where}
  ) WHERE provider != 'apple' OR has_synced = 0 ORDER BY datetime(start_time) ASC`;
}

function stripDedupeColumn({ has_synced: _hasSynced, ...event }) {
  return event;
}

// Whitelist for provider-scoped SQL against the per-provider calendars tables.
const CALENDARS_TABLE_BY_PROVIDER = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};

const AVAILABILITY_PROVIDERS = new Set(["google", "microsoft", "apple"]);
const SELECTED_CALENDAR_EVENT_FILTER = `(
  (provider = 'google' AND EXISTS (
    SELECT 1 FROM google_calendars WHERE google_calendars.id = calendar_events.calendar_id
      AND google_calendars.is_selected = 1
  )) OR
  (provider = 'microsoft' AND EXISTS (
    SELECT 1 FROM microsoft_calendars WHERE microsoft_calendars.id = calendar_events.calendar_id
      AND microsoft_calendars.is_selected = 1
  )) OR
  (provider = 'apple' AND EXISTS (
    SELECT 1 FROM apple_calendars WHERE apple_calendars.id = calendar_events.calendar_id
  ))
)`;

// Rows the signed-out local user owns: no account and a private space. Rows
// from a former signed-in session (account-owned or team spaces) stay hidden.
const localScope = (tableName) => `(${tableName}.account_id IS NULL AND EXISTS (
  SELECT 1 FROM spaces local_scope_space
  WHERE local_scope_space.id = ${tableName}.space_id
    AND local_scope_space.kind = 'private'
))`;

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  _getLocalFolder(id) {
    const accountScope = localScope("folders");
    return (
      this.db.prepare(`SELECT * FROM folders WHERE id = ? AND ${accountScope}`).get(id) || null
    );
  }

  // Child notes owned by another local account are invisible to the active
  // scope, so a folder removal must release them to the space root — never
  // delete them (or their conversations, speaker rows, or cloud tombstones)
  // with the folder. Run this before any statement that targets the folder's
  // children, so plain `folder_id = ?` filters only ever see in-scope rows.
  _releaseOutOfScopeChildNotes(folderId) {
    const accountScope = localScope("notes");
    const outOfScopeIds = this.db
      .prepare(
        `SELECT id FROM notes
         WHERE folder_id = ? AND id NOT IN (
           SELECT id FROM notes WHERE folder_id = ? AND ${accountScope}
         )`
      )
      .all(folderId, folderId)
      .map((row) => row.id);
    if (outOfScopeIds.length === 0) return [];
    const placeholders = outOfScopeIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE notes
         SET folder_id = NULL, sync_status = 'pending', updated_at = datetime('now')
         WHERE id IN (${placeholders})`
      )
      .run(...outOfScopeIds);
    return this.db
      .prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .all(...outOfScopeIds);
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Audio retention columns
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN raw_text TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN audio_duration_ms INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN provider TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN model TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE transcriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_message TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_code TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Records the dictation intent (e.g. "translation") so retry/recover re-runs the same route.
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN route_kind TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL,
          replacement TEXT NOT NULL,
          client_snippet_id TEXT,
          cloud_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_content TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_prompt TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_at_content_hash TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          content,
          enhanced_content,
          content='notes',
          content_rowid='id'
        )
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END
      `);

      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO notes_fts(rowid, title, content, enhanced_content)
        SELECT id, COALESCE(title, ''), COALESCE(content, ''), COALESCE(enhanced_content, '')
        FROM notes
      `
        )
        .run();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const folderCount = this.db.prepare("SELECT COUNT(*) as count FROM folders").get();
      if (folderCount.count === 0) {
        const seedFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order) VALUES (?, 1, ?)"
        );
        seedFolder.run("Personal", 0);
        seedFolder.run("Meetings", 1);
        seedFolder.run("Videos", 2);
      }

      // Backfill folder_id only when the column is first added: on later
      // launches a NULL folder_id is a legitimate space-root note, not a
      // pre-folders row.
      let folderColumnAdded = true;
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
        folderColumnAdded = false;
      }

      if (folderColumnAdded) {
        const personalFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
          .get();
        if (personalFolder) {
          this.db
            .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
            .run(personalFolder.id);
        }
      }

      // One-time seed (user_version 1): a pre-existing user-created "Videos"
      // folder stays untouched (never promoted to default); URL downloads route
      // to it by name. Guarded so a later delete/rename doesn't resurrect it as
      // an undeletable default on the next launch.
      if (this.db.pragma("user_version", { simple: true }) < 1) {
        const videosFolder = this.db.prepare("SELECT id FROM folders WHERE name = 'Videos'").get();
        if (!videosFolder) {
          const maxOrder = this.db.prepare("SELECT MAX(sort_order) as m FROM folders").get();
          this.db
            .prepare(
              "INSERT OR IGNORE INTO folders (name, is_default, sort_order) VALUES ('Videos', 1, ?)"
            )
            .run((maxOrder?.m ?? 1) + 1);
        }
        this.db.pragma("user_version = 1");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE actions ADD COLUMN translation_key TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)"
      );

      try {
        this.db.exec("ALTER TABLE agent_messages ADD COLUMN metadata TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at DATETIME");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN note_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_note ON agent_conversations(note_id)"
      );
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN folder_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_container ON agent_conversations(space_id, folder_id)"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Migration: add UNIQUE constraint to google_email if table already existed without it
      try {
        const tableInfo = this.db.pragma("index_list('google_calendar_tokens')");
        const hasUniqueEmail = tableInfo.some((idx) => {
          if (!idx.unique) return false;
          const cols = this.db.pragma(`index_info('${idx.name}')`);
          return cols.length === 1 && cols[0].name === "google_email";
        });
        if (!hasUniqueEmail) {
          this.db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_tokens_email ON google_calendar_tokens(google_email)"
          );
        }
      } catch (err) {
        debugLogger.error(
          "Migration: google_email unique index",
          { error: err.message },
          "database"
        );
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          description TEXT,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN account_email TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN sync_token_expires_at INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec(
          "ALTER TABLE google_calendars ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          microsoft_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // One-time reset (user_version 2): pre-fix builds stored recurring
      // occurrences untitled when the series-master fetch failed, and delta
      // never re-delivers them; a forced full sync re-fetches them fixed.
      if (this.db.pragma("user_version", { simple: true }) < 2) {
        this.db.exec(
          "UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL"
        );
        this.db.pragma("user_version = 2");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          summary TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'confirmed',
          availability_status TEXT NOT NULL DEFAULT 'unknown',
          self_response_status TEXT NOT NULL DEFAULT 'unknown',
          hangout_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER DEFAULT 0,
          synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec(
          "ALTER TABLE calendar_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      let availabilitySchemaChanged = false;
      for (const column of ["availability_status", "self_response_status"]) {
        try {
          this.db.exec(
            `ALTER TABLE calendar_events ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unknown'`
          );
          availabilitySchemaChanged = true;
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      if (availabilitySchemaChanged) {
        // Existing incremental tokens will not resend unchanged free/declined
        // events, so rebuild both REST caches once with the new semantics.
        this.db
          .prepare("UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL")
          .run();
        this.db
          .prepare("UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL")
          .run();
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS apple_calendars (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT,
          source_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN transcript TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN calendar_event_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN attendees TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN participants TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN diarization_enabled INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN expected_speaker_count INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          sample_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_mappings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER,
          display_name TEXT NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (profile_id) REFERENCES speaker_profiles(id) ON DELETE SET NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_speaker_embeddings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);

      // A cloud folder delete is optimistic until the API answers. Keep the
      // exact pre-delete row state in a durable journal so a permission denial
      // can revive the same folder, notes, speakers, and conversations even
      // after an app restart. Content stays in its owning tables; the journal
      // contains only identity and sync metadata.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS optimistic_folder_delete_rows (
          folder_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          original_sync_status TEXT,
          original_deleted_at TEXT,
          original_updated_at TEXT,
          PRIMARY KEY (folder_id, entity_type, entity_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_optimistic_folder_delete_entity ON optimistic_folder_delete_rows(entity_type, entity_id)"
      );

      // Sync columns for notes
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN client_note_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN share_token TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for folders
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN client_folder_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN updated_at DATETIME");
        this.db.exec("UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for agent_conversations
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN client_conversation_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE agent_conversations ADD COLUMN sync_status TEXT DEFAULT 'pending'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for transcriptions
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN client_transcription_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for custom_dictionary
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN client_dict_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN updated_at DATETIME");
        this.db.exec(
          "UPDATE custom_dictionary SET updated_at = created_at WHERE updated_at IS NULL"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Backfill client IDs for existing rows
      const syncTables = [
        { table: "notes", col: "client_note_id" },
        { table: "folders", col: "client_folder_id" },
        { table: "agent_conversations", col: "client_conversation_id" },
        { table: "transcriptions", col: "client_transcription_id" },
        { table: "custom_dictionary", col: "client_dict_id" },
        { table: "snippets", col: "client_snippet_id" },
      ];
      for (const { table, col } of syncTables) {
        const rows = this.db.prepare(`SELECT id FROM ${table} WHERE ${col} IS NULL`).all();
        const stmt = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
        for (const row of rows) {
          stmt.run(randomUUID(), row.id);
        }
      }

      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_note_id ON notes(client_note_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_client_id ON agent_conversations(client_conversation_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_client_id ON transcriptions(client_transcription_id)"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          event_id TEXT PRIMARY KEY,
          account_id TEXT,
          occurred_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          word_count INTEGER NOT NULL CHECK (word_count > 0),
          spoken_duration_ms INTEGER,
          mode TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          counter_version INTEGER NOT NULL DEFAULT 1,
          sync_status TEXT NOT NULL DEFAULT 'pending',
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_account_date
          ON analytics_events(account_id, local_date);
        CREATE TABLE IF NOT EXISTS analytics_clear_requests (
          account_id TEXT PRIMARY KEY,
          cleared_through TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS analytics_device_clear_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cleared_through TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS analytics_history_backfill_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          scanned_through_transcription_id INTEGER NOT NULL DEFAULT 0
            CHECK (scanned_through_transcription_id >= 0)
        );
      `);
      // Repair databases created before analytics deletion tombstones were
      // introduced. SQLite has no ADD COLUMN IF NOT EXISTS syntax.
      try {
        this.db.exec("ALTER TABLE analytics_events ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_client_id ON custom_dictionary(client_dict_id)"
      );
      // Cloud batch-create matches responses by client_dict_id, so a row
      // without one can never be marked synced and re-uploads every pass. Rows
      // written straight to SQLite don't set it (#1295), so the schema does.
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS custom_dictionary_client_id_default
        AFTER INSERT ON custom_dictionary
        WHEN new.client_dict_id IS NULL
        BEGIN
          UPDATE custom_dictionary SET client_dict_id =
            lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
            substr(lower(hex(randomblob(2))), 2) || '-' ||
            substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) ||
            '-' || lower(hex(randomblob(6)))
          WHERE id = new.id;
        END
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_client_id ON snippets(client_snippet_id) WHERE client_snippet_id IS NOT NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower_active ON snippets(lower(trigger)) WHERE deleted_at IS NULL"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_snippets_pending_sync ON snippets(sync_status) WHERE sync_status = 'pending'"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS spaces (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          client_space_id TEXT,
          cloud_team_id   TEXT,
          workspace_id    TEXT,
          kind            TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('private','team')),
          name            TEXT NOT NULL,
          emoji           TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          my_role         TEXT,
          member_count    INTEGER,
          sync_status     TEXT NOT NULL DEFAULT 'pending',
          deleted_at      TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_client_space_id ON spaces(client_space_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_team_id ON spaces(cloud_team_id) WHERE cloud_team_id IS NOT NULL"
      );

      // First-class spaces: a space mirrors a cloud space with one or more
      // assigned teams. cloud_team_id survives only so pre-spaces rows can be
      // adopted by upsertSpaceFromCloud (matched via the space's single
      // backfilled team).
      try {
        this.db.exec("ALTER TABLE spaces ADD COLUMN cloud_space_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // JSON array of { id, name, my_role } mirrored from GET /api/me/spaces.
        this.db.exec("ALTER TABLE spaces ADD COLUMN teams TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // Direct space_members grant ('admin' | 'member'), distinct from the
        // effective my_role: it decides whether the user can leave the space.
        this.db.exec("ALTER TABLE spaces ADD COLUMN my_direct_role TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_space_id ON spaces(cloud_space_id) WHERE cloud_space_id IS NOT NULL"
      );

      const privateSpaceCount = this.db
        .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
        .get();
      if (privateSpaceCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status) VALUES (?, 'private', 'Personal', 0, 'synced')"
          )
          .run(randomUUID());
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Rebuild folders to drop the table-level UNIQUE(name); per-space name
      // uniqueness is enforced by idx_folders_space_name below.
      // better-sqlite3 enables foreign_keys by default, so DROP TABLE folders
      // would fail while notes.folder_id rows reference it; the pragma is a
      // no-op inside a transaction, so toggle it around the rebuild.
      const foldersTable = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get();
      if (foldersTable?.sql.includes("UNIQUE")) {
        const foreignKeysWereOn = this.db.pragma("foreign_keys", { simple: true }) === 1;
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(`
            CREATE TABLE folders_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              client_folder_id TEXT,
              cloud_id TEXT,
              sync_status TEXT DEFAULT 'pending',
              deleted_at TEXT,
              space_id INTEGER
            )
          `);
            this.db.exec(`
            INSERT INTO folders_new (id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id)
            SELECT id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id
            FROM folders
          `);
            this.db.exec("DROP TABLE folders");
            this.db.exec("ALTER TABLE folders_new RENAME TO folders");
            this.db.exec(
              "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
            );
          })();
        } finally {
          if (foreignKeysWereOn) this.db.pragma("foreign_keys = ON");
        }
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_name ON folders(space_id, name) WHERE deleted_at IS NULL"
      );

      const privateSpace = this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get();
      this.db
        .prepare("UPDATE folders SET space_id = ? WHERE space_id IS NULL")
        .run(privateSpace.id);
      this.db.prepare("UPDATE notes SET space_id = ? WHERE space_id IS NULL").run(privateSpace.id);

      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_space_updated ON notes(space_id, updated_at)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_folders_space_sort ON folders(space_id, sort_order)"
      );

      // Account attribution is intentionally nullable. Existing rows remain
      // device-owned legacy content; workspace rows are never attributed to a
      // personal account and therefore cannot be erased with that account.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_account_id ON notes(account_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_folders_account_id ON folders(account_id)");
      this.db.exec("DROP INDEX IF EXISTS idx_folders_space_name");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_legacy_name ON folders(space_id, name) WHERE deleted_at IS NULL AND account_id IS NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_account_name ON folders(space_id, account_id, name) WHERE deleted_at IS NULL AND account_id IS NOT NULL"
      );

      // A cloud space is workspace-owned, while visibility is account-specific.
      // Keep the many-to-many membership separate so signing out one local
      // account cannot delete or expose another account's workspace cache.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS space_accounts (
          space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (space_id, account_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_space_accounts_account_id ON space_accounts(account_id)"
      );

      // Cloud-backed rows that just LEFT a team must keep pushing their scope
      // retraction (D6) even in the backup-off team-only pass, where the
      // pending queues otherwise filter on the row's CURRENT space kind.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Last cloud editor (CloudNote.updated_by_user_id); only populated on
      // cloud pull — local edits don't set it. Resolved to a display name via
      // the team roster when rendering note authorship.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN updated_by_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Server updated_at this device last acked (push response or pull),
      // echoed verbatim as base_updated_at on the next PATCH so the server can
      // 409 a stale overwrite. Local edits never touch it; NULL means the note
      // predates the guard and pushes last-write-wins once.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_updated_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // The note's owner (CloudNote.user_id) — who created it, not who last
      // edited it (updated_by_user_id). Drives the client-side delete/scope
      // permission checks; NULL until a cloud pull or push response fills it.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN owner_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN created_by_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Space vector purges owed to Qdrant while the sidecar was down/booting;
      // drained on the next semantic search activation.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_purges (
          space_id   INTEGER PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this._initVectorChangeJournal();

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null,
    spaceId = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (folderId) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getLocalFolder(folderId);
        if (!folder) throw new Error("Folder not found in the active account scope");
        spaceId = folder.space_id;
      } else {
        if (spaceId == null) spaceId = this.getPrivateSpaceId();
        if (!this.getSpace(spaceId)) throw new Error("Space not found in the active account scope");
        const defaultFolderName = noteType === "meeting" ? "Meetings" : "Personal";
        const folderScope = localScope("folders");
        const defaultFolder = this.db
          .prepare(
            `SELECT id FROM folders
             WHERE name = ? AND is_default = 1 AND space_id = ? AND ${folderScope}`
          )
          .get(defaultFolderName, spaceId);
        folderId = defaultFolder?.id || null;
      }
      const clientNoteId = randomUUID();
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, space_id, client_note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
        clientNoteId
      );

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  /**
   * Bulk-insert externally imported notes (e.g. a Granola CSV export).
   * Unlike saveNote, rows carry their own client_note_id and original
   * created_at/updated_at; the UNIQUE client_note_id index makes re-imports
   * idempotent (duplicates are skipped, never overwritten).
   */
  importNotes(rows, { noteType = "meeting", folderName = "Imported" } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const spaceId = this.getPrivateSpaceId();

      let folderId = null;
      try {
        const folderScope = localScope("folders");
        const existing = this.db
          .prepare(
            `SELECT id FROM folders
             WHERE name = ? AND space_id = ? AND deleted_at IS NULL AND ${folderScope}`
          )
          .get(folderName, spaceId);
        folderId = existing?.id ?? this.createFolder(folderName, spaceId)?.folder?.id ?? null;
      } catch (folderError) {
        debugLogger.error(
          "Import folder resolution failed; importing without a folder",
          { error: folderError.message },
          "notes"
        );
      }

      const insert = this.db.prepare(`
        INSERT INTO notes (client_note_id, title, content, note_type, source_file,
          folder_id, space_id, transcript, participants, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
          COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
        ON CONFLICT(client_note_id) DO NOTHING
      `);

      let imported = 0;
      let skipped = 0;
      const noteIds = [];
      const errors = [];
      this.db.transaction(() => {
        for (const row of rows) {
          try {
            const result = insert.run(
              row.clientNoteId,
              row.title,
              row.content,
              noteType,
              row.sourceFile,
              folderId,
              spaceId,
              row.transcript,
              row.participants,
              row.createdAt,
              row.createdAt
            );
            if (result.changes === 1) {
              imported++;
              noteIds.push(Number(result.lastInsertRowid));
            } else {
              skipped++;
            }
          } catch (rowError) {
            errors.push({ clientNoteId: row.clientNoteId, error: rowError.message });
          }
        }
      })();

      return { success: true, imported, skipped, folderId, noteIds, errors };
    } catch (error) {
      debugLogger.error("Error importing notes", { error: error.message }, "notes");
      throw error;
    }
  }

  getExistingClientNoteIds(clientNoteIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const existing = [];
      for (let i = 0; i < clientNoteIds.length; i += 500) {
        const chunk = clientNoteIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const found = this.db
          .prepare(`SELECT client_note_id FROM notes WHERE client_note_id IN (${placeholders})`)
          .all(...chunk);
        existing.push(...found.map((row) => row.client_note_id));
      }
      return existing;
    } catch (error) {
      debugLogger.error("Error checking client note ids", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const accountScope = localScope("notes");
      const stmt = this.db.prepare(`SELECT * FROM notes WHERE id = ? AND ${accountScope}`);
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null, spaceId = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      const accountScope = localScope("notes");
      conditions.push(accountScope);
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      } else if (spaceId != null) {
        // spaceId without folderId lists a space's root: folderless notes only.
        conditions.push("folder_id IS NULL");
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const stmt = this.db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ?`);
      params.push(limit);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting notes", { error: error.message }, "notes");
      throw error;
    }
  }

  // Unlike getNotes(null, limit, null, spaceId) — which is root-only — this
  // lists every note in the space, foldered or not (space overview list).
  getNotesForSpace(spaceId, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = localScope("notes");
      return this.db
        .prepare(
          `SELECT * FROM notes
           WHERE space_id = ? AND deleted_at IS NULL AND ${accountScope}
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(spaceId, limit);
    } catch (error) {
      debugLogger.error("Error getting notes for space", { error: error.message }, "notes");
      throw error;
    }
  }

  updateNote(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false, error: "Note not found" };
      updates = { ...updates };
      delete updates.account_id;
      if (updates.folder_id != null) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getLocalFolder(updates.folder_id);
        if (folder) updates = { ...updates, space_id: folder.space_id };
        else return { success: false, error: "Folder not found" };
      }
      if (updates.space_id !== undefined) {
        if (!this.getSpace(updates.space_id)) {
          return { success: false, error: "Space not found" };
        }
        updates.account_id = null;
      }
      const allowedFields = [
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhanced_at_content_hash",
        "folder_id",
        "space_id",
        "transcript",
        "calendar_event_id",
        "participants",
        "diarization_enabled",
        "expected_speaker_count",
        "sync_status",
        "deleted_at",
        "client_note_id",
        "cloud_id",
        "cloud_updated_at",
        "owner_user_id",
        "updated_by_user_id",
        "left_team",
        "account_id",
      ];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      // Re-queue for cloud sync on any local edit, so post-sync field changes aren't
      // left local-only and overwritten by a later pull.
      if (!("sync_status" in updates)) {
        fields.push("sync_status = 'pending'");
      }
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      const accountScope = localScope("notes");
      const stmt = this.db.prepare(
        `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND ${accountScope}`
      );
      const result = stmt.run(...values);
      if (result.changes === 0) return { success: false, error: "Note not found" };
      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(id);
      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      const accountScope = localScope("folders");
      conditions.push(accountScope);
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      return this.db
        .prepare(
          `SELECT * FROM folders WHERE ${conditions.join(" AND ")} ORDER BY sort_order ASC, created_at ASC`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name, spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      if (spaceId == null) spaceId = this.getPrivateSpaceId();
      if (!this.getSpace(spaceId)) {
        return { success: false, error: "Space not found" };
      }
      const accountScope = localScope("folders");
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND ${FOLDER_NAME_TAKEN_FILTER}
             AND ${accountScope}`
        )
        .get(trimmed, spaceId);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db
        .prepare("SELECT MAX(sort_order) as max_order FROM folders WHERE space_id = ?")
        .get(spaceId);
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const clientFolderId = randomUUID();
      const result = this.db
        .prepare(
          "INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)"
        )
        .run(trimmed, sortOrder, spaceId, clientFolderId);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getLocalFolder(id);
      if (folder?.deleted_at) return { success: false, error: "Folder not found" };
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const allChildNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const childNotes = `${allChildNotes} AND deleted_at IS NULL`;
      const accountScope = localScope("notes");
      const noteIds = this.db
        .prepare(`${childNotes} AND ${accountScope}`)
        .all(id)
        .map((row) => row.id);
      let relocatedNotes = [];
      this.db.transaction(() => {
        relocatedNotes = this._releaseOutOfScopeChildNotes(id);
        if (!folder.cloud_id) {
          // There is no server operation to deny. Local-only folders can
          // finalize immediately, including their local-only child content.
          this._deleteSpeakerRowsForNotes(allChildNotes, id);
          this.db.prepare("DELETE FROM notes WHERE folder_id = ?").run(id);
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
          return;
        }

        const journal = this.db.prepare(
          `INSERT OR IGNORE INTO optimistic_folder_delete_rows
             (folder_id, entity_type, entity_id, original_sync_status,
              original_deleted_at, original_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        journal.run(
          id,
          "folder",
          id,
          folder.sync_status ?? "synced",
          folder.deleted_at ?? null,
          folder.updated_at ?? null
        );

        const activeNotes = this.db.prepare(
          "SELECT id, sync_status, deleted_at, updated_at FROM notes WHERE folder_id = ? AND deleted_at IS NULL"
        );
        for (const note of activeNotes.all(id)) {
          journal.run(
            id,
            "note",
            note.id,
            note.sync_status ?? "pending",
            note.deleted_at ?? null,
            note.updated_at ?? null
          );
        }

        // Keep every child row in place while hiding them from normal readers
        // and all per-note sync queues.
        this.db
          .prepare(
            `UPDATE notes
             SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending',
                 updated_at = datetime('now')
             WHERE id IN (
               SELECT entity_id FROM optimistic_folder_delete_rows
               WHERE folder_id = ? AND entity_type = 'note'
             )`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE folders
             SET deleted_at = datetime('now'), updated_at = datetime('now'),
                 sync_status = 'pending'
             WHERE id = ?`
          )
          .run(id);
      })();
      return { success: true, id, noteIds, relocatedNotes };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getLocalFolder(id);
      if (folder?.deleted_at) return { success: false, error: "Folder not found" };
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const folderScope = localScope("folders");
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND id != ? AND ${FOLDER_NAME_TAKEN_FILTER}
             AND ${folderScope}`
        )
        .get(trimmed, folder.space_id, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      this.db
        .prepare(
          "UPDATE folders SET name = ?, sync_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        )
        .run(trimmed, id);
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated };
    } catch (error) {
      debugLogger.error("Error renaming folder", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // folder_id NULL rows are space-root notes; grouping by space_id too
      // attributes them per space so the tree shows true space totals.
      const accountScope = localScope("notes");
      return this.db
        .prepare(
          `SELECT space_id, folder_id, COUNT(*) as count
           FROM notes
           WHERE deleted_at IS NULL AND ${accountScope}
           GROUP BY space_id, folder_id`
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  getPrivateSpaceId() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get()?.id ?? null;
    } catch (error) {
      debugLogger.error("Error getting private space id", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Parses the teams JSON mirror so renderer consumers only ever see an array.
  _spaceRow(row) {
    if (!row) return row;
    let teams = [];
    if (row.teams) {
      try {
        teams = JSON.parse(row.teams);
      } catch {
        teams = [];
      }
    }
    return { ...row, teams };
  }

  getSpaces() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT * FROM spaces
           WHERE deleted_at IS NULL
             AND kind = 'private'
           ORDER BY CASE WHEN kind = 'private' THEN 0 ELSE 1 END, sort_order ASC, name ASC`
        )
        .all()
        .map((row) => this._spaceRow(row));
    } catch (error) {
      debugLogger.error("Error getting spaces", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpace(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare(
          `SELECT * FROM spaces
           WHERE id = ? AND deleted_at IS NULL AND kind = 'private'`
        )
        .get(id);
      return row ? this._spaceRow(row) : null;
    } catch (error) {
      debugLogger.error("Error getting space", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Speaker rows cascade on note delete (ON DELETE CASCADE), but callers that
  // only tombstone notes still need the explicit cleanup.
  _deleteSpeakerRowsForNotes(noteIdSubquery, param) {
    this.db.prepare(`DELETE FROM speaker_mappings WHERE note_id IN (${noteIdSubquery})`).run(param);
    this.db
      .prepare(`DELETE FROM note_speaker_embeddings WHERE note_id IN (${noteIdSubquery})`)
      .run(param);
  }

  _initVectorChangeJournal() {
    this.db.transaction(() => {
      const journalExists = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_vector_changes'"
        )
        .get();
      // AUTOINCREMENT keeps acknowledgements unique even after the queue is
      // emptied or a deleted note id is reused while indexing is in flight.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_changes (
          revision INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL UNIQUE
        );
        CREATE TRIGGER IF NOT EXISTS notes_vector_insert AFTER INSERT ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_update
        AFTER UPDATE OF title, content, enhanced_content, space_id, folder_id, deleted_at ON notes
        WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content
          OR OLD.enhanced_content IS NOT NEW.enhanced_content
          OR OLD.space_id IS NOT NEW.space_id OR OLD.folder_id IS NOT NEW.folder_id
          OR OLD.deleted_at IS NOT NEW.deleted_at
        BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_delete AFTER DELETE ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (OLD.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
      `);
      if (!journalExists) this.enqueueAllVectorChanges();
    })();
  }

  enqueueAllVectorChanges() {
    if (!this.db) throw new Error("Database not initialized");
    this.db.exec(`
      INSERT INTO pending_vector_changes (note_id) SELECT id FROM notes WHERE TRUE
      ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision
    `);
    return { success: true };
  }

  deleteNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const accountScope = localScope("notes");
      const stmt = this.db.prepare(
        `UPDATE notes
         SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now')
         WHERE id = ? AND deleted_at IS NULL AND ${accountScope}`
      );
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  saveGoogleTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(google_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.google_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens LIMIT 1").get() || null;
    } catch (error) {
      debugLogger.error("Error getting Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?").get(email) ||
        null
      );
    } catch (error) {
      debugLogger.error("Error getting Google tokens by email", { error: error.message }, "gcal");
      throw error;
    }
  }

  getAllGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens").all();
    } catch (error) {
      debugLogger.error("Error getting all Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT google_email AS email FROM google_calendar_tokens ORDER BY created_at ASC")
        .all();
    } catch (error) {
      debugLogger.error("Error getting Google accounts", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeGoogleAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM google_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'google' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);
        this.db.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Google account", { error: error.message }, "gcal");
      throw error;
    }
  }

  saveGoogleCalendars(calendars, accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           description = excluded.description,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.description || null,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  applyPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSelection(calendarId, isSelected) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?")
        .run(isSelected ? 1 : 0, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating calendar selection", { error: error.message }, "gcal");
      throw error;
    }
  }

  getSelectedCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error("Error getting selected calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  upsertCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((eventList) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
        );
        for (const e of eventList) {
          stmt.run(
            e.id,
            e.calendar_id,
            e.provider || "google",
            e.summary || null,
            e.start_time,
            e.end_time,
            e.is_all_day ? 1 : 0,
            e.status || "confirmed",
            e.availability_status || "unknown",
            e.self_response_status || "unknown",
            e.hangout_link || null,
            e.conference_data || null,
            e.organizer_email || null,
            e.attendees_count || 0,
            e.attendees || null
          );
        }
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getActiveEvents() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          dedupedEventsQuery(
            "datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all()
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting active events", { error: error.message }, "gcal");
      throw error;
    }
  }

  searchNotes(query, limit = 50, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const ftsQuery = buildNoteSearchQuery(query);
      if (!ftsQuery) return [];
      const accountScope = localScope("n");
      const params = [ftsQuery];
      let scopeFilter = "";
      if (spaceId != null) {
        scopeFilter += " AND n.space_id = ?";
        params.push(spaceId);
      }
      if (folderId != null) {
        scopeFilter += " AND n.folder_id = ?";
        params.push(folderId);
      }
      params.push(limit);
      return this.db
        .prepare(
          `
        SELECT n.*
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.id
        WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND ${accountScope}${scopeFilter}
        ORDER BY notes_fts.rank
        LIMIT ?
      `
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error searching notes", { error: error.message }, "database");
      throw error;
    }
  }

  getUpcomingEvents(windowMinutes = 1440) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          dedupedEventsQuery(
            "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all(windowMinutes)
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getCalendarEventsInRange(start, end, providers) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const rangeStart = Date.parse(start);
      const rangeEnd = Date.parse(end);
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
        throw new RangeError("Invalid calendar event range");
      }

      const selectedProviders = [...new Set(providers)].filter((provider) =>
        AVAILABILITY_PROVIDERS.has(provider)
      );
      if (selectedProviders.length === 0) return [];
      const placeholders = selectedProviders.map(() => "?").join(", ");
      const events = this.db
        .prepare(
          dedupedEventsQuery(
            `provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${SELECTED_CALENDAR_EVENT_FILTER}`
          )
        )
        .all(...selectedProviders)
        .map(stripDedupeColumn);

      return events.filter((event) => {
        const isAllDay = event.is_all_day === true || event.is_all_day === 1;
        const eventStart = parseEventTime(event.start_time, isAllDay);
        const eventEnd = parseEventTime(event.end_time, isAllDay);
        return (
          Number.isFinite(eventStart) &&
          Number.isFinite(eventEnd) &&
          eventStart < rangeEnd &&
          eventEnd > rangeStart
        );
      });
    } catch (error) {
      debugLogger.error(
        "Error getting calendar events in range",
        { error: error.message },
        "calendar"
      );
      throw error;
    }
  }

  getCalendarEventById(eventId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(eventId) || null;
    } catch (error) {
      debugLogger.error("Error getting calendar event by id", { error: error.message }, "gcal");
      return null;
    }
  }

  updateCalendarEventSelfResponse(eventId, status) {
    if (!this.db) throw new Error("Database not initialized");
    this.db
      .prepare("UPDATE calendar_events SET self_response_status = ? WHERE id = ?")
      .run(status, eventId);
  }

  getNoteByCalendarEventId(eventId, excludeNoteId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = localScope("notes");
      const base = `SELECT * FROM notes
                    WHERE calendar_event_id = ? AND deleted_at IS NULL
                      AND ${accountScope}`;
      if (excludeNoteId) {
        return this.db.prepare(`${base} AND id != ? LIMIT 1`).get(eventId, excludeNoteId) || null;
      }
      return this.db.prepare(`${base} LIMIT 1`).get(eventId) || null;
    } catch (error) {
      debugLogger.error(
        "Error getting note by calendar event id",
        { error: error.message },
        "notes"
      );
      return null;
    }
  }

  upsertContacts(contacts) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        const stmt = this.db.prepare(
          "INSERT INTO contacts (email, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
        );
        for (const c of list) {
          if (c.email) stmt.run(c.email.toLowerCase().trim(), c.displayName || null);
        }
      });
      transaction(contacts);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting contacts", { error: error.message }, "database");
      throw error;
    }
  }

  searchContacts(query) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query || ""}%`;
      return this.db
        .prepare(
          "SELECT * FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name ASC, email ASC LIMIT 20"
        )
        .all(pattern, pattern);
    } catch (error) {
      debugLogger.error("Error searching contacts", { error: error.message }, "database");
      throw error;
    }
  }

  clearGoogleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run();
        this.db.prepare("DELETE FROM google_calendars").run();
        this.db.prepare("DELETE FROM google_calendar_tokens").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSyncToken(calendarId, syncToken, expiresAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE google_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
        )
        .run(syncToken, expiresAt, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeCalendarEvents(eventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = eventIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM calendar_events WHERE id IN (${placeholders})`).run(...eventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  // A full (non-incremental) REST sync is authoritative for its calendar's
  // window: rows the provider no longer returns were deleted while no valid
  // sync token existed (e.g. the app was offline past the token TTL), so they
  // would otherwise linger and fire reminders for cancelled meetings. Rows
  // referenced by meeting notes are kept so notes retain calendar metadata.
  removeStaleCalendarEvents(provider, calendarId, freshEventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = freshEventIds.map(() => "?").join(", ");
      const freshFilter = freshEventIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";
      this.db
        .prepare(
          `DELETE FROM calendar_events
           WHERE provider = ? AND calendar_id = ? ${freshFilter}
             AND id NOT IN (
               SELECT calendar_event_id
               FROM notes
               WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
             )`
        )
        .run(provider, calendarId, ...freshEventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing stale calendar events",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  removeEventsFromDeselectedCalendars(provider) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const calendarsTable = CALENDARS_TABLE_BY_PROVIDER[provider];
      if (!calendarsTable) throw new Error(`Unknown calendar provider: ${provider}`);
      this.db
        .prepare(
          `DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${calendarsTable} WHERE is_selected = 1)`
        )
        .run(provider);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing events from deselected calendars",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  saveMicrosoftTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(microsoft_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.microsoft_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft tokens", { error: error.message }, "mcal");
      throw error;
    }
  }

  getMicrosoftTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .get(email) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting Microsoft tokens by email",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  getMicrosoftAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT microsoft_email AS email FROM microsoft_calendar_tokens ORDER BY created_at ASC"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting Microsoft accounts", { error: error.message }, "mcal");
      throw error;
    }
  }

  removeMicrosoftAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM microsoft_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'microsoft' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email);
        this.db
          .prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .run(email);
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Microsoft account", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveMicrosoftCalendars(calendars, accountEmail) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft calendars", { error: error.message }, "mcal");
      throw error;
    }
  }

  applyMicrosoftPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "mcal");
      throw error;
    }
  }

  getSelectedMicrosoftCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM microsoft_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error(
        "Error getting selected Microsoft calendars",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  updateMicrosoftCalendarSyncToken(calendarId, syncToken, expiresAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
        )
        .run(syncToken, expiresAt, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "mcal");
      throw error;
    }
  }

  clearMicrosoftCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run();
        this.db.prepare("DELETE FROM microsoft_calendars").run();
        this.db.prepare("DELETE FROM microsoft_calendar_tokens").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveAppleCalendars(calendars) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // Snapshots are complete: prune calendars removed from Calendar.app,
        // upsert the rest so created_at survives.
        if (list.length === 0) {
          this.db.prepare("DELETE FROM apple_calendars").run();
          return;
        }
        const placeholders = list.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM apple_calendars WHERE id NOT IN (${placeholders})`)
          .run(...list.map((cal) => cal.id));

        const stmt = this.db.prepare(
          `INSERT INTO apple_calendars (id, title, color, source_name)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             color = excluded.color,
             source_name = excluded.source_name`
        );
        for (const cal of list) {
          stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null);
        }
      });
      transaction(calendars);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  getAppleCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM apple_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  // Snapshots cover the full current/future window, so missing unreferenced
  // events can be removed while note-linked history is retained.
  replaceAppleCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // The helper snapshot only contains current/future events. Keep past or
        // rescheduled rows that are still referenced by meeting notes so those
        // notes retain their calendar metadata.
        this.db
          .prepare(
            `DELETE FROM calendar_events
             WHERE provider = 'apple'
               AND id NOT IN (
                 SELECT calendar_event_id
                 FROM notes
                 WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
               )`
          )
          .run();
        if (list.length > 0) this.upsertCalendarEvents(list);
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error replacing Apple calendar events", { error: error.message }, "acal");
      throw error;
    }
  }

  clearAppleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
        this.db.prepare("DELETE FROM apple_calendars").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing Apple calendar data", { error: error.message }, "acal");
      throw error;
    }
  }

  getMeetingsFolder(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = localScope("folders");
      return (
        this.db
          .prepare(
            `SELECT id FROM folders
             WHERE name = 'Meetings' AND is_default = 1 AND space_id = ?
               AND ${accountScope}`
          )
          .get(spaceId ?? this.getPrivateSpaceId()) || null
      );
    } catch (error) {
      debugLogger.error("Error getting meetings folder", { error: error.message }, "gcal");
      throw error;
    }
  }

  cleanup() {
    try {
      if (this.db) {
        try {
          this.db.close();
        } catch (closeError) {
          debugLogger.error("Error closing database", { error: closeError.message }, "database");
        }
        this.db = null;
      }
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (error) {
      debugLogger.error("Error deleting database file", { error: error.message }, "database");
    }
  }

  _normalizeEmail(email) {
    const trimmed = (email || "").trim().toLowerCase();
    return trimmed || null;
  }

  _findProfileByEmail(email) {
    const normalized = this._normalizeEmail(email);
    if (!normalized) return null;
    return this.db.prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ?").get(normalized);
  }

  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      let existing = profileId
        ? this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId)
        : null;
      if (!existing && normalizedEmail) {
        existing = this._findProfileByEmail(normalizedEmail);
      }
      if (!existing) {
        existing = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE display_name = ?")
          .get(name);
      }
      if (existing) {
        const stored = new Float32Array(
          existing.embedding.buffer,
          existing.embedding.byteOffset,
          existing.embedding.byteLength / 4
        );
        const incoming = new Float32Array(
          embeddingBuffer.buffer,
          embeddingBuffer.byteOffset,
          embeddingBuffer.byteLength / 4
        );
        const updated = new Float32Array(stored.length);
        for (let i = 0; i < stored.length; i++) {
          updated[i] = 0.3 * incoming[i] + 0.7 * stored[i];
        }
        const updatedBuf = Buffer.from(updated.buffer);
        const finalEmail = normalizedEmail || existing.email || null;
        this.db
          .prepare(
            "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = sample_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(name, finalEmail, updatedBuf, existing.id);
        const resolved = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
          .get(existing.id);
        if (normalizedEmail) {
          const collision = this.db
            .prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ? AND id != ?")
            .get(normalizedEmail, existing.id);
          if (collision) {
            return this.mergeSpeakerProfiles(resolved, collision);
          }
        }
        return resolved;
      }
      const result = this.db
        .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
        .run(name, normalizedEmail, embeddingBuffer);
      return this.db
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error upserting speaker profile", { error: error.message }, "database");
      throw error;
    }
  }

  attachEmailToProfile(profileId, email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      const profile = this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      if (!profile) throw new Error(`Speaker profile ${profileId} not found`);

      if (!normalizedEmail) {
        this.db
          .prepare(
            "UPDATE speaker_profiles SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(profileId);
        return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      }

      const collision = this._findProfileByEmail(normalizedEmail);
      if (collision && collision.id !== profileId) {
        return this.mergeSpeakerProfiles(collision, profile);
      }

      this.db
        .prepare(
          "UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(normalizedEmail, profileId);
      return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
    } catch (error) {
      debugLogger.error(
        "Error attaching email to speaker profile",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  mergeSpeakerProfiles(a, b) {
    const winner = (a.sample_count || 0) >= (b.sample_count || 0) ? a : b;
    const loser = winner === a ? b : a;

    const winnerEmb = new Float32Array(
      winner.embedding.buffer,
      winner.embedding.byteOffset,
      winner.embedding.byteLength / 4
    );
    const loserEmb = new Float32Array(
      loser.embedding.buffer,
      loser.embedding.byteOffset,
      loser.embedding.byteLength / 4
    );
    const wSamples = winner.sample_count || 1;
    const lSamples = loser.sample_count || 1;
    const total = wSamples + lSamples;
    const blended = new Float32Array(winnerEmb.length);
    for (let i = 0; i < winnerEmb.length; i++) {
      blended[i] = (winnerEmb[i] * wSamples + loserEmb[i] * lSamples) / total;
    }

    const finalEmail = winner.email || loser.email || null;
    const finalName = winner.display_name || loser.display_name;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(finalName, finalEmail, Buffer.from(blended.buffer), total, winner.id);
      this.db
        .prepare(
          "UPDATE speaker_mappings SET profile_id = ?, display_name = ? WHERE profile_id = ?"
        )
        .run(winner.id, finalName, loser.id);
      this.db.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(loser.id);
    });
    tx();

    return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(winner.id);
  }

  getSpeakerProfiles(includeEmbedding = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const query = includeEmbedding
        ? "SELECT * FROM speaker_profiles"
        : `SELECT id, display_name, email, sample_count, created_at, updated_at
           FROM speaker_profiles`;
      return this.db.prepare(query).all();
    } catch (error) {
      debugLogger.error("Error getting speaker profiles", { error: error.message }, "database");
      throw error;
    }
  }

  setSpeakerMapping(noteId, speakerId, profileId, displayName) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
      this.db
        .prepare(
          "INSERT OR REPLACE INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?)"
        )
        .run(noteId, speakerId, profileId, displayName);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }

  getSpeakerMappings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error("Error getting speaker mappings", { error: error.message }, "database");
      throw error;
    }
  }

  saveNoteSpeakerEmbeddings(noteId, embeddings) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
      const transaction = this.db.transaction((entries) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
        );
        for (const [speakerId, buffer] of entries) {
          stmt.run(noteId, speakerId, buffer);
        }
      });
      transaction(Object.entries(embeddings));
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error saving note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNoteSpeakerEmbeddings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      return this.db.prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error(
        "Error getting note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNotesWithUnmappedSpeakers() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = localScope("notes");
      return this.db
        .prepare(
          `SELECT DISTINCT nse.note_id
          FROM note_speaker_embeddings nse
          JOIN notes ON notes.id = nse.note_id
          LEFT JOIN speaker_mappings sm ON nse.note_id = sm.note_id AND nse.speaker_id = sm.speaker_id
          WHERE sm.note_id IS NULL AND ${accountScope}`
        )
        .all()
        .map((row) => row.note_id);
    } catch (error) {
      debugLogger.error(
        "Error getting notes with unmapped speakers",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  removeSpeakerMapping(noteId, speakerId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false };
      this.db
        .prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?")
        .run(noteId, speakerId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }
}

module.exports = DatabaseManager;
