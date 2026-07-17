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
 *
 * In-memory layer (ToolResultStore):
 *   Messages[] stores lightweight envelopes (summary + _resultRef pointer).
 *   ToolResultStore caches full content in a bounded LRU (50MB default),
 *   falling back to disk on miss. Fresh turns resolve pointers at API request time.
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

  // Type guard — tool results can be objects (pane_read_files, pane_directory, etc.)
  if (typeof rawContent !== "string") {
    rawContent =
      typeof rawContent === "object"
        ? JSON.stringify(rawContent)
        : String(rawContent ?? "");
  }

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
 * Prune old turns cache — keep only the most recent N.
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

// ============================================================================
// ToolResultStore — In-memory LRU cache for tool result content
// ============================================================================
//
// The messages[] array in http-backend.mjs stores lightweight envelopes
// (summaries + _resultRef pointers) instead of full raw content. Full content
// lives here in a bounded in-memory cache, backed by the existing disk store.
//
// Fresh turns resolve pointers to full content at API request time.
// Non-fresh turns use the summary that's already in the envelope.
// Disk fallback ensures no data loss on cold start.
//
// Memory cap: 50MB by default — unbounded growth down to bounded LRU.

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

export class ToolResultStore {
  constructor(maxMemoryBytes = DEFAULT_MAX_BYTES) {
    this._maxBytes = maxMemoryBytes;
    this._cache = new Map();
    this._totalBytes = 0;
    this._hits = 0;
    this._misses = 0;
  }

  /** Internal: build cache key from projectId + turn + seq */
  _key(projectId, turn, seq) {
    return `${projectId}:t${turn}:s${seq}`;
  }

  /**
   * Store a tool result in memory. Disk persistence is handled separately
   * by the caller via buildSummary() — this only manages the LRU cache.
   * @param {string} projectId
   * @param {number} turn
   * @param {number} seq
   * @param {{ toolName: string, toolId: string, content: string }} entry
   */
  store(projectId, turn, seq, { toolName, toolId, content }) {
    const key = this._key(projectId, turn, seq);
    const size = typeof content === "string" ? content.length : JSON.stringify(content).length;

    this._cache.set(key, {
      toolName,
      toolId,
      content,
      size,
      lastAccess: Date.now(),
    });
    this._totalBytes += size;
    this._evictIfNeeded();
  }

  /**
   * Resolve full content for a _resultRef pointer.
   * Memory hit → return from cache. Miss → fallback to disk (restoreRaw).
   * @param {string} projectId
   * @param {number} turn
   * @param {number} seq
   * @returns {string|null} The full raw content, or null if not found
   */
  resolve(projectId, turn, seq) {
    const key = this._key(projectId, turn, seq);
    const cached = this._cache.get(key);

    if (cached) {
      cached.lastAccess = Date.now();
      this._hits++;
      return cached.content;
    }

    this._misses++;
    // Fallback to disk
    try {
      const raw = restoreRaw(projectId, turn, seq);
      if (raw && typeof raw.content === "string") {
        const size = raw.content.length;
        this._cache.set(key, {
          toolName: raw.toolName,
          toolId: raw.toolId,
          content: raw.content,
          size,
          lastAccess: Date.now(),
        });
        this._totalBytes += size;
        this._evictIfNeeded();
        return raw.content;
      }
    } catch {
      // Non-fatal — summary in messages[] is sufficient for non-fresh turns
    }
    return null;
  }

  /**
   * Evict a specific entry from memory (keeps disk copy intact).
   */
  evict(projectId, turn, seq) {
    const key = this._key(projectId, turn, seq);
    const entry = this._cache.get(key);
    if (entry) {
      this._cache.delete(key);
      this._totalBytes -= entry.size;
    }
  }

  /**
   * Clear all in-memory entries for a project.
   */
  clearMemory(projectId) {
    const prefix = `${projectId}:`;
    for (const [key, entry] of this._cache) {
      if (key.startsWith(prefix)) {
        this._cache.delete(key);
        this._totalBytes -= entry.size;
      }
    }
  }

  /** Evict oldest entries until under the memory cap (LRU). */
  _evictIfNeeded() {
    while (this._totalBytes > this._maxBytes && this._cache.size > 0) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._cache) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        const entry = this._cache.get(oldestKey);
        this._totalBytes -= entry.size;
        this._cache.delete(oldestKey);
      }
    }
  }

  /** Current memory usage in bytes */
  get memoryBytes() { return this._totalBytes; }

  /** Number of entries in the in-memory cache */
  get entryCount() { return this._cache.size; }

  /** Hit/miss stats for monitoring */
  get stats() {
    return {
      hits: this._hits,
      misses: this._misses,
      entries: this._cache.size,
      bytes: this._totalBytes,
      maxBytes: this._maxBytes,
    };
  }
}

/** Singleton instance shared across all modules */
export const toolResultCache = new ToolResultStore();
