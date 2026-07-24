/**
 * Intents — cross-thread awareness for Pane.
 *
 * When multiple threads work on the same project root, agents need to know
 * what files other threads are touching so they don't collide — editing a
 * file that another agent is actively refactoring leads to conflicts,
 * rework, and confusion.
 *
 * How it works:
 *   1. Every file write records an "intent touch" — a lightweight marker:
 *      { _type: "intent", threadId, file, ts }
 *   2. Before writing a file, the tool executor checks: has another
 *      thread on the same root touched this file recently?
 *   3. At session start, the system prompt surfaces active peer intents.
 *   4. The UI shows indicators when peer threads are active.
 *
 * Storage: ~/.pane/session/{projectId}/intents.ndjson  (append-only NDJSON)
 *
 * Expiry: intents older than INTENT_TTL_MS (30 min) are stale. Expiry is
 * lazy — checked on read, not a background process.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".pane", "session");
const SETTINGS_PATH = path.join(os.homedir(), ".pane", "settings.json");

/** How long an intent touch remains "active" before considered stale. */
const INTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Settings cache (root → [projectId] map) ──────────────────────────────

let _rootMapCache = null;
let _rootMapCacheAt = 0;
const ROOT_MAP_CACHE_TTL = 10_000; // 10 seconds

/**
 * Build a map of root path → [projectId, ...] from settings.json.
 * Cached for 10 seconds to avoid repeated disk reads during rapid writes.
 *
 * @returns {Map<string, string[]>}
 */
function getRootMap() {
  const now = Date.now();
  if (_rootMapCache && (now - _rootMapCacheAt) < ROOT_MAP_CACHE_TTL) {
    return _rootMapCache;
  }
  const map = new Map();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      const states = settings.project_states || {};
      for (const [projectId, state] of Object.entries(states)) {
        if (state && typeof state.root === "string" && state.root) {
          let list = map.get(state.root);
          if (!list) {
            list = [];
            map.set(state.root, list);
          }
          list.push(projectId);
        }
      }
    }
  } catch { /* settings unavailable — empty map */ }
  _rootMapCache = map;
  _rootMapCacheAt = now;
  return map;
}

/** Bust the root map cache — call when project bindings change. */
export function bustRootMapCache() {
  _rootMapCache = null;
  _rootMapCacheAt = 0;
}

// ── Paths ────────────────────────────────────────────────────────────────

function getIntentsPath(projectId) {
  return path.join(SESSION_DIR, projectId, "intents.ndjson");
}

// ── Read ─────────────────────────────────────────────────────────────────

/**
 * Read all active intents for a project. Filters out expired entries.
 *
 * @param {string} projectId
 * @returns {Array<{ threadId: string, file: string, ts: number }>}
 */
export function readIntents(projectId) {
  const intentsPath = getIntentsPath(projectId);
  if (!fs.existsSync(intentsPath)) return [];

  const cutoff = Date.now() - INTENT_TTL_MS;
  const entries = [];
  try {
    const raw = fs.readFileSync(intentsPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry._type !== "intent") continue;
        if (!entry.ts || entry.ts < cutoff) continue; // expired
        entries.push({ threadId: entry.threadId, file: entry.file, ts: entry.ts });
      } catch { /* skip corrupt lines */ }
    }
  } catch { /* file doesn't exist */ }
  return entries;
}

/**
 * Get all peer projects — projects sharing the same root as `projectId`,
 * excluding `projectId` itself.
 *
 * @param {string} projectRoot — the root path of the current project
 * @param {string} ownProjectId — the current project's ID (excluded from results)
 * @returns {string[]} peer projectIds
 */
export function getPeerProjectIds(projectRoot, ownProjectId) {
  if (!projectRoot) return [];
  const rootMap = getRootMap();
  const all = rootMap.get(projectRoot) || [];
  return all.filter((id) => id !== ownProjectId);
}

/**
 * Read intents from all peer projects (same root, different projectId).
 * Returns a deduplicated list of active file touches.
 *
 * @param {string} projectRoot — the root path of the current project
 * @param {string} ownProjectId
 * @returns {Array<{ threadId: string, file: string, ts: number }>}
 */
export function readPeerIntents(projectRoot, ownProjectId) {
  const peers = getPeerProjectIds(projectRoot, ownProjectId);
  if (peers.length === 0) return [];

  const allIntents = [];
  for (const peerId of peers) {
    allIntents.push(...readIntents(peerId));
  }
  return allIntents;
}

// ── Write ────────────────────────────────────────────────────────────────

/**
 * Record an intent touch — a file that this thread is working on.
 * Idempotent: multiple touches on the same file within the TTL are fine.
 *
 * @param {string} projectId
 * @param {string} file — relative file path (from project root)
 * @param {object} [opts]
 * @param {string} [opts.action] — what the thread is doing (e.g. "editing", "refactoring")
 */
export function recordIntent(projectId, file, opts = {}) {
  const intentsPath = getIntentsPath(projectId);
  try {
    const dir = path.dirname(intentsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = {
      _type: "intent",
      threadId: projectId,
      file,
      action: opts.action || "editing",
      ts: Date.now(),
    };
    fs.appendFileSync(intentsPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[intents] Failed to record intent: ${err.message}`);
  }
}

// ── Conflict check ───────────────────────────────────────────────────────

/**
 * Check whether another active thread on the same root has recently
 * touched the given file. Returns conflict details or null.
 *
 * @param {string} projectRoot
 * @param {string} ownProjectId
 * @param {string} file — relative file path
 * @returns {{ conflicted: true, by: Array<{ threadId: string, ts: number, file: string }> } | { conflicted: false }}
 */
export function checkConflict(projectRoot, ownProjectId, file) {
  const peers = getPeerProjectIds(projectRoot, ownProjectId);
  if (peers.length === 0) return { conflicted: false };

  const conflicting = [];
  const cutoff = Date.now() - INTENT_TTL_MS;

  for (const peerId of peers) {
    const intents = readIntents(peerId);
    for (const intent of intents) {
      // Exact file match: same file touched by peer
      if (intent.file === file) {
        if (intent.ts >= cutoff) {
          conflicting.push({ threadId: intent.threadId, ts: intent.ts, file: intent.file });
        }
        continue;
      }
      // Same-directory match: if the files share the same parent directory,
      // the peer is likely working on related things (e.g., refactoring a module)
      const intentDir = intent.file.includes("/") ? intent.file.replace(/\/[^/]*$/, "") : "";
      const fileDir = file.includes("/") ? file.replace(/\/[^/]*$/, "") : "";
      if (intentDir && intentDir === fileDir) {
        if (intent.ts >= cutoff) {
          conflicting.push({ threadId: intent.threadId, ts: intent.ts, file: intent.file });
        }
      }
    }
  }

  if (conflicting.length === 0) return { conflicted: false };

  // Deduplicate by threadId (keep latest ts per thread)
  const byThread = new Map();
  for (const c of conflicting) {
    const existing = byThread.get(c.threadId);
    if (!existing || c.ts > existing.ts) {
      byThread.set(c.threadId, c);
    }
  }

  return {
    conflicted: true,
    by: [...byThread.values()],
  };
}

// ── Summary for system prompt ────────────────────────────────────────────

/**
 * Build a human-readable summary of peer thread activity for injection
 * into the system prompt. Returns null if no peers are active.
 *
 * @param {string} projectRoot
 * @param {string} ownProjectId
 * @returns {string|null}
 */
export function buildPeerSummary(projectRoot, ownProjectId) {
  const intents = readPeerIntents(projectRoot, ownProjectId);
  if (intents.length === 0) return null;

  // Group by threadId
  const byThread = new Map();
  for (const intent of intents) {
    let list = byThread.get(intent.threadId);
    if (!list) {
      list = [];
      byThread.set(intent.threadId, list);
    }
    list.push(intent.file);
  }

  const lines = [
    "## ⚠ Peer thread activity",
    "",
    "Other threads are actively working on this project. Avoid modifying files",
    "they're touching — they may be mid-refactor. If you must touch a file in",
    "their scope, surface the conflict to the user first.",
    "",
  ];

  for (const [threadId, files] of byThread) {
    const shortId = threadId.slice(0, 8);
    const fileList = [...new Set(files)].slice(0, 5).join(", ");
    const extra = files.length > 5 ? ` (+${files.length - 5} more)` : "";
    lines.push(`- Thread \`${shortId}\`: ${fileList}${extra}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Remove all expired intents from a project's intent log.
 * Called periodically (e.g. on session start) to prevent unbounded growth.
 *
 * @param {string} projectId
 */
export function pruneIntents(projectId) {
  const intentsPath = getIntentsPath(projectId);
  if (!fs.existsSync(intentsPath)) return;

  const cutoff = Date.now() - INTENT_TTL_MS;
  try {
    const raw = fs.readFileSync(intentsPath, "utf-8");
    const lines = raw.split("\n");
    const kept = [];
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry._type === "intent" && entry.ts && entry.ts < cutoff) {
          changed = true;
          continue; // drop expired
        }
        kept.push(line);
      } catch {
        changed = true;
        continue; // drop corrupt
      }
    }
    if (changed) {
      fs.writeFileSync(intentsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    }
  } catch { /* best-effort */ }
}
