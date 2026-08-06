/**
 * Memory Direct — bypasses the brain worker IPC for memory mutations.
 *
 * Root cause of the original timeout: The brain worker is a single-threaded
 * UtilityProcess. When delete_memory/update_memory messages arrive, they queue
 * behind ONNX inference (contextual_search, index_events, fillNullEmbeddings)
 * and pipeline recycles (_recyclePipeline reloads a 416MB model). These block
 * the JS event loop for 5-15+ seconds. The tool-executor's 15s timeout fires
 * before the message is even read from the queue.
 *
 * Fix: Memory mutations (delete, update) are simple SQLite operations (<5ms).
 * Open a direct read-write connection to brain.db from the main process.
 * SQLite handles concurrent access via WAL mode — the brain worker has its
 * own connection, and this module opens a separate one. WAL allows multiple
 * readers + one writer concurrently without blocking.
 *
 * The brain worker is notified after the mutation so it can update its
 * search exports and re-embed if needed — but the mutation itself succeeds
 * immediately, without waiting for the worker.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const BRAIN_DIR = path.join(os.homedir(), ".pane", "brain");
const BRAIN_DB_PATH = path.join(BRAIN_DIR, "brain.db");
const EXPORTS_DIR = path.join(BRAIN_DIR, "exports");

let _db = null;

/**
 * Open a direct connection to brain.db in WAL mode.
 * Safe to call multiple times — returns the cached connection.
 */
function getDirectBrainDb() {
  if (_db) return _db;

  // Ensure the DB file exists (brain worker creates it on first run)
  if (!fs.existsSync(BRAIN_DB_PATH)) {
    throw new Error("brain.db not found — brain worker hasn't initialized yet");
  }

  _db = new Database(BRAIN_DB_PATH, {
    // readonly: false — we need write access for mutations
    // WAL mode is already set by brain-engine.mjs; opening a second connection
    // in WAL mode is safe and standard SQLite practice.
  });
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000"); // Wait up to 5s if brain worker holds a write lock

  return _db;
}

/**
 * Delete a memory node by approximate content match.
 * Mirrors brain-engine.mjs's delete_memory handler exactly.
 *
 * @param {string} projectId - project ID
 * @param {string} content - approximate content to match (first 60 chars used for LIKE)
 * @param {string|null} type - optional entity_type filter
 * @returns {{ success: boolean, nodeId?: string, deletedType?: string, error?: string }}
 */
export function directDeleteMemory(projectId, content, type = null) {
  try {
    const db = getDirectBrainDb();

    const nodeType = type || null;
    const searchClause = nodeType ? "AND entity_type = ?" : "";
    const params = nodeType
      ? [projectId, `%${content.slice(0, 60)}%`, nodeType]
      : [projectId, `%${content.slice(0, 60)}%`];

    const nodes = db.prepare(
      `SELECT * FROM nodes WHERE project_id = ? AND content LIKE ? ${searchClause}
       AND entity_type IN ('decision', 'lesson', 'pattern', 'error_fix')
       ORDER BY confidence DESC LIMIT 5`
    ).all(...params);

    if (nodes.length === 0) {
      return { success: false, error: "No existing memory matching that content found." };
    }

    const node = nodes[0];
    db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(node.id, node.id);
    db.prepare("DELETE FROM node_versions WHERE node_id = ?").run(node.id);
    db.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);

    // Trigger search export refresh in background (non-blocking)
    refreshSearchExport(db, projectId);

    return { success: true, nodeId: node.id, deletedType: node.entity_type };
  } catch (err) {
    console.error("[memory-direct] directDeleteMemory failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Update a memory node's content in place.
 * Mirrors brain-engine.mjs's update_memory handler, but the re-embedding
 * is left to the brain worker (notified via brainRequest).
 *
 * @param {string} projectId - project ID
 * @param {string} oldContent - approximate old content to match (first 60 chars used for LIKE)
 * @param {string} newContent - new content to replace with
 * @param {string|null} type - optional entity_type filter
 * @returns {{ success: boolean, nodeId?: string, oldType?: string, error?: string }}
 */
export function directUpdateMemory(projectId, oldContent, newContent, type = null) {
  try {
    const db = getDirectBrainDb();

    const nodeType = type || null;
    const searchClause = nodeType ? "AND entity_type = ?" : "";
    const params = nodeType
      ? [projectId, `%${oldContent.slice(0, 60)}%`, nodeType]
      : [projectId, `%${oldContent.slice(0, 60)}%`];

    const nodes = db.prepare(
      `SELECT * FROM nodes WHERE project_id = ? AND content LIKE ? ${searchClause}
       AND entity_type IN ('decision', 'lesson', 'pattern', 'error_fix')
       ORDER BY confidence DESC LIMIT 5`
    ).all(...params);

    if (nodes.length === 0) {
      return { success: false, error: "No existing memory matching that content found." };
    }

    const node = nodes[0];

    // Save old version for audit trail
    db.prepare(
      `INSERT INTO node_versions (node_id, version, content, confidence, change_reason, diff)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(node.id, node.version, node.content, node.confidence, "memory_updated",
      "Old content replaced with refined version");

    // Update the node in place — preserve existing metadata
    let oldParsed = {};
    try { oldParsed = JSON.parse(node.content || "{}"); } catch { /* start fresh */ }
    const mergedMetadata = {
      ...(oldParsed.metadata || {}),
      updated: true,
      updated_at: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE nodes SET version = version + 1, content = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(JSON.stringify({ text: newContent, metadata: mergedMetadata }), node.id);

    // Trigger search export refresh in background (non-blocking)
    refreshSearchExport(db, projectId);

    return { success: true, nodeId: node.id, oldType: node.entity_type };
  } catch (err) {
    console.error("[memory-direct] directUpdateMemory failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Rewrite the search export file for a project.
 * Mirrors brain-engine.mjs's writeSearchExport() but reads via the direct
 * connection. This ensures pane_recall (which reads the export file) sees
 * the deletion/update immediately.
 */
function refreshSearchExport(db, projectId) {
  try {
    const nodes = db.prepare(`
      SELECT id, name, entity_type, content, confidence
      FROM nodes
      WHERE project_id = ?
        AND entity_type IN ('decision','lesson','pattern','error','error_fix','file','project')
    `).all(projectId);

    const exported = nodes.map(n => {
      const content = JSON.parse(n.content || "{}").text || n.name;
      return {
        id: n.id,
        type: n.entity_type,
        content: content.slice(0, 500),
        confidence: n.confidence,
      };
    });

    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPORTS_DIR, `${projectId}.json`), JSON.stringify(exported));
  } catch (err) {
    console.warn("[memory-direct] Search export refresh failed:", err.message);
  }
}

/**
 * Notify the brain worker to re-embed an updated node.
 * Fire-and-forget — the update already succeeded; re-embedding is for
 * search relevance only.
 *
 * @param {Function} brainRequest - the brainRequest function from main.mjs
 * @param {string} nodeId - the node that was updated
 * @param {string} newContent - the new content to embed
 */
export function notifyBrainReembed(brainRequest, nodeId, newContent) {
  // The brain worker has a handler for this: we post a lightweight message
  // asking it to re-embed just this node. This is non-critical — if it fails,
  // the old embedding stays (slightly stale search relevance).
  if (!brainRequest) return;
  brainRequest("reembed_node", { nodeId, content: newContent }).catch(() => {});
}
