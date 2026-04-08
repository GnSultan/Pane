/**
 * Tool Result Cache — stores raw tool results on disk, serves summaries to messages.
 *
 * The problem this solves: raw tool results (file contents, shell output, grep
 * results) are the largest content in the conversation. Every turn re-sends
 * them through the API at ~$1-3 per 1M tokens. By caching results on disk and
 * replacing early turns' content with 1-line summaries, we keep the
 * conversation going without growing costs linearly.
 *
 * Storage: ~/.pane/cache/{projectId}/turns/{turnIndex}/{seq}.json
 *
 * Lifecycle:
 *   1. After tool execution → storeRaw() caches the full result
 *   2. On context pressure → summarize() replaces messages[] content with summary
 *   3. On session resume → restore() can reload exact results if needed
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const CACHE_DIR = path.join(PANE_DIR, "cache");

/**
 * Get the cache directory for a project + turn.
 * @param {string} projectId
 * @param {number} turnIndex
 * @returns {string}
 */
function getTurnDir(projectId, turnIndex) {
  return path.join(CACHE_DIR, projectId, "turns", String(turnIndex));
}

/**
 * Ensure a directory exists.
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Store a raw tool result on disk.
 * @param {string} projectId
 * @param {number} turnIndex
 * @param {number} seq - Sequence number within the turn (0, 1, 2, ...)
 * @param {object} entry - { toolName, toolId, content, summary }
 */
export function storeRaw(projectId, turnIndex, seq, entry) {
  const dir = getTurnDir(projectId, turnIndex);
  ensureDir(dir);
  const filePath = path.join(dir, `${seq}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * Generate a 1-line summary from raw tool content.
 * Extracts the first meaningful line or truncates to ~120 chars.
 * @param {string} toolName
 * @param {string} rawContent
 * @returns {string}
 */
export function summarize(toolName, rawContent) {
  if (!rawContent) return `(${toolName}: empty result)`;

  // For file reads, show file path + line count
  const lines = rawContent.split("\n");
  if (lines.length > 3) {
    // Try to find a filename or meaningful first line
    const firstMeaningful = lines.find((l) => l.trim().length > 0) || "";
    const truncated =
      firstMeaningful.length > 100
        ? firstMeaningful.slice(0, 100) + "..."
        : firstMeaningful;
    return `(${toolName}: ${lines.length} lines) ${truncated}`;
  }

  // Short content — return as-is truncated
  if (rawContent.length <= 120) return `(${toolName}) ${rawContent}`;
  return `(${toolName}) ${rawContent.slice(0, 117)}...`;
}

/**
 * Build a summary for a tool message and optionally cache the raw version.
 * This is the main entry point: call this after tool execution to get the
 * content that should go into messages[]. If `cache` is true, also stores
 * the full result on disk for potential restoration.
 *
 * @param {string} projectId
 * @param {number} turnIndex
 * @param {number} seq
 * @param {object} entry - { toolName, toolId, content }
 * @param {{ cache?: boolean }} options
 * @returns {{ summary: string, cached: boolean }}
 */
export function buildSummary(projectId, turnIndex, seq, entry, options = {}) {
  const { cache = true } = options;
  const summary = summarize(entry.toolName, entry.content);

  if (cache) {
    try {
      storeRaw(projectId, turnIndex, seq, {
        toolName: entry.toolName,
        toolId: entry.toolId,
        content: entry.content,
        summary,
      });
    } catch (err) {
      console.warn(`[tool-result-cache] Failed to cache: ${err.message}`);
    }
  }

  return { summary, cached: cache };
}

/**
 * Restore a raw tool result from disk.
 * @param {string} projectId
 * @param {number} turnIndex
 * @param {number} seq
 * @returns {{ toolName: string, toolId: string, content: string, summary: string } | null}
 */
export function restoreRaw(projectId, turnIndex, seq) {
  try {
    const filePath = path.join(
      getTurnDir(projectId, turnIndex),
      `${seq}.json`,
    );
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.warn(`[tool-result-cache] Failed to restore: ${err.message}`);
  }
  return null;
}

/**
 * Clear cache for a project (all turns).
 * @param {string} projectId
 */
export function clearCache(projectId) {
  const projectDir = path.join(CACHE_DIR, projectId);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Clear cache older than N turns for a project.
 * @param {string} projectId
 * @param {number} keepTurns - Number of recent turns to keep
 */
export function pruneOldTurns(projectId, keepTurns = 10) {
  const turnsDir = path.join(CACHE_DIR, projectId, "turns");
  if (!fs.existsSync(turnsDir)) return;

  const entries = fs.readdirSync(turnsDir)
    .filter((e) => /^\d+$/.test(e))
    .map(Number)
    .sort((a, b) => b - a); // newest first

  for (const turnIdx of entries.slice(keepTurns)) {
    const dir = path.join(turnsDir, String(turnIdx));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
