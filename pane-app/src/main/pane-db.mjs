/**
 * pane-db.mjs — SQLite persistence layer for Pane app data.
 *
 * Opens ~/.pane/pane.db and owns all data tables:
 *   messages, conversation_meta, change_history,
 *   checkpoints, state_blobs, scroll_positions
 *
 * better-sqlite3 is synchronous by design. All exported functions are
 * synchronous unless they touch the filesystem for migration (async).
 *
 * Only opened by the main process. UtilityProcess workers (punk-engine,
 * brain-engine) must NOT import this module — they cannot share the same
 * SQLite connection safely.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const DB_PATH = path.join(PANE_DIR, "pane.db");

let _db = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initPaneDb() {
  if (_db) return _db;

  fs.mkdirSync(PANE_DIR, { recursive: true });
  _db = new Database(DB_PATH);

  // WAL mode: allows concurrent reads while a write is in progress.
  // synchronous = NORMAL: safe with WAL, much faster than FULL.
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");

  _createSchema(_db);
  _prepareStatements(_db);

  return _db;
}

export function getPaneDb() {
  if (!_db) throw new Error("[pane-db] DB not initialized — call initPaneDb() first");
  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function _createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_version (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT    PRIMARY KEY,
      project_id    TEXT    NOT NULL,
      type          TEXT    NOT NULL,
      content       TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      cost_usd      REAL,
      duration_ms   INTEGER,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      checkpoint_id TEXT,
      model         TEXT,
      num_turns     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_project
      ON messages(project_id, created_at);

    CREATE TABLE IF NOT EXISTS conversation_meta (
      project_id TEXT    PRIMARY KEY,
      session_id TEXT,
      model      TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_sessions (
      project_id TEXT NOT NULL,
      backend    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, backend)
    );

    CREATE TABLE IF NOT EXISTS change_history (
      id          TEXT    PRIMARY KEY,
      project_id  TEXT    NOT NULL,
      file_path   TEXT    NOT NULL,
      old_string  TEXT,
      new_string  TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      timestamp   INTEGER NOT NULL,
      working_dir TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_changes_project
      ON change_history(project_id, timestamp);

    CREATE TABLE IF NOT EXISTS checkpoints (
      id          TEXT    PRIMARY KEY,
      project_id  TEXT    NOT NULL,
      message_id  TEXT,
      created_at  INTEGER NOT NULL,
      file_count  INTEGER NOT NULL DEFAULT 0,
      head_commit TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_project
      ON checkpoints(project_id, created_at);

    CREATE TABLE IF NOT EXISTS state_blobs (
      project_id TEXT    NOT NULL,
      key        TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    );

    CREATE TABLE IF NOT EXISTS scroll_positions (
      project_id TEXT    PRIMARY KEY,
      position   TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id                          TEXT    PRIMARY KEY,
      project_id                  TEXT    NOT NULL,
      provider                    TEXT    NOT NULL,
      activity_type               TEXT    NOT NULL,
      model                       TEXT    NOT NULL,
      input_tokens                INTEGER NOT NULL,
      output_tokens               INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER DEFAULT 0,
      cache_read_input_tokens     INTEGER DEFAULT 0,
      cost_usd                    REAL    NOT NULL,
      cost_source                 TEXT    NOT NULL DEFAULT 'estimated',
      cost_rate_snapshot          TEXT,
      duration_ms                 INTEGER DEFAULT 0,
      timestamp                   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id, timestamp);

    -- Quality metrics — behavioral fingerprinting per turn.
    -- Tracks how each model performs on code quality over time.
    CREATE TABLE IF NOT EXISTS quality_metrics (
      id                TEXT    PRIMARY KEY,
      project_id        TEXT    NOT NULL,
      model             TEXT,
      provider          TEXT,
      verdict_pass      INTEGER NOT NULL DEFAULT 1,
      quality_score     INTEGER NOT NULL DEFAULT 100,
      type_errors       INTEGER NOT NULL DEFAULT 0,
      lint_errors       INTEGER NOT NULL DEFAULT 0,
      suppressions      INTEGER NOT NULL DEFAULT 0,
      self_corrected    INTEGER,
      files_changed     INTEGER NOT NULL DEFAULT 0,
      arch_issues       INTEGER NOT NULL DEFAULT 0,
      timestamp         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quality_project
      ON quality_metrics(project_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_quality_model
      ON quality_metrics(model, timestamp);

    -- Correction events — tracks individual corrections for pattern detection.
    -- When the same correction_type hits 3+ times in a week, it graduates
    -- to a candidate rule. No LLM extraction — just counting events.
    CREATE TABLE IF NOT EXISTS correction_events (
      id               TEXT    PRIMARY KEY,
      project_id       TEXT    NOT NULL,
      correction_type  TEXT    NOT NULL,
      model            TEXT,
      source           TEXT    NOT NULL,
      detail           TEXT,
      timestamp        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_project
      ON correction_events(project_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_corrections_type
      ON correction_events(correction_type, timestamp);

    -- FTS5 full-text search across all conversation messages.
    -- Stores extracted plain text from message content blocks.
    -- porter unicode61 tokenizer handles stemming (search "running" finds "run").
    -- project_id and message_id are UNINDEXED — stored but not tokenized,
    -- used to join back to the messages table on search results.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      project_id  UNINDEXED,
      message_id  UNINDEXED,
      text_content,
      tokenize = 'porter unicode61'
    );

    -- Keep FTS in sync when messages are deleted.
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END;
  `);
}

// ---------------------------------------------------------------------------
// Prepared statements (attached to db object for easy access)
// ---------------------------------------------------------------------------

function _prepareStatements(db) {
  db.stmts = {
    // migration
    getMigrationVersion: db.prepare("SELECT version FROM migration_version WHERE id = 1"),
    setMigrationVersion: db.prepare("INSERT OR REPLACE INTO migration_version (id, version) VALUES (1, ?)"),

    // messages
    insertMessage: db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, project_id, type, content, created_at,
         cost_usd, duration_ms, input_tokens, output_tokens,
         checkpoint_id, model, num_turns)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countMessages: db.prepare("SELECT COUNT(*) AS cnt FROM messages WHERE project_id = ?"),
    deleteAllMessages: db.prepare("DELETE FROM messages WHERE project_id = ?"),
    selectMessagesSlice: db.prepare(`
      SELECT content FROM messages
      WHERE project_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `),
    keepLatestMessages: db.prepare(`
      DELETE FROM messages WHERE project_id = ? AND id NOT IN (
        SELECT id FROM messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
      )
    `),

    // conversation_meta
    upsertConvMeta: db.prepare(`
      INSERT OR REPLACE INTO conversation_meta (project_id, session_id, model, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    getConvMeta: db.prepare("SELECT session_id, model FROM conversation_meta WHERE project_id = ?"),

    // cli_sessions — per-backend session IDs (survive app restarts without clobbering)
    upsertCliSession: db.prepare(`
      INSERT OR REPLACE INTO cli_sessions (project_id, backend, session_id, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    deleteCliSession: db.prepare("DELETE FROM cli_sessions WHERE project_id = ? AND backend = ?"),
    getCliSessions: db.prepare("SELECT project_id, session_id FROM cli_sessions WHERE backend = ?"),

    // change_history
    insertChange: db.prepare(`
      INSERT INTO change_history
        (id, project_id, file_path, old_string, new_string, description, timestamp, working_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getChanges: db.prepare(
      "SELECT * FROM change_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT 500"
    ),
    getChangeById: db.prepare("SELECT * FROM change_history WHERE id = ?"),
    deleteChangeById: db.prepare("DELETE FROM change_history WHERE id = ?"),
    deleteAllChanges: db.prepare("DELETE FROM change_history WHERE project_id = ?"),
    searchChanges: db.prepare(
      "SELECT * FROM change_history WHERE project_id = ? AND (file_path LIKE ? OR description LIKE ? OR new_string LIKE ? OR old_string LIKE ?) ORDER BY timestamp DESC LIMIT 200"
    ),
    searchChangesByFile: db.prepare(
      "SELECT * FROM change_history WHERE project_id = ? AND file_path = ? ORDER BY timestamp DESC LIMIT 200"
    ),

    // checkpoints
    insertCheckpoint: db.prepare(`
      INSERT OR REPLACE INTO checkpoints
        (id, project_id, message_id, created_at, file_count, head_commit)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    listCheckpoints: db.prepare(
      "SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at ASC"
    ),
    getCheckpoint: db.prepare("SELECT * FROM checkpoints WHERE id = ?"),
    deleteCheckpointsByProject: db.prepare("DELETE FROM checkpoints WHERE project_id = ?"),

    // state_blobs
    upsertBlob: db.prepare(`
      INSERT OR REPLACE INTO state_blobs (project_id, key, data, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    getBlob: db.prepare("SELECT data FROM state_blobs WHERE project_id = ? AND key = ?"),

    // scroll_positions
    upsertScroll: db.prepare(`
      INSERT OR REPLACE INTO scroll_positions (project_id, position, updated_at)
      VALUES (?, ?, ?)
    `),
    getAllScrolls: db.prepare("SELECT project_id, position FROM scroll_positions"),

    // token_usage
    insertTokenUsage: db.prepare(`
      INSERT INTO token_usage
        (id, project_id, provider, activity_type, model,
         input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, cost_usd, cost_source, cost_rate_snapshot,
         duration_ms, timestamp)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getTokenAnalytics: db.prepare(`
      SELECT
        model, provider, activity_type,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_creation_input_tokens) as total_cache_creation,
        SUM(cache_read_input_tokens) as total_cache_read,
        SUM(cost_usd) as total_cost_usd,
        AVG(duration_ms) as avg_duration_ms,
        COUNT(*) as call_count,
        MAX(timestamp) as last_used,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) as unknown_cost_count,
        SUM(CASE WHEN cost_source = 'api' THEN 1 ELSE 0 END) as api_reported_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) as estimated_count,
        (SELECT cost_rate_snapshot FROM token_usage tu2
         WHERE tu2.model = t.model
           AND tu2.provider = t.provider
           AND tu2.activity_type = t.activity_type
           AND tu2.cost_rate_snapshot IS NOT NULL
         ORDER BY tu2.timestamp DESC LIMIT 1) as latest_rate_snapshot
      FROM token_usage t
      WHERE project_id = ? AND timestamp >= ?
      GROUP BY model, provider, activity_type
      ORDER BY call_count DESC
    `),
    getGlobalTokenAnalytics: db.prepare(`
      SELECT
        model, provider, activity_type,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_creation_input_tokens) as total_cache_creation,
        SUM(cache_read_input_tokens) as total_cache_read,
        SUM(cost_usd) as total_cost_usd,
        AVG(duration_ms) as avg_duration_ms,
        COUNT(*) as call_count,
        MAX(timestamp) as last_used,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) as unknown_cost_count,
        SUM(CASE WHEN cost_source = 'api' THEN 1 ELSE 0 END) as api_reported_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) as estimated_count,
        (SELECT cost_rate_snapshot FROM token_usage tu2
         WHERE tu2.model = t.model
           AND tu2.provider = t.provider
           AND tu2.activity_type = t.activity_type
           AND tu2.cost_rate_snapshot IS NOT NULL
         ORDER BY tu2.timestamp DESC LIMIT 1) as latest_rate_snapshot
      FROM token_usage t
      WHERE timestamp >= ?
      GROUP BY model, provider, activity_type
      ORDER BY call_count DESC
    `),
    getTokenTimeSeries: db.prepare(`
      SELECT
        DATE(timestamp / 1000, 'unixepoch') as day,
        SUM(cost_usd) as daily_cost,
        SUM(input_tokens) as daily_input,
        SUM(output_tokens) as daily_output,
        SUM(cache_read_input_tokens) as daily_cache_read,
        COUNT(*) as daily_calls,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) as unknown_cost_count,
        SUM(CASE WHEN cost_source = 'api' THEN 1 ELSE 0 END) as api_reported_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) as estimated_count
      FROM token_usage
      WHERE project_id = ? AND timestamp >= ?
      GROUP BY day
      ORDER BY day ASC
    `),
    getGlobalTokenTimeSeries: db.prepare(`
      SELECT
        DATE(timestamp / 1000, 'unixepoch') as day,
        SUM(cost_usd) as daily_cost,
        SUM(input_tokens) as daily_input,
        SUM(output_tokens) as daily_output,
        SUM(cache_read_input_tokens) as daily_cache_read,
        COUNT(*) as daily_calls,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) as unknown_cost_count,
        SUM(CASE WHEN cost_source = 'api' THEN 1 ELSE 0 END) as api_reported_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) as estimated_count
      FROM token_usage
      WHERE timestamp >= ?
      GROUP BY day
      ORDER BY day ASC
    `),

    // quality metrics — behavioral fingerprinting
    insertQualityMetric: db.prepare(`
      INSERT INTO quality_metrics
        (id, project_id, model, provider, verdict_pass, quality_score,
         type_errors, lint_errors, suppressions, self_corrected,
         files_changed, arch_issues, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getQualityStats: db.prepare(`
      SELECT
        COUNT(*) as total_turns,
        SUM(CASE WHEN verdict_pass = 0 THEN 1 ELSE 0 END) as failed_turns,
        AVG(quality_score) as avg_score,
        SUM(type_errors) as total_type_errors,
        SUM(lint_errors) as total_lint_errors,
        SUM(suppressions) as total_suppressions,
        SUM(CASE WHEN self_corrected = 1 THEN 1 ELSE 0 END) as corrections,
        SUM(CASE WHEN self_corrected = 0 THEN 1 ELSE 0 END) as uncorrected,
        SUM(arch_issues) as total_arch_issues
      FROM quality_metrics
      WHERE project_id = ? AND timestamp >= ?
    `),
    getModelQualityStats: db.prepare(`
      SELECT
        model,
        COUNT(*) as total_turns,
        AVG(quality_score) as avg_score,
        SUM(suppressions) as total_suppressions,
        SUM(CASE WHEN self_corrected = 1 THEN 1 ELSE 0 END) as corrections,
        SUM(CASE WHEN self_corrected = 0 THEN 1 ELSE 0 END) as uncorrected
      FROM quality_metrics
      WHERE project_id = ? AND timestamp >= ?
      GROUP BY model
      ORDER BY avg_score ASC
    `),
    getRecentVerdicts: db.prepare(`
      SELECT verdict_pass, quality_score, type_errors, lint_errors, suppressions, self_corrected, model
      FROM quality_metrics
      WHERE project_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `),

    // correction events — pattern detection for rule graduation
    insertCorrection: db.prepare(`
      INSERT INTO correction_events (id, project_id, correction_type, model, source, detail, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getRepeatedCorrections: db.prepare(`
      SELECT correction_type, COUNT(*) as count, MAX(detail) as last_detail, MAX(timestamp) as last_seen
      FROM correction_events
      WHERE timestamp >= ?
      GROUP BY correction_type
      HAVING count >= ?
      ORDER BY count DESC
    `),
    getCorrectionsByProject: db.prepare(`
      SELECT correction_type, COUNT(*) as count, MAX(detail) as last_detail
      FROM correction_events
      WHERE project_id = ? AND timestamp >= ?
      GROUP BY correction_type
      HAVING count >= 2
      ORDER BY count DESC
    `),

    // FTS5 — full-text search across messages
    // Delete + re-insert pattern handles both new inserts and updates cleanly.
    deleteFts: db.prepare("DELETE FROM messages_fts WHERE message_id = ?"),
    insertFts: db.prepare(
      "INSERT INTO messages_fts (project_id, message_id, text_content) VALUES (?, ?, ?)"
    ),
    // Full-text search. Pass { query, projectId, limit } as named params.
    // projectId = null searches across all projects.
    searchMessages: db.prepare(`
      SELECT m.content, m.project_id
      FROM messages_fts f
      JOIN messages m ON m.id = f.message_id
      WHERE messages_fts MATCH @query
        AND (@projectId IS NULL OR f.project_id = @projectId)
      ORDER BY rank
      LIMIT @limit
    `),
  };
}

// ---------------------------------------------------------------------------
// Text extraction helper for FTS indexing
// ---------------------------------------------------------------------------

// Extracts plain text from a stored message content JSON string.
// Indexes only text blocks — skips tool calls, tool results, thinking blocks.
export function extractMessageText(contentJson) {
  try {
    const msg = JSON.parse(contentJson);
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    return blocks
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Prune old conversation messages from pane.db, keeping only the latest N.
 * Call after successful post-turn extraction — the structured knowledge is
 * already in the brain engine's graph, the raw messages are no longer needed.
 *
 * FTS is cleaned up automatically via the messages_fts_delete trigger.
 *
 * @param {string} projectId
 * @param {number} [keepCount=200] - Number of most recent messages to retain
 */
export function pruneConversationMessages(projectId, keepCount = 200) {
  try {
    const db = getPaneDb();
    if (!db || !db.stmts.keepLatestMessages) return;
    const before = db.stmts.countMessages.get(projectId)?.cnt ?? 0;
    if (before <= keepCount) return; // Nothing to prune
    db.stmts.keepLatestMessages.run(projectId, projectId, keepCount);
    const after = db.stmts.countMessages.get(projectId)?.cnt ?? 0;
    console.log(`[pane-db] Pruned messages for ${projectId}: ${before} -> ${after} (kept ${keepCount})`);
  } catch (err) {
    console.warn(`[pane-db] pruneConversationMessages failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// One-time migration from legacy JSON files
// ---------------------------------------------------------------------------

export async function runMigrationIfNeeded(db) {
  const row = db.stmts.getMigrationVersion.get();
  const version = row?.version ?? 0;

  if (version < 1) {
    console.log("[pane-db] Checking for one-time migration from JSON files...");
    try { await _migrateConversations(db); } catch (e) { console.error("[pane-db] conv migration error:", e.message); }
    try { await _migrateChangeHistory(db); } catch (e) { console.error("[pane-db] change migration error:", e.message); }
    try { await _migrateCheckpoints(db); }  catch (e) { console.error("[pane-db] checkpoint migration error:", e.message); }
    try { await _migrateStateBlobs(db); }   catch (e) { console.error("[pane-db] state migration error:", e.message); }
    try { await _migrateScrollPositions(db); } catch (e) { console.error("[pane-db] scroll migration error:", e.message); }
    if (version < 1) db.stmts.setMigrationVersion.run(1);
  }

  if (version < 3) {
    console.log("[pane-db] Running migration v2/v3: importing archived conversations...");
    try { await _migrateArchivedConversations(db); } catch (e) { console.error("[pane-db] archived migration error:", e.message); }
    db.stmts.setMigrationVersion.run(3);
    console.log("[pane-db] Migration v3 complete.");
  }

  if (version < 4) {
    // Migrate session IDs from conversation_meta → cli_sessions.
    // conversation_meta stored one session_id per project, so switching
    // backends (claude ↔ gemini) clobbered the other's ID. cli_sessions
    // is keyed on (project_id, backend) so each backend keeps its own.
    console.log("[pane-db] Running migration v4: per-backend session IDs...");
    try {
      const rows = db.prepare(
        "SELECT project_id, session_id, model FROM conversation_meta WHERE session_id IS NOT NULL"
      ).all();
      for (const row of rows) {
        const backend = row.model || "claude"; // model column stored backend name
        db.stmts.upsertCliSession.run(row.project_id, backend, row.session_id, Date.now());
      }
      // Clear session_id from conversation_meta — cli_sessions owns this now
      db.prepare("UPDATE conversation_meta SET session_id = NULL").run();
    } catch (e) {
      console.error("[pane-db] v4 migration error:", e.message);
    }
    db.stmts.setMigrationVersion.run(4);
    console.log("[pane-db] Migration v4 complete.");
  }

  if (version < 5) {
    console.log("[pane-db] Running migration v5: cost provenance columns...");
    // SQLite doesn't support ADD COLUMN IF NOT EXISTS — use try/catch per column
    try {
      db.exec("ALTER TABLE token_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated'");
    } catch (e) {
      if (!e.message.includes("duplicate column")) throw e;
    }
    try {
      db.exec("ALTER TABLE token_usage ADD COLUMN cost_rate_snapshot TEXT");
    } catch (e) {
      if (!e.message.includes("duplicate column")) throw e;
    }
    db.stmts.setMigrationVersion.run(5);
    console.log("[pane-db] Migration v5 complete.");
  }

  if (version < 6) {
    console.log("[pane-db] Running migration v6: normalize input_tokens to raw total...");
    // Old records stored input_tokens as non-cached only. New records store
    // raw total (including cache_read_input_tokens). Fix old records so
    // input_tokens + cache_read_input_tokens = raw total across all time.
    try {
      const result = db.prepare(
        "UPDATE token_usage SET input_tokens = input_tokens + cache_read_input_tokens WHERE cache_read_input_tokens > 0"
      ).run();
      console.log(`[pane-db] Migration v6 complete: ${result.changes} rows updated.`);
    } catch (e) {
      console.error("[pane-db] v6 migration error:", e.message);
    }
    db.stmts.setMigrationVersion.run(6);
    console.log("[pane-db] Migration v6 complete.");
  }
}

async function _migrateConversations(db) {
  const convDir = path.join(PANE_DIR, "conversations");
  let files;
  try { files = fs.readdirSync(convDir).filter(f => f.endsWith(".json")); }
  catch { return; } // directory doesn't exist yet

  for (const file of files) {
    const projectId = file.replace(".json", "");
    try {
      const raw = fs.readFileSync(path.join(convDir, file), "utf-8");
      const data = JSON.parse(raw.trim());
      const messages = Array.isArray(data.messages) ? data.messages : [];

      const insertMessages = db.transaction((msgs) => {
        for (let i = 0; i < msgs.length; i++) {
          const msg = msgs[i];
          const id = msg.id || `migrated-${projectId}-${i}`;
          const contentJson = JSON.stringify(msg);
          db.stmts.insertMessage.run(
            id, projectId, msg.type ?? "assistant",
            contentJson,
            msg.created_at ?? msg.timestamp ?? (Date.now() + i),
            msg.cost_usd ?? null, msg.duration_ms ?? null,
            msg.input_tokens ?? null, msg.output_tokens ?? null,
            msg.checkpoint_id ?? null, msg.model ?? null, msg.num_turns ?? null,
          );
          const text = extractMessageText(contentJson);
          if (text) {
            db.stmts.deleteFts.run(id);
            db.stmts.insertFts.run(projectId, id, text);
          }
        }
        db.stmts.upsertConvMeta.run(projectId, null, data.model ?? null, Date.now());
      });

      insertMessages(messages);
      console.log(`[pane-db] migrated ${messages.length} messages for project ${projectId}`);

      // Archive the migrated file so it won't be re-processed on restart
      try {
        const bakDir = path.join(convDir, "archived");
        fs.mkdirSync(bakDir, { recursive: true });
        fs.renameSync(path.join(convDir, file), path.join(bakDir, `${file}.bak`));
      } catch (e) {
        console.warn(`[pane-db] failed to archive conversation ${file}:`, e.message);
      }
    } catch (e) {
      console.error(`[pane-db] failed to migrate conversation ${file}:`, e.message);
    }
  }
}

// Migration v2: import conversations from archived .bak files that were skipped by v1.
// Prefers <name>.json.bak, falls back to <name>.json.fix.bak if the primary is corrupt.
// Skips projects that already have messages in SQLite (e.g. pane was migrated in v1).
async function _migrateArchivedConversations(db) {
  const archivedDir = path.join(PANE_DIR, "conversations", "archived");
  let allFiles;
  try { allFiles = fs.readdirSync(archivedDir); }
  catch { return; } // archived dir doesn't exist

  // Collect candidate files per project: primary (.json.bak) and fix (.json.fix.bak)
  const primaries = new Map(); // projectId → primary filePath
  const fixes = new Map();     // projectId → fix filePath
  for (const file of allFiles) {
    const primaryMatch = file.match(/^(.+)\.json\.bak$/);
    const fixMatch = file.match(/^(.+)\.json\.fix\.bak$/);
    if (primaryMatch) primaries.set(primaryMatch[1], path.join(archivedDir, file));
    else if (fixMatch) fixes.set(fixMatch[1], path.join(archivedDir, file));
  }
  // Build candidate list: all project IDs from either set
  const allIds = new Set([...primaries.keys(), ...fixes.keys()]);
  const candidates = new Map();
  for (const id of allIds) {
    // Prefer primary; fix is the fallback if primary is absent
    candidates.set(id, { primary: primaries.get(id), fix: fixes.get(id) });
  }

  for (const [projectId, { primary, fix }] of candidates) {
    // Skip if already has messages (v1 already migrated it)
    const existing = db.prepare("SELECT COUNT(*) AS cnt FROM messages WHERE project_id = ?").get(projectId);
    if (existing?.cnt > 0) {
      console.log(`[pane-db] skipping archived ${projectId}: already has ${existing.cnt} messages`);
      continue;
    }

    // Try primary first, then fix as fallback
    const filesToTry = [primary, fix].filter(Boolean);
    let migrated = false;
    for (const filePath of filesToTry) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw.trim());
        const messages = Array.isArray(data.messages) ? data.messages : [];
        if (messages.length === 0) continue;

        const insertMessages = db.transaction((msgs) => {
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const id = msg.id || `archived-${projectId}-${i}`;
            const contentJson = JSON.stringify(msg);
            db.stmts.insertMessage.run(
              id, projectId, msg.type ?? "assistant",
              contentJson,
              msg.created_at ?? msg.timestamp ?? (Date.now() + i),
              msg.cost_usd ?? null, msg.duration_ms ?? null,
              msg.input_tokens ?? null, msg.output_tokens ?? null,
              msg.checkpoint_id ?? null, msg.model ?? null, msg.num_turns ?? null,
            );
            const text = extractMessageText(contentJson);
            if (text) {
              db.stmts.deleteFts.run(id);
              db.stmts.insertFts.run(projectId, id, text);
            }
          }
          db.stmts.upsertConvMeta.run(projectId, null, data.model ?? null, Date.now());
        });

        insertMessages(messages);
        console.log(`[pane-db] archived migration: ${messages.length} messages for ${projectId} (${path.basename(filePath)})`);
        migrated = true;
        break;
      } catch (e) {
        console.error(`[pane-db] failed to parse ${path.basename(filePath)} for ${projectId}: ${e.message}`);
      }
    }
    if (!migrated) console.error(`[pane-db] no valid backup found for ${projectId}`);
  }
}

async function _migrateChangeHistory(db) {
  const historyDir = path.join(PANE_DIR, "change-history");
  const archivedHistoryDir = path.join(historyDir, "archived");
  let projects;
  try { projects = fs.readdirSync(historyDir).filter(p => p !== "archived"); }
  catch { return; }

  for (const projectId of projects) {
    const file = path.join(historyDir, projectId, "changes.json");
    if (!fs.existsSync(file)) continue;

    try {
      const raw = fs.readFileSync(file, "utf-8");
      const changes = JSON.parse(raw.trim());
      if (!Array.isArray(changes)) continue;

      const insertAll = db.transaction((items) => {
        for (const c of items) {
          db.stmts.insertChange.run(
            c.id ?? `ch-migrated-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            projectId,
            c.file ?? c.file_path ?? "",
            c.oldString ?? c.old_string ?? null,
            c.newString ?? c.new_string ?? "",
            c.description ?? "",
            c.timestamp ?? Date.now(),
            c.workingDir ?? c.working_dir ?? null,
          );
        }
      });
      insertAll(changes);
      console.log(`[pane-db] migrated ${changes.length} changes for project ${projectId}`);

      // Archive the migrated file
      try {
        const destDir = path.join(archivedHistoryDir, projectId);
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(file, path.join(destDir, "changes.json.bak"));
      } catch (e) {
        console.warn(`[pane-db] failed to archive change history for ${projectId}:`, e.message);
      }
    } catch (e) {
      console.error(`[pane-db] failed to migrate change history for ${projectId}:`, e.message);
    }
  }
}

async function _migrateCheckpoints(db) {
  const cpBaseDir = path.join(PANE_DIR, "checkpoints");
  let projects;
  try { projects = fs.readdirSync(cpBaseDir); }
  catch { return; }

  for (const projectId of projects) {
    const dir = path.join(cpBaseDir, projectId);
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch { continue; }

    const insertAll = db.transaction((items) => {
      for (const { id, messageId, timestamp, fileCount, headCommit } of items) {
        db.stmts.insertCheckpoint.run(id, projectId, messageId ?? null, timestamp, fileCount, headCommit ?? null);
      }
    });

    const items = [];
    for (const entry of entries) {
      if (!entry.startsWith("cp-") || !entry.endsWith(".json")) continue;
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8"));
        items.push({
          id: cp.id,
          messageId: cp.messageId ?? null,
          timestamp: cp.timestamp ?? Date.now(),
          fileCount: Array.isArray(cp.files) ? cp.files.length : 0,
          headCommit: cp.headCommit ?? null,
        });
      } catch {}
    }
    if (items.length) {
      insertAll(items);
      console.log(`[pane-db] migrated ${items.length} checkpoints for project ${projectId}`);
    }
  }
}

async function _migrateStateBlobs(db) {
  const stateDir = path.join(PANE_DIR, "state");
  const sessionDir = path.join(PANE_DIR, "session");
  let projects = new Set();

  try { for (const p of fs.readdirSync(stateDir)) projects.add(p); } catch {}
  try { for (const p of fs.readdirSync(sessionDir)) projects.add(p); } catch {}

  const insertBlob = db.transaction((projectId, key, data) => {
    db.stmts.upsertBlob.run(projectId, key, JSON.stringify(data), Date.now());
  });

  for (const projectId of projects) {
    for (const key of ["editor", "project"]) {
      try {
        const raw = fs.readFileSync(path.join(stateDir, projectId, `${key}.json`), "utf-8");
        insertBlob(projectId, key, JSON.parse(raw));
      } catch {}
    }
    try {
      const raw = fs.readFileSync(path.join(sessionDir, projectId, "state.json"), "utf-8");
      insertBlob(projectId, "session", JSON.parse(raw));
    } catch {}
  }
}

async function _migrateScrollPositions(db) {
  const file = path.join(PANE_DIR, "scroll-positions.json");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const positions = JSON.parse(raw.trim());
    const insertAll = db.transaction((entries) => {
      for (const [projectId, position] of entries) {
        db.stmts.upsertScroll.run(projectId, String(position), Date.now());
      }
    });
    insertAll(Object.entries(positions));
  } catch {} // file may not exist yet
}
