/**
 * Root-Scope Resolution — the shared identity layer for multi-thread projects.
 *
 * When multiple threads share the same root directory, they are one project.
 * Memory (decisions, lessons, patterns, fixes), about, and brief should be
 * shared — a new thread on an existing project inherits everything.
 *
 * This module resolves a thread's projectId to the full set of sibling
 * thread IDs that share the same root directory. Queries that fan out
 * across siblings produce root-scoped memory — one brain per project,
 * not per thread.
 *
 * Used by: brain-engine.mjs (brain worker), pane-system-prompt.mjs (compileContext),
 * memory-direct.mjs (mutations), http-backend.mjs.
 *
 * Safe in both the main process and UtilityProcess workers — only uses
 * node:fs and node:path, no Electron dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".pane", "settings.json");

// ── Cache ────────────────────────────────────────────────────────────────
// The root map is rebuilt at most every 10 seconds. This avoids re-reading
// settings.json on every query while still picking up newly created threads
// within a reasonable window.

let _rootMapCache = null;
let _rootMapCacheAt = 0;
const ROOT_MAP_CACHE_TTL = 10_000; // 10 seconds

/**
 * Build a map of root path → [projectId, ...] from settings.json.
 * Cached for ROOT_MAP_CACHE_TTL to avoid repeated disk reads.
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

/**
 * Bust the root map cache — call when project bindings change
 * (new thread created, project rebound, etc.).
 */
export function bustRootScopeCache() {
  _rootMapCache = null;
  _rootMapCacheAt = 0;
}

/**
 * Resolve the full set of project IDs that share the same root directory
 * as the given projectId. Always includes the input projectId itself.
 *
 * For single-thread projects, returns [projectId].
 * For multi-thread projects, returns all sibling IDs.
 * For unbound threads (no root), returns [projectId].
 *
 * @param {string} projectId — the current thread's project ID
 * @returns {string[]} — array of all sibling project IDs (including input)
 */
export function resolveProjectScope(projectId) {
  if (!projectId) return [];
  const rootMap = getRootMap();
  for (const siblings of rootMap.values()) {
    if (siblings.includes(projectId)) {
      return siblings;
    }
  }
  // Not found in root map (unbound thread, or settings not yet loaded)
  return [projectId];
}

/**
 * Build a SQL IN-clause placeholder string for the resolved project scope.
 *
 * Usage:
 *   const scope = resolveProjectScopeSql(projectId);
 *   const rows = db.prepare(`SELECT * FROM nodes WHERE project_id IN (${scope.placeholders})`).all(...scope.ids);
 *
 * @param {string} projectId
 * @returns {{ placeholders: string, ids: string[] }}
 */
export function resolveProjectScopeSql(projectId) {
  const ids = resolveProjectScope(projectId);
  const placeholders = ids.map(() => "?").join(", ");
  return { placeholders, ids };
}
