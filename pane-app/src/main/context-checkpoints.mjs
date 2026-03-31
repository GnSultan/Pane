/**
 * Context Checkpoints — snapshot and restore compiled context states.
 *
 * Complements file checkpoints (in main.mjs) with context-level snapshots.
 * When the orchestrator assembles a good context configuration (all critical
 * layers included, budget healthy), save a checkpoint. If context assembly
 * degrades (layers dropped, budget pressure), restore the last known-good
 * configuration instead of re-assembling from scratch.
 *
 * Storage: ~/.pane/checkpoints/{projectId}/context/
 *   - {checkpointId}.json (orchestrator output: layers, budget, full text hash)
 *   - manifest.json (index of available context checkpoints)
 *
 * Lightweight: only stores layer metadata + budget info, NOT the full text.
 * The orchestrator can rebuild from metadata since layers are deterministic
 * given the same inputs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PANE_DIR = path.join(os.homedir(), ".pane");
const CHECKPOINTS_DIR = path.join(PANE_DIR, "checkpoints");

const MAX_CONTEXT_CHECKPOINTS = 5; // keep last 5 per project

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getContextCpDir(projectId) {
  return path.join(CHECKPOINTS_DIR, projectId, "context");
}

function getManifestPath(projectId) {
  return path.join(getContextCpDir(projectId), "manifest.json");
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function readManifest(projectId) {
  try {
    const data = fs.readFileSync(getManifestPath(projectId), "utf-8");
    return JSON.parse(data);
  } catch {
    return { checkpoints: [], version: 1 };
  }
}

function writeManifest(projectId, manifest) {
  const dir = getContextCpDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getManifestPath(projectId), JSON.stringify(manifest, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Save / Restore / List
// ---------------------------------------------------------------------------

/**
 * Save a context checkpoint from orchestrator output.
 *
 * @param {string} projectId
 * @param {object} orchestratorResult - the result from orchestrateContext()
 * @param {object} [meta] - optional metadata (messageId, turn, etc.)
 * @returns {{ id: string, saved: boolean }}
 */
export function saveContextCheckpoint(projectId, orchestratorResult, meta = {}) {
  try {
    const id = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = getContextCpDir(projectId);
    fs.mkdirSync(dir, { recursive: true });

    // Hash the full context for quick equality checks
    const fullHash = crypto.createHash("sha256").update(orchestratorResult.full || "").digest("hex").slice(0, 16);

    const checkpoint = {
      id,
      timestamp: Date.now(),
      fullHash,
      budget: orchestratorResult.budget,
      layers: orchestratorResult.layers,
      meta: {
        messageId: meta.messageId || null,
        turn: meta.turn || null,
        model: meta.model || null,
        intent: meta.intent || null,
      },
    };

    // Write checkpoint
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify(checkpoint, null, 2),
      "utf-8"
    );

    // Update manifest
    const manifest = readManifest(projectId);
    manifest.checkpoints.push({
      id,
      timestamp: checkpoint.timestamp,
      fullHash,
      pressure: orchestratorResult.budget?.pressure || "unknown",
      layersIncluded: orchestratorResult.budget?.layersIncluded || 0,
      layersDropped: orchestratorResult.budget?.layersDropped || 0,
    });

    // Prune old checkpoints
    while (manifest.checkpoints.length > MAX_CONTEXT_CHECKPOINTS) {
      const oldest = manifest.checkpoints.shift();
      try {
        fs.unlinkSync(path.join(dir, `${oldest.id}.json`));
      } catch {}
    }

    writeManifest(projectId, manifest);

    return { id, saved: true };
  } catch (err) {
    console.warn(`[context-checkpoints] Failed to save: ${err.message}`);
    return { id: null, saved: false };
  }
}

/**
 * Load a specific context checkpoint.
 *
 * @param {string} projectId
 * @param {string} checkpointId
 * @returns {object|null}
 */
export function loadContextCheckpoint(projectId, checkpointId) {
  try {
    const cpPath = path.join(getContextCpDir(projectId), `${checkpointId}.json`);
    return JSON.parse(fs.readFileSync(cpPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Get the most recent checkpoint with healthy budget (no dropped layers).
 *
 * @param {string} projectId
 * @returns {object|null}
 */
export function getLastHealthyCheckpoint(projectId) {
  const manifest = readManifest(projectId);

  // Walk backwards to find the most recent healthy checkpoint
  for (let i = manifest.checkpoints.length - 1; i >= 0; i--) {
    const entry = manifest.checkpoints[i];
    if (entry.layersDropped === 0 && entry.pressure !== "critical" && entry.pressure !== "high") {
      return loadContextCheckpoint(projectId, entry.id);
    }
  }

  return null;
}

/**
 * List all context checkpoints for a project.
 *
 * @param {string} projectId
 * @returns {Array<{ id, timestamp, fullHash, pressure, layersIncluded, layersDropped }>}
 */
export function listContextCheckpoints(projectId) {
  const manifest = readManifest(projectId);
  return manifest.checkpoints;
}

/**
 * Clear all context checkpoints for a project.
 *
 * @param {string} projectId
 */
export function clearContextCheckpoints(projectId) {
  try {
    const dir = getContextCpDir(projectId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  } catch (err) {
    console.warn(`[context-checkpoints] Failed to clear: ${err.message}`);
  }
}
