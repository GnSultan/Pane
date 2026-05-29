// Session Turn Archive — stores compressed full conversation turns for exact continuity
//
// This module manages a rolling archive of recent conversation turns, compressed
// to save disk space. When a session resumes with the same sessionId, these
// turns can be loaded directly into the conversation history, preserving exact
// context without needing to reconstruct from handoff summaries.
//
// Storage: ~/.pane/session/{projectId}/turns/
//   - {turnIndex}.json.gz (each turn individually compressed)
//   - metadata.json (index, token estimates)
//
// Retention policy: keep last N turns (default 20) OR until total token estimate
// exceeds threshold (default 100k tokens), whichever comes first.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { estimateTokens } from "./token-budget.mjs";

const { gunzipSync } = zlib;
const gzipAsync = promisify(zlib.gzip);
const PANE_DIR = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 100000; // 100k token budget for archive

/**
 * Get the directory path for session turns storage
 */
function getTurnsDir(projectId) {
  return path.join(SESSION_DIR, projectId, "turns");
}

/**
 * Get the metadata file path for the turn index
 */
function getMetadataPath(projectId) {
  return path.join(getTurnsDir(projectId), "metadata.json");
}

/**
 * Decompress and parse a turn object
 */
function decompressTurn(buffer) {
  const decompressed = gunzipSync(buffer);
  return JSON.parse(decompressed.toString("utf-8"));
}

/**
 * Initialize metadata structure for a project
 */
function defaultMetadata() {
  return {
    turns: [], // [{ index, tokenEstimate, timestamp, fileSize }]
    totalTokens: 0,
    version: 1,
  };
}

/**
 * Read metadata for a project
 */
function readMetadata(projectId) {
  try {
    const metaPath = getMetadataPath(projectId);
    if (fs.existsSync(metaPath)) {
      const data = fs.readFileSync(metaPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn(`[session-turns] Failed to read metadata: ${err.message}`);
  }
  return defaultMetadata();
}

/**
 * Write metadata for a project
 */
function writeMetadata(projectId, metadata) {
  try {
    const dir = getTurnsDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = getMetadataPath(projectId);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[session-turns] Failed to write metadata: ${err.message}`);
  }
}

/**
 * Get the file path for a specific turn index
 */
function getTurnPath(projectId, turnIndex) {
  return path.join(getTurnsDir(projectId), `${turnIndex}.json.gz`);
}

/**
 * Save a turn to the archive (async — non-blocking).
 *
 * @param {string} projectId
 * @param {number} turnIndex - The turn number (0, 1, 2, ...)
 * @param {object} turn - The full turn object to archive
 * @param {object} options - { maxTurns, maxTokens }
 */
export async function saveTurn(projectId, turnIndex, turn, options = {}) {
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

  try {
    const metadata = readMetadata(projectId);

    // Serialize once — reuse for both token estimation and compression
    // Avoids the ~200ms of synchronous JSON.stringify(conversation) × 2.
    const turnJson = JSON.stringify(turn);
    const tokenEstimate = estimateTokens(turnJson);
    const compressed = await gzipAsync(turnJson);
    const turnPath = getTurnPath(projectId, turnIndex);
    await fs.promises.mkdir(path.dirname(turnPath), { recursive: true });
    await fs.promises.writeFile(turnPath, compressed);

    // Update metadata
    // Remove existing entry for this index if it exists (overwrite)
    metadata.turns = metadata.turns.filter(t => t.index !== turnIndex);

    // Add new entry
    metadata.turns.push({
      index: turnIndex,
      tokenEstimate,
      timestamp: Date.now(),
      fileSize: compressed.length,
    });

    // Recalculate total tokens
    metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);

    // Enforce retention limits
    // 1. Remove oldest turns if we exceed maxTurns
    if (metadata.turns.length > maxTurns) {
      const excess = metadata.turns.length - maxTurns;
      const toRemove = metadata.turns.slice(0, excess);
      const removeIndices = new Set(toRemove.map(e => e.index));
      // Best-effort cleanup — errors don't affect the filter
      await Promise.allSettled(
        toRemove.map(entry =>
          fs.promises.unlink(getTurnPath(projectId, entry.index)).catch(() => {}),
        ),
      );
      metadata.turns = metadata.turns.filter(t => !removeIndices.has(t.index));
      metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    }

    // 2. Remove oldest turns if we exceed maxTokens (after turn count check)
    while (metadata.turns.length > 0 && metadata.totalTokens > maxTokens) {
      const oldest = metadata.turns[0];
      try {
        await fs.promises.unlink(getTurnPath(projectId, oldest.index));
      } catch {}
      metadata.turns = metadata.turns.slice(1);
      metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    }

    writeMetadata(projectId, metadata);
  } catch (err) {
    console.warn(`[session-turns] Failed to save turn ${turnIndex}: ${err.message}`);
  }
}

/**
 * Load a specific turn from the archive
 */
export function loadTurn(projectId, turnIndex) {
  try {
    const turnPath = getTurnPath(projectId, turnIndex);
    if (!fs.existsSync(turnPath)) {
      return null;
    }
    const buffer = fs.readFileSync(turnPath);
    return decompressTurn(buffer);
  } catch (err) {
    console.warn(`[session-turns] Failed to load turn ${turnIndex}: ${err.message}`);
    return null;
  }
}

/**
 * Load multiple turns by index array (in order)
 */
export function loadTurns(projectId, turnIndices) {
  const result = [];
  for (const idx of turnIndices) {
    const turn = loadTurn(projectId, idx);
    if (turn) {
      result.push(turn);
    }
  }
  return result;
}

/**
 * Get the list of available turn indices from metadata
 */
export function getAvailableTurns(projectId) {
  const metadata = readMetadata(projectId);
  return metadata.turns.map(t => t.index).sort((a, b) => a - b);
}

/**
 * Get metadata summary for all turns
 */
export function getTurnMetadata(projectId) {
  return readMetadata(projectId);
}

/**
 * Clear all turns for a project (useful for testing or cleanup)
 */
export function clearTurns(projectId) {
  try {
    const dir = getTurnsDir(projectId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
    const metadata = defaultMetadata();
    writeMetadata(projectId, metadata);
  } catch (err) {
    console.warn(`[session-turns] Failed to clear turns: ${err.message}`);
  }
}

/**
 * Check if a session has archived turns available
 */
export function hasArchivedTurns(projectId) {
  const turns = getAvailableTurns(projectId);
  return turns.length > 0;
}

/**
 * Load the most recent N turns for a session
 * Returns array of turn objects sorted by index ascending (oldest first)
 */
export function loadRecentTurns(projectId, sessionId, count = 10) {
  const available = getAvailableTurns(projectId);
  if (available.length === 0) {
    return [];
  }

  // Take the most recent 'count' turns
  const recentIndices = available.slice(-count);
  return loadTurns(projectId, recentIndices);
}

/**
 * Backfill archive from existing handoff history.
 * Called during migration to populate the archive from legacy handoff data.
 */
export function backfillFromHandoff(projectId, handoffHistory) {
  if (!handoffHistory || handoffHistory.length === 0) {
    return;
  }

  console.log(`[session-turns] Backfilling ${handoffHistory.length} turns from handoff history for ${projectId}`);

  for (const handoff of handoffHistory) {
    if (handoff.turn !== undefined) {
      // Construct a minimal turn object from handoff data
      const turn = {
        messages: [], // Handoff doesn't have full message history
        handoff: handoff,
        timestamp: handoff.timestamp,
        turn: handoff.turn,
      };
      saveTurn(projectId, handoff.turn, turn, { maxTurns: DEFAULT_MAX_TURNS });
    }
  }

  console.log(`[session-turns] Backfill complete for ${projectId}`);
}
