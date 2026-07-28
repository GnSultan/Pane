/**
 * Intents — cross-thread awareness for Pane.
 *
 * When multiple threads work on the same project root, agents need to know
 * what other threads are doing so they don't collide. An agent editing a
 * file that another agent is actively refactoring leads to conflicts,
 * rework, and confusion.
 *
 * Two layers of awareness:
 *
 * 1. CONFLICT DETECTION (file-level, immediate)
 *    Every file write records a "file_write" activity. Before writing a
 *    file, the tool executor checks: has another thread on the same root
 *    touched this file recently? If so, surface a conflict warning.
 *
 * 2. ACTIVITY AWARENESS (session-level, continuous)
 *    Every turn start and every tool call records an "activity". This means
 *    an agent that is reading, searching, running commands, or thinking —
 *    not just writing — is still visible to peers. The system prompt
 *    surfaces what peers are doing; the pane_check_intents tool lets an
 *    agent query it on demand.
 *
 * Storage: ~/.pane/session/{projectId}/intents.ndjson  (append-only NDJSON)
 *
 * Record formats (both in the same file):
 *   { _type: "activity", threadId, ts, activityType, tool?, file?, detail? }
 *   { _type: "intent",   threadId, file, ts, action }  (legacy, still written)
 *
 * Expiry: activities older than ACTIVITY_TTL_MS (30 minutes) are stale.
 * File-write intents (for conflict detection) use the same TTL.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".pane", "session");
const SETTINGS_PATH = path.join(os.homedir(), ".pane", "settings.json");

/**
 * How long an activity remains "active" before considered stale.
 * 2 hours — real work involves long planning/reading phases between writes.
 * An agent that wrote a file 45 minutes ago and is now reading/planning
 * is still actively working on this project.
 */
const ACTIVITY_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Max prompt excerpt length stored in turn_start activities. */
const MAX_PROMPT_EXCERPT = 200;

/** Max activities kept per thread after pruning (prevents unbounded growth). */
const MAX_ACTIVITIES = 500;

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

// ── Write ────────────────────────────────────────────────────────────────

/**
 * Record an activity — a rich signal about what this thread is doing.
 *
 * This is the primary API for the activity-awareness layer. Call it on:
 *   - Turn start (heartbeat + user prompt excerpt)
 *   - Every tool call (tool name + affected files)
 *   - File writes (also writes legacy intent for conflict detection)
 *
 * @param {string} projectId
 * @param {object} opts
 * @param {string} opts.activityType — "turn_start" | "tool_call" | "file_write"
 * @param {string} [opts.tool] — tool name (for tool_call/file_write)
 * @param {string} [opts.file] — primary file path, relative to project root
 * @param {string[]} [opts.files] — additional file paths (e.g. grep results)
 * @param {string} [opts.detail] — short human-readable description
 */
export function recordActivity(projectId, opts = {}) {
  const intentsPath = getIntentsPath(projectId);
  try {
    const dir = path.dirname(intentsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const ts = Date.now();
    const entry = {
      _type: "activity",
      threadId: projectId,
      ts,
      activityType: opts.activityType || "tool_call",
    };
    if (opts.tool) entry.tool = opts.tool;
    if (opts.file) entry.file = opts.file;
    if (opts.files && opts.files.length > 0) entry.files = opts.files.slice(0, 10);
    if (opts.detail) entry.detail = String(opts.detail).slice(0, MAX_PROMPT_EXCERPT);
    fs.appendFileSync(intentsPath, JSON.stringify(entry) + "\n", "utf-8");

    // Also write legacy intent record for file writes (conflict detection)
    if (opts.activityType === "file_write" && opts.file) {
      const legacy = {
        _type: "intent",
        threadId: projectId,
        file: opts.file,
        action: opts.tool || "editing",
        ts,
      };
      fs.appendFileSync(intentsPath, JSON.stringify(legacy) + "\n", "utf-8");
    }
  } catch (err) {
    console.warn(`[intents] Failed to record activity: ${err.message}`);
  }
}

/**
 * Record a file-write intent. Backward-compatible wrapper around recordActivity.
 * Kept because tool-executor.mjs calls it directly for conflict detection.
 *
 * @param {string} projectId
 * @param {string} file — relative file path (from project root)
 * @param {object} [opts]
 * @param {string} [opts.action] — what the thread is doing (e.g. "editing", "refactoring")
 */
export function recordIntent(projectId, file, opts = {}) {
  recordActivity(projectId, {
    activityType: "file_write",
    tool: opts.action || "editing",
    file,
  });
}

// ── Read: activity layer ─────────────────────────────────────────────────

/**
 * Read all active activities for a project. Filters out expired entries.
 * Handles both new (_type: "activity") and legacy (_type: "intent") records.
 *
 * @param {string} projectId
 * @returns {Array<object>} — normalized activity objects
 */
export function readActivities(projectId) {
  const intentsPath = getIntentsPath(projectId);
  if (!fs.existsSync(intentsPath)) return [];

  const cutoff = Date.now() - ACTIVITY_TTL_MS;
  const entries = [];
  try {
    const raw = fs.readFileSync(intentsPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.ts || entry.ts < cutoff) continue; // expired

        if (entry._type === "activity") {
          entries.push({
            threadId: entry.threadId,
            ts: entry.ts,
            activityType: entry.activityType,
            tool: entry.tool || null,
            file: entry.file || null,
            files: entry.files || null,
            detail: entry.detail || null,
          });
        } else if (entry._type === "intent") {
          // Legacy: normalize to activity shape
          entries.push({
            threadId: entry.threadId,
            ts: entry.ts,
            activityType: "file_write",
            tool: entry.action || "editing",
            file: entry.file,
            files: null,
            detail: null,
          });
        }
      } catch { /* skip corrupt lines */ }
    }
  } catch { /* file doesn't exist */ }
  return entries;
}

/**
 * Check if two paths overlap — either is an ancestor/descendant of the other,
 * or they're identical. Handles monorepo layouts where one project root is
 * the repo root and another is a subdirectory (e.g. /repo + /repo/apps/web).
 *
 * The trailing "/" check prevents false positives like /foo/bar matching
 * /foo/barbecue.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function pathsOverlap(a, b) {
  if (a === b) return true;
  // Normalize without trailing slashes for comparison
  const normA = a.endsWith("/") ? a.slice(0, -1) : a;
  const normB = b.endsWith("/") ? b.slice(0, -1) : b;
  return normA.startsWith(normB + "/") || normB.startsWith(normA + "/");
}

/**
 * Get all peer projects — projects whose root overlaps ours (same root,
 * or an ancestor/descendant of it). This handles monorepo layouts where
 * sub-projects nest inside a parent project root.
 *
 * @param {string} projectRoot — the root path of the current project
 * @param {string} ownProjectId — the current project's ID (excluded from results)
 * @returns {string[]} peer projectIds
 */
export function getPeerProjectIds(projectRoot, ownProjectId) {
  if (!projectRoot) return [];
  const rootMap = getRootMap();
  const peers = new Set();

  for (const [root, projectIds] of rootMap.entries()) {
    if (pathsOverlap(root, projectRoot)) {
      for (const id of projectIds) {
        if (id !== ownProjectId) peers.add(id);
      }
    }
  }

  return [...peers];
}

/**
 * Read activities from all peer projects (same root, different projectId).
 * Returns a combined list, sorted by ts descending (most recent first).
 *
 * @param {string} projectRoot — the root path of the current project
 * @param {string} ownProjectId
 * @returns {Array<object>} — activity objects from peers
 */
export function readPeerActivity(projectRoot, ownProjectId) {
  const peers = getPeerProjectIds(projectRoot, ownProjectId);
  if (peers.length === 0) return [];

  const all = [];
  for (const peerId of peers) {
    all.push(...readActivities(peerId));
  }
  all.sort((a, b) => b.ts - a.ts);
  return all;
}

/**
 * Read activities from all peer projects, grouped by thread.
 * Each thread gets its most recent activity (heartbeat) and a deduplicated
 * list of files it has touched.
 *
 * @param {string} projectRoot
 * @param {string} ownProjectId
 * @returns {Map<string, { threadId: string, lastActivity: number, task: string|null, files: string[], tools: string[] }>}
 */
export function readPeerActivityGrouped(projectRoot, ownProjectId) {
  const activities = readPeerActivity(projectRoot, ownProjectId);
  const byThread = new Map();

  for (const act of activities) {
    let entry = byThread.get(act.threadId);
    if (!entry) {
      entry = {
        threadId: act.threadId,
        lastActivity: act.ts,
        task: null,
        files: [],
        tools: [],
      };
      byThread.set(act.threadId, entry);
    }

    // Track most recent timestamp
    if (act.ts > entry.lastActivity) entry.lastActivity = act.ts;

    // Track the most recent turn_start detail as the "task" description
    if (act.activityType === "turn_start" && act.detail) {
      entry.task = act.detail;
    }

    // Collect unique files
    if (act.file && !entry.files.includes(act.file)) {
      entry.files.push(act.file);
    }
    if (act.files) {
      for (const f of act.files) {
        if (f && !entry.files.includes(f)) entry.files.push(f);
      }
    }

    // Collect unique tools
    if (act.tool && !entry.tools.includes(act.tool)) {
      entry.tools.push(act.tool);
    }
  }

  return byThread;
}

// ── Read: file-intent layer (for conflict detection) ─────────────────────

/**
 * Read all active file-write intents for a project. Filters out expired entries.
 * Used by conflict detection — only considers file writes, not all activity.
 *
 * @param {string} projectId
 * @returns {Array<{ threadId: string, file: string, ts: number }>}
 */
export function readIntents(projectId) {
  const activities = readActivities(projectId);
  return activities
    .filter((a) => a.activityType === "file_write" && a.file)
    .map((a) => ({ threadId: a.threadId, file: a.file, ts: a.ts }));
}

/**
 * Read file-write intents from all peer projects (same root, different projectId).
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
  const cutoff = Date.now() - ACTIVITY_TTL_MS;

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

function formatAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
}

/**
 * Build a human-readable summary of peer thread activity for injection
 * into the system prompt. Returns null if no peers are active.
 *
 * This replaces the old buildPeerSummary — it shows what peers are DOING
 * (task, tools, files), not just what files they've written.
 *
 * @param {string} projectRoot
 * @param {string} ownProjectId
 * @returns {string|null}
 */
export function buildPeerSummary(projectRoot, ownProjectId) {
  const grouped = readPeerActivityGrouped(projectRoot, ownProjectId);
  if (grouped.size === 0) return null;

  const lines = [
    "## ⚠ Peer thread activity",
    "",
    "Other threads are actively working on this project root. Before modifying",
    "a file, consider whether a peer thread might be working on the same area.",
    "If you must touch a file in their scope, surface the conflict to the user.",
    "",
  ];

  for (const [, entry] of grouped) {
    const shortId = entry.threadId.slice(0, 8);
    const ago = formatAgo(entry.lastActivity);
    const fileList = entry.files.slice(0, 5).join(", ");
    const extraFiles = entry.files.length > 5 ? ` (+${entry.files.length - 5} more)` : "";
    const toolList = entry.tools.slice(0, 5).join(", ");

    lines.push(`- Thread \`${shortId}\` (active ${ago}):`);
    if (entry.task) {
      lines.push(`  Task: ${entry.task}`);
    }
    if (toolList) {
      lines.push(`  Tools: ${toolList}`);
    }
    if (fileList) {
      lines.push(`  Files: ${fileList}${extraFiles}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Remove all expired entries from a project's intent/activity log.
 * Also caps the file to MAX_ACTIVITIES most recent entries.
 * Called periodically (e.g. on session start) to prevent unbounded growth.
 *
 * @param {string} projectId
 */
export function pruneIntents(projectId) {
  const intentsPath = getIntentsPath(projectId);
  if (!fs.existsSync(intentsPath)) return;

  const cutoff = Date.now() - ACTIVITY_TTL_MS;
  try {
    const raw = fs.readFileSync(intentsPath, "utf-8");
    const lines = raw.split("\n");
    const kept = [];
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.ts && entry.ts < cutoff) {
          changed = true;
          continue; // drop expired
        }
        kept.push(line);
      } catch {
        changed = true;
        continue; // drop corrupt
      }
    }
    // Cap to most recent MAX_ACTIVITIES entries
    if (kept.length > MAX_ACTIVITIES) {
      kept.splice(0, kept.length - MAX_ACTIVITIES);
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(intentsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    }
  } catch { /* best-effort */ }
}
