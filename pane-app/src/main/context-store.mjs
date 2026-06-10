/**
 * Context Store — reactive in-memory context state, replaces file-based IPC.
 *
 * Brain-engine writes contextual exports here instead of to disk.
 * Context-orchestrator reads from here instead of fs.readFileSync.
 * Disk serialization is debounced (5s) and only used for crash recovery.
 *
 * This eliminates the staleness window where brain-engine writes a JSON file
 * and the orchestrator reads a stale snapshot turns later.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const BRAIN_DIR = path.join(os.homedir(), ".pane", "brain");
const CONTEXT_DIR = path.join(BRAIN_DIR, "context");

// Debounce timer per project for disk serialization
const DISK_DEBOUNCE_MS = 5000;

class ContextStore extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, ProjectContext>} */
    this._projects = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._diskTimers = new Map();
  }

  /**
   * Get the current context for a project.
   * Returns null if no context has been written yet (cold start).
   * @param {string} projectId
   * @returns {ProjectContext | null}
   */
  getContext(projectId) {
    return this._projects.get(projectId) || null;
  }

  /**
   * Update the brain export for a project (memories, atoms, symbols, etc.).
   * Called by brain-engine's writeContextualExport() instead of fs.writeFileSync.
   * @param {string} projectId
   * @param {object} brainExport
   */
  updateBrainExport(projectId, brainExport) {
    const ctx = this._getOrCreate(projectId);
    ctx.brainExport = brainExport;
    ctx.lastUpdated = Date.now();
    ctx.version++;
    this.emit("brain-updated", projectId, ctx);
    this._scheduleDiskWrite(projectId);
  }

  /**
   * Update the context shape (taskType, complexity, escalation, etc.).
   * Called by punk-engine instead of fs.writeFile for shape JSON.
   * @param {string} projectId
   * @param {object} shape
   */
  updateContextShape(projectId, shape) {
    const ctx = this._getOrCreate(projectId);
    ctx.contextShape = shape;
    ctx.lastUpdated = Date.now();
    ctx.version++;
    this.emit("shape-updated", projectId, ctx);
    this._scheduleDiskWrite(projectId);
  }

  /**
   * Force-invalidate a project's context, triggering rebuild on next read.
   * Called after task completion propagation.
   * @param {string} projectId
   */
  invalidateProject(projectId) {
    const ctx = this._projects.get(projectId);
    if (ctx) {
      ctx.version++;
      ctx.lastUpdated = Date.now();
      this.emit("invalidated", projectId, ctx);
    }
  }

  /**
   * Subscribe to context changes for a project. Returns unsubscribe function.
   * @param {string} projectId
   * @param {(ctx: ProjectContext) => void} callback
   * @returns {() => void}
   */
  onContextChange(projectId, callback) {
    const handler = (pid, ctx) => {
      if (pid === projectId) callback(ctx);
    };
    this.on("brain-updated", handler);
    this.on("shape-updated", handler);
    this.on("invalidated", handler);
    return () => {
      this.off("brain-updated", handler);
      this.off("shape-updated", handler);
      this.off("invalidated", handler);
    };
  }

  /**
   * Write current in-memory state to disk for crash recovery.
   * Called on debounced timer and on graceful shutdown.
   * @param {string} projectId
   */
  async serializeToDisk(projectId) {
    const ctx = this._projects.get(projectId);
    if (!ctx) return;

    try {
      await fsp.mkdir(CONTEXT_DIR, { recursive: true });

      const writes = [];
      if (ctx.brainExport) {
        writes.push(
          fsp.writeFile(
            path.join(CONTEXT_DIR, `${projectId}.json`),
            JSON.stringify(ctx.brainExport),
          ),
        );
      }

      if (ctx.contextShape) {
        writes.push(
          fsp.writeFile(
            path.join(CONTEXT_DIR, `${projectId}-shape.json`),
            JSON.stringify(ctx.contextShape),
          ),
        );
      }

      await Promise.all(writes);
    } catch (err) {
      console.warn(`[context-store] disk write failed for ${projectId}:`, err.message);
    }
  }

  /**
   * Restore context from disk on cold start (app launch, first request).
   * Falls back gracefully if files don't exist.
   * @param {string} projectId
   */
  restoreFromDisk(projectId) {
    if (this._projects.has(projectId)) return; // already in memory

    const ctx = this._getOrCreate(projectId);

    try {
      const raw = fs.readFileSync(path.join(CONTEXT_DIR, `${projectId}.json`), "utf-8");
      ctx.brainExport = JSON.parse(raw);
    } catch {}

    try {
      const raw = fs.readFileSync(path.join(CONTEXT_DIR, `${projectId}-shape.json`), "utf-8");
      ctx.contextShape = JSON.parse(raw);
    } catch {}

    ctx.lastUpdated = Date.now();
  }

  /**
   * Flush all pending disk writes. Called on graceful shutdown.
   */
  async flushAll() {
    const writes = [];
    for (const [projectId, timer] of this._diskTimers) {
      clearTimeout(timer);
      writes.push(this.serializeToDisk(projectId));
    }
    this._diskTimers.clear();
    await Promise.all(writes).catch((err) => {
      console.warn("[context-store] flushAll failed:", err.message);
    });
  }

  /**
   * Clear context for a project (e.g., project deleted).
   * @param {string} projectId
   */
  clear(projectId) {
    this._projects.delete(projectId);
    const timer = this._diskTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this._diskTimers.delete(projectId);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Get the last-injected snapshot for delta tracking.
   * Returns null if no context has been assembled yet (turn 1).
   * @param {string} projectId
   * @returns {LastInjected | null}
   */
  getLastInjected(projectId) {
    return this._projects.get(projectId)?.lastInjected || null;
  }

  /**
   * Save a snapshot of what was injected this turn.
   * Context-orchestrator calls this after assembling turn 1 context.
   * On subsequent turns, buildLayers compares current state against this.
   * @param {string} projectId
   * @param {LastInjected} snapshot
   */
  updateLastInjected(projectId, snapshot) {
    const ctx = this._getOrCreate(projectId);
    ctx.lastInjected = snapshot;
  }

  /**
   * Get stored turn summaries for a project.
   * Returns an empty array if none exist yet.
   * @param {string} projectId
   * @returns {Array<TurnSummaryRecord>}
   */
  getTurnSummaries(projectId) {
    const ctx = this._projects.get(projectId);
    return ctx?.turnSummaries || [];
  }

  /**
   * Replace all turn summaries for a project.
   * @param {string} projectId
   * @param {Array<TurnSummaryRecord>} summaries
   */
  updateTurnSummaries(projectId, summaries) {
    const ctx = this._getOrCreate(projectId);
    ctx.turnSummaries = summaries;
    ctx.lastUpdated = Date.now();
    ctx.version++;
  }

  _getOrCreate(projectId) {
    let ctx = this._projects.get(projectId);
    if (!ctx) {
      ctx = {
        brainExport: null,
        contextShape: null,
        lastInjected: null,
        turnSummaries: null,
        lastUpdated: Date.now(),
        version: 0,
      };
      this._projects.set(projectId, ctx);
    }
    return ctx;
  }

  _scheduleDiskWrite(projectId) {
    const existing = this._diskTimers.get(projectId);
    if (existing) clearTimeout(existing);

    this._diskTimers.set(
      projectId,
      setTimeout(() => {
        this._diskTimers.delete(projectId);
        this.serializeToDisk(projectId).catch((err) => {
          console.warn(`[context-store] scheduled disk write failed for ${projectId}:`, err.message);
        });
      }, DISK_DEBOUNCE_MS),
    );
  }
}

/**
 * @typedef {object} ProjectContext
 * @property {object | null} brainExport - Full brain contextual export (memories, atoms, symbols, synthesis, etc.)
 * @property {object | null} contextShape - Routing shape (taskType, complexity, escalationStage, etc.)
 * @property {LastInjected | null} lastInjected - Snapshot of what was injected on the last full assembly
 * @property {number} lastUpdated - Timestamp of last write
 * @property {number} version - Monotonic counter, incremented on every write
 */

/**
 * @typedef {object} LastInjected
 * @property {Set<string>} memoryIds - IDs of memories injected into context
 * @property {Set<string>} symbolNames - Symbol names injected into context
 * @property {string} gitSummary - Git status summary that was injected
 * @property {string} todoSnapshot - Serialized active todo state
 * @property {string} directiveText - The intent directive text that was set
 * @property {number} turnNumber - Turn this snapshot was taken on
 */

/**
 * @typedef {object} TurnSummaryRecord
 * @property {number} turnIndex - Sequential turn number
 * @property {string} request - First 300 chars of user message
 * @property {string[]} tools - Unique tool names used this turn
 * @property {string} conclusion - Last assistant text, truncated to 250 chars
 * @property {string} compressedText - Full extractive summary marker text
 * @property {number} tokenCount - Estimated tokens in compressed text
 * @property {number} rawTokenCount - Estimated tokens in original turn (before compression)
 * @property {Float32Array|null} embedding - 768-dim embedding, lazily filled
 */

// Singleton instance — shared across all modules in the main process
export const contextStore = new ContextStore();
