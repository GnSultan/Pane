/**
 * Session Journal — the single source of truth for session state.
 *
 * The journal serves two roles:
 *   1. Append-only message log (crash-safe conversation record)
 *   2. Session state manager (replaces state.json as primary store)
 *
 * State management:
 *   - In-memory state object updated via applyDelta()
 *   - State deltas appended to journal NDJSON for crash recovery
 *   - state.json is a write-through cache, flushed on turn boundaries
 *   - readState()/mergeState() in pane-system-prompt.mjs delegate here
 *     when a journal is active (transparent to all 15+ callers)
 *
 * Global registry:
 *   - activeJournals Map tracks one journal per projectId
 *   - getActiveJournal(projectId) returns the instance or null
 *   - Other modules check the registry without holding a reference
 *
 * Format: newline-delimited JSON (NDJSON). Each line is one of:
 *   - Message entry: { role, content, ts, ... }
 *   - State delta:   { _type: "state_delta", delta, ts }
 *   - Progress:      { _type: "progress", accomplishments, decisions, ... }
 *
 * Storage: ~/.pane/session/{projectId}/journal.ndjson
 *          ~/.pane/session/{projectId}/journal-meta.json
 *          ~/.pane/session/{projectId}/state.json (write-through cache)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".pane", "session");

// ---------------------------------------------------------------------------
// Global registry — one active journal per project
// ---------------------------------------------------------------------------

const activeJournals = new Map();

/**
 * Get the active journal for a project, or null if no session is active.
 * Used by readState/mergeState to delegate transparently.
 *
 * @param {string} projectId
 * @returns {SessionJournal|null}
 */
export function getActiveJournal(projectId) {
  return activeJournals.get(projectId) || null;
}

// ---------------------------------------------------------------------------
// Default state (same shape as pane-system-prompt.mjs defaultState)
// Duplicated here to avoid circular imports.
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    activeTask: null,
    todos: [],
    workingSet: [],
    decisions: [],
    recentActions: [],
    methodNotes: [],
    gitStatus: null,
    turnCount: 0,
    lastProvider: null,
    lastIntent: null,
    startedAt: Date.now(),
    phase: "idle",
    activeSkills: [],
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getJournalDir(projectId) {
  return path.join(SESSION_DIR, projectId);
}

function getJournalPath(projectId) {
  return path.join(getJournalDir(projectId), "journal.ndjson");
}

function getMetaPath(projectId) {
  return path.join(getJournalDir(projectId), "journal-meta.json");
}

function getStatePath(projectId) {
  return path.join(SESSION_DIR, projectId, "state.json");
}

// ---------------------------------------------------------------------------
// State file I/O (direct disk — no delegation, used for cache)
// ---------------------------------------------------------------------------

function readStateFromDisk(projectId) {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(projectId), "utf-8"));
  } catch {
    return defaultState();
  }
}

async function writeStateToDisk(projectId, state) {
  const dir = getJournalDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(getStatePath(projectId), JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Shared merge logic — applies a delta to a state object in place
// ---------------------------------------------------------------------------

/**
 * Apply a partial update to a state object. Handles deduplication and caps.
 * Used by both SessionJournal.applyDelta() and the fallback mergeState().
 *
 * @param {object} state - The state to mutate
 * @param {object} delta - Partial update
 * @returns {object} The mutated state
 */
export function applyMergeDelta(state, delta) {
  // Active task: shallow merge
  if (delta.activeTask !== undefined) {
    state.activeTask = delta.activeTask
      ? { ...state.activeTask, ...delta.activeTask, timestamp: delta.activeTask.timestamp || Date.now() }
      : null;
  }

  // Working set: upsert by path, sort by touches, cap at 10
  if (delta.workingSet?.length) {
    for (const file of delta.workingSet) {
      const idx = state.workingSet.findIndex(f => f.path === file.path);
      if (idx >= 0) {
        state.workingSet[idx] = {
          ...state.workingSet[idx],
          ...file,
          touches: (state.workingSet[idx].touches || 0) + 1,
        };
      } else {
        state.workingSet.push({ ...file, touches: 1 });
      }
    }
    state.workingSet.sort((a, b) => (b.touches || 0) - (a.touches || 0));
    state.workingSet = state.workingSet.slice(0, 10);
  }

  // Decisions: prepend new, deduplicate by content prefix, cap at 8
  if (delta.decisions?.length) {
    for (const d of delta.decisions) {
      const key = d.content.slice(0, 60).toLowerCase();
      const dupe = state.decisions.some(x => x.content.slice(0, 60).toLowerCase() === key);
      if (!dupe) state.decisions.unshift({ content: d.content, timestamp: d.timestamp || Date.now() });
    }
    state.decisions = state.decisions.slice(0, 8);
  }

  // Recent actions: prepend, cap at 8
  if (delta.recentActions?.length) {
    state.recentActions = [...delta.recentActions, ...state.recentActions].slice(0, 8);
  }

  // Method notes: replace each turn
  if (delta.methodNotes?.length) {
    state.methodNotes = delta.methodNotes;
  } else if (delta.methodNotes !== undefined) {
    state.methodNotes = [];
  }

  if (delta.todos)                   state.todos = delta.todos;
  if (delta.turnCount !== undefined) state.turnCount = delta.turnCount;
  if (delta.lastProvider)            state.lastProvider = delta.lastProvider;
  if (delta.lastIntent)              state.lastIntent = delta.lastIntent;
  if (delta.gitStatus !== undefined) state.gitStatus = delta.gitStatus;
  if (delta.phase)                   state.phase = delta.phase;
  if (delta.activeSkills)            state.activeSkills = delta.activeSkills;

  return state;
}

// ---------------------------------------------------------------------------
// Journal Writer + State Manager
// ---------------------------------------------------------------------------

/**
 * Open a journal for a project session. Returns a writer object that manages
 * both the message log and the session state.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {boolean} options.fresh - If true, truncate any existing journal (new session)
 * @param {string} options.model - Model name for metadata
 * @param {string} options.provider - Provider name for metadata
 * @returns {SessionJournal}
 */
export function openJournal(projectId, options = {}) {
  // Close any existing journal for this project
  const existing = activeJournals.get(projectId);
  if (existing) {
    existing.close().catch(() => {});
  }

  const dir = getJournalDir(projectId);
  fs.mkdirSync(dir, { recursive: true });

  const journalPath = getJournalPath(projectId);
  const metaPath = getMetaPath(projectId);

  if (options.fresh) {
    try { fs.unlinkSync(journalPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
  }

  // Open file descriptor for append writes
  const fd = fs.openSync(journalPath, "a");

  // Build metadata
  const meta = {
    projectId,
    model: options.model || null,
    provider: options.provider || null,
    createdAt: Date.now(),
    lastAppendAt: Date.now(),
    messageCount: 0,
    turnCount: 0,
  };

  const existingMeta = readMeta(projectId);
  if (existingMeta && !options.fresh) {
    meta.createdAt = existingMeta.createdAt;
    meta.messageCount = existingMeta.messageCount;
    meta.turnCount = existingMeta.turnCount;
    meta.model = options.model || existingMeta.model;
    meta.provider = options.provider || existingMeta.provider;
  }

  // Initialize state: start from disk, then replay journal deltas on top
  // (catches state changes that were journaled but not flushed before crash)
  let initialState;
  if (options.fresh) {
    initialState = defaultState();
  } else {
    initialState = readStateFromDisk(projectId);
    // Replay any state deltas from the journal
    try {
      if (fs.existsSync(journalPath)) {
        const raw = fs.readFileSync(journalPath, "utf-8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry._type === "state_delta" && entry.delta) {
              applyMergeDelta(initialState, entry.delta);
            }
          } catch { /* skip corrupt lines */ }
        }
      }
    } catch { /* journal doesn't exist yet — fine */ }

    // Stale task retirement after replay — prevents timestamp-less tasks
    // that were set without a timestamp (main.mjs bug) from surviving replay.
    // Same 8-hour policy as context-orchestrator.mjs and tool-executor.mjs.
    const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000;
    if (initialState.activeTask && (!initialState.activeTask.timestamp || (Date.now() - initialState.activeTask.timestamp) > STALE_THRESHOLD_MS)) {
      initialState.activeTask = null;
    }
  }

  const journal = new SessionJournal(projectId, fd, journalPath, metaPath, meta, initialState);

  // Register in global registry
  activeJournals.set(projectId, journal);

  return journal;
}

class SessionJournal {
  constructor(projectId, fd, journalPath, metaPath, meta, initialState) {
    this.projectId = projectId;
    this._fd = fd;
    this._journalPath = journalPath;
    this._metaPath = metaPath;
    this._meta = meta;
    this._closed = false;
    this._state = initialState;
    this._stateFlushTimer = null;
    this._writing = false;      // Exclusive write lock for state.json
    this._pendingWrite = false; // Deferred write while lock was held
  }

  // ── State management ────────────────────────────────────────────────────

  /**
   * Get the current session state. Fast — returns the in-memory copy.
   * @returns {object}
   */
  getState() {
    return this._state;
  }

  /**
   * Apply a partial state update. Updates in-memory state, appends a
   * state_delta entry to the journal, and schedules a debounced flush
   * to state.json.
   *
   * @param {object} delta - Partial state update
   * @returns {object} The updated state
   */
  applyDelta(delta) {
    if (this._closed) return this._state;

    // Update in-memory state
    applyMergeDelta(this._state, delta);

    // Append delta to journal for crash recovery
    try {
      const entry = { _type: "state_delta", delta, ts: Date.now() };
      const line = JSON.stringify(entry) + "\n";
      fs.writeSync(this._fd, line);
      // No fsync for state deltas — they're recoverable from the journal
      // on replay, and fsyncing every mergeState call would be expensive
      this._meta.lastAppendAt = Date.now();
    } catch (err) {
      console.warn(`[session-journal] Failed to write state delta: ${err.message}`);
    }

    // Schedule debounced flush to state.json (2 seconds)
    this._scheduleDiskFlush();

    return this._state;
  }

  /** @private — schedule a debounced write of state to state.json */
  _scheduleDiskFlush() {
    if (this._stateFlushTimer) clearTimeout(this._stateFlushTimer);
    this._stateFlushTimer = setTimeout(() => {
      this._flushStateToDisk();
    }, 2000);
  }

  /** @private — write current state to state.json with exclusive write lock */
  _flushStateToDisk() {
    if (this._stateFlushTimer) {
      clearTimeout(this._stateFlushTimer);
      this._stateFlushTimer = null;
    }
    if (this._writing) {
      this._pendingWrite = true;
      return;
    }
    this._writing = true;
    writeStateToDisk(this.projectId, this._state)
      .catch(err => {
        console.warn(`[session-journal] Failed to flush state to disk: ${err.message}`);
      })
      .finally(() => {
        this._writing = false;
        if (this._pendingWrite) {
          this._pendingWrite = false;
          this._flushStateToDisk();
        }
      });
  }

  // ── Message logging ─────────────────────────────────────────────────────

  /**
   * Append a single message to the journal. Synchronous, fsynced.
   */
  append(message, annotation = null) {
    if (this._closed) return;

    const entry = {
      role: message.role,
      content: message.content,
      ts: Date.now(),
    };

    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    if (message.name) entry.name = message.name;
    if (message.is_error !== undefined) entry.is_error = message.is_error;
    if (annotation) entry._ann = annotation;

    try {
      const line = JSON.stringify(entry) + "\n";
      fs.writeSync(this._fd, line);
      fs.fsyncSync(this._fd);
      this._meta.messageCount++;
      this._meta.lastAppendAt = Date.now();
    } catch (err) {
      console.warn(`[session-journal] Failed to append: ${err.message}`);
    }
  }

  /**
   * Mark a turn boundary. Flushes state to disk immediately.
   */
  markTurn(turnNumber) {
    this._meta.turnCount = turnNumber;
    this._flushMeta();
    this._flushStateToDisk(); // Immediate flush at turn boundaries
  }

  /**
   * Write a progress snapshot to the journal.
   */
  writeProgress(progress) {
    if (this._closed) return;
    try {
      const entry = { _type: "progress", ts: Date.now(), ...progress };
      const line = JSON.stringify(entry) + "\n";
      fs.writeSync(this._fd, line);
      this._meta.lastAppendAt = Date.now();
    } catch (err) {
      console.warn(`[session-journal] Failed to write progress: ${err.message}`);
    }
  }

  /**
   * Close the journal. Flushes state, writes meta, unregisters from global.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    // Wait for any in-flight write to complete, then do final writes
    while (this._writing) {
      await new Promise(r => setTimeout(r, 10));
    }
    this._writing = true;
    try {
      await Promise.all([
        writeStateToDisk(this.projectId, this._state).catch(() => {}),
        fs.promises.writeFile(this._metaPath, JSON.stringify(this._meta, null, 2), "utf-8").catch(() => {}),
      ]);
    } finally {
      this._writing = false;
    }
    try { fs.closeSync(this._fd); } catch {}
    activeJournals.delete(this.projectId);
  }

  /** @private */
  _flushMeta() {
    fs.promises.writeFile(this._metaPath, JSON.stringify(this._meta, null, 2), "utf-8").catch(err => {
      console.warn(`[session-journal] Failed to flush meta: ${err.message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Journal Reader (for replay / resume)
// ---------------------------------------------------------------------------

/**
 * Read metadata for a project's journal without loading messages.
 */
export function readMeta(projectId) {
  try {
    const metaPath = getMetaPath(projectId);
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Check if a project has a resumable journal.
 */
export function canResume(projectId, options = {}) {
  const maxAge = options.maxAgeMs || 4 * 60 * 60 * 1000;
  const meta = readMeta(projectId);

  if (!meta) return { resumable: false, meta: null, staleReason: "no journal" };

  const age = Date.now() - meta.lastAppendAt;
  if (age > maxAge) {
    return { resumable: false, meta, staleReason: `journal is ${Math.round(age / 60000)}m old` };
  }

  const journalPath = getJournalPath(projectId);
  if (!fs.existsSync(journalPath)) {
    return { resumable: false, meta, staleReason: "journal file missing" };
  }

  const stat = fs.statSync(journalPath);
  if (stat.size === 0) {
    return { resumable: false, meta, staleReason: "journal is empty" };
  }

  return { resumable: true, meta, staleReason: null };
}

/**
 * Replay a journal into a messages array. Also reconstructs state from
 * state deltas for crash recovery.
 *
 * @param {string} projectId
 * @returns {{ messages: Array, progress: object|null, state: object|null, meta: object|null }}
 */
export function replay(projectId) {
  const meta = readMeta(projectId);
  const journalPath = getJournalPath(projectId);

  if (!fs.existsSync(journalPath)) {
    return { messages: [], progress: null, state: null, meta };
  }

  const messages = [];
  let lastProgress = null;
  // Start from disk state, then apply deltas on top
  const state = readStateFromDisk(projectId);

  try {
    const raw = fs.readFileSync(journalPath, "utf-8");
    const lines = raw.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        if (entry._type === "progress") {
          lastProgress = entry;
          continue;
        }

        if (entry._type === "state_delta" && entry.delta) {
          applyMergeDelta(state, entry.delta);
          continue;
        }

        // Message entry — reconstruct
        if (entry.role) {
          const msg = { role: entry.role, content: entry.content };
          if (entry.tool_call_id) msg.tool_call_id = entry.tool_call_id;
          if (entry.name) msg.name = entry.name;
          if (entry.is_error !== undefined) msg.is_error = entry.is_error;
          messages.push(msg);
        }
      } catch {
        console.warn(`[session-journal] Skipping corrupt line during replay`);
      }
    }
  } catch (err) {
    console.warn(`[session-journal] Failed to replay: ${err.message}`);
    return { messages: [], progress: null, state: null, meta };
  }

  return { messages, progress: lastProgress, state, meta };
}

/**
 * Read only the last progress entry from the journal.
 */
export function readLastProgress(projectId) {
  const journalPath = getJournalPath(projectId);
  if (!fs.existsSync(journalPath)) return null;

  try {
    const raw = fs.readFileSync(journalPath, "utf-8");
    const lines = raw.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry._type === "progress") return entry;
      } catch {
        continue;
      }
    }
  } catch {}

  return null;
}

/**
 * Delete a project's journal files.
 */
export function clearJournal(projectId) {
  try { fs.unlinkSync(getJournalPath(projectId)); } catch {}
  try { fs.unlinkSync(getMetaPath(projectId)); } catch {}
}
