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

const { gzipSync, gunzipSync } = zlib;
const PANE_DIR = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 100000; // 100k token budget for archive

/**
 * Get the directory path for session turns storage.
 * When conversationId is provided, turns are scoped per-conversation.
 * Falls back to project-level path for backward compat (pre-v7 data).
 */
function getTurnsDir(projectId, conversationId = null) {
  if (conversationId) {
    return path.join(SESSION_DIR, projectId, "turns", conversationId);
  }
  return path.join(SESSION_DIR, projectId, "turns");
}

/**
 * Get the metadata file path for the turn index
 */
function getMetadataPath(projectId, conversationId = null) {
  return path.join(getTurnsDir(projectId, conversationId), "metadata.json");
}

/**
 * Estimate token count for a turn object using centralized token estimation.
 */
function estimateTurnTokens(turn) {
  return estimateTokens(JSON.stringify(turn));
}

/**
 * Serialize and compress a turn object
 */
function compressTurn(turn) {
  const json = JSON.stringify(turn);
  return gzipSync(json);
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
 * Read metadata for a project/conversation
 */
function readMetadata(projectId, conversationId = null) {
  try {
    const metaPath = getMetadataPath(projectId, conversationId);
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
 * Write metadata for a project/conversation
 */
function writeMetadata(projectId, metadata, conversationId = null) {
  try {
    const dir = getTurnsDir(projectId, conversationId);
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = getMetadataPath(projectId, conversationId);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[session-turns] Failed to write metadata: ${err.message}`);
  }
}

/**
 * Get the file path for a specific turn index
 */
function getTurnPath(projectId, turnIndex, conversationId = null) {
  return path.join(getTurnsDir(projectId, conversationId), `${turnIndex}.json.gz`);
}

/**
 * Save a turn to the archive.
 *
 * @param {string} projectId
 * @param {number} turnIndex - The turn number (0, 1, 2, ...)
 * @param {object} turn - The full turn object to archive
 * @param {object} options - { maxTurns, maxTokens, conversationId }
 */
export function saveTurn(projectId, turnIndex, turn, options = {}) {
  const { maxTurns = DEFAULT_MAX_TURNS, maxTokens = DEFAULT_MAX_TOKENS, conversationId = null } = options;

  try {
    const metadata = readMetadata(projectId, conversationId);
    const tokenEstimate = estimateTurnTokens(turn);

    // Compress and write the turn file
    const compressed = compressTurn(turn);
    const turnPath = getTurnPath(projectId, turnIndex, conversationId);
    fs.mkdirSync(path.dirname(turnPath), { recursive: true });
    fs.writeFileSync(turnPath, compressed);

    // Update metadata
    metadata.turns = metadata.turns.filter(t => t.index !== turnIndex);
    metadata.turns.push({
      index: turnIndex,
      tokenEstimate,
      timestamp: Date.now(),
      fileSize: compressed.length,
    });
    metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);

    // Enforce retention limits
    if (metadata.turns.length > maxTurns) {
      const excess = metadata.turns.length - maxTurns;
      const toRemove = metadata.turns.slice(0, excess);
      for (const entry of toRemove) {
        try { fs.unlinkSync(getTurnPath(projectId, entry.index, conversationId)); } catch { /* turn file already deleted */ }
        metadata.turns = metadata.turns.filter(t => t.index !== entry.index);
      }
      metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    }
    while (metadata.turns.length > 0 && metadata.totalTokens > maxTokens) {
      const oldest = metadata.turns[0];
      try { fs.unlinkSync(getTurnPath(projectId, oldest.index, conversationId)); } catch { /* turn file already deleted */ }
      metadata.turns = metadata.turns.slice(1);
      metadata.totalTokens = metadata.turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    }

    writeMetadata(projectId, metadata, conversationId);
  } catch (err) {
    console.warn(`[session-turns] Failed to save turn ${turnIndex}: ${err.message}`);
  }
}

/**
 * Load a specific turn from the archive
 */
export function loadTurn(projectId, turnIndex, conversationId = null) {
  try {
    const turnPath = getTurnPath(projectId, turnIndex, conversationId);
    if (!fs.existsSync(turnPath)) return null;
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
export function loadTurns(projectId, turnIndices, conversationId = null) {
  const result = [];
  for (const idx of turnIndices) {
    const turn = loadTurn(projectId, idx, conversationId);
    if (turn) result.push(turn);
  }
  return result;
}

/**
 * Get the list of available turn indices from metadata
 */
export function getAvailableTurns(projectId, conversationId = null) {
  const metadata = readMetadata(projectId, conversationId);
  return metadata.turns.map(t => t.index).sort((a, b) => a - b);
}

/**
 * Get metadata summary for all turns
 */
export function getTurnMetadata(projectId, conversationId = null) {
  return readMetadata(projectId, conversationId);
}

/**
 * Clear all turns for a project/conversation
 */
export function clearTurns(projectId, conversationId = null) {
  try {
    const dir = getTurnsDir(projectId, conversationId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
    writeMetadata(projectId, defaultMetadata(), conversationId);
  } catch (err) {
    console.warn(`[session-turns] Failed to clear turns: ${err.message}`);
  }
}

/**
 * Check if a session has archived turns available
 */
export function hasArchivedTurns(projectId, conversationId = null) {
  const turns = getAvailableTurns(projectId, conversationId);
  return turns.length > 0;
}

/**
 * Load the most recent N turns for a session
 */
export function loadRecentTurns(projectId, count = 10, conversationId = null) {
  const available = getAvailableTurns(projectId, conversationId);
  if (available.length === 0) return [];
  const recentIndices = available.slice(-count);
  return loadTurns(projectId, recentIndices, conversationId);
}

/**
 * Backfill archive from existing handoff history.
 */
export function backfillFromHandoff(projectId, handoffHistory, conversationId = null) {
  if (!handoffHistory || handoffHistory.length === 0) return;

  console.log(`[session-turns] Backfilling ${handoffHistory.length} turns from handoff history for ${projectId}`);

  for (const handoff of handoffHistory) {
    if (handoff.turn !== undefined) {
      const turn = {
        messages: [],
        handoff,
        timestamp: handoff.timestamp,
        turn: handoff.turn,
      };
      saveTurn(projectId, handoff.turn, turn, { maxTurns: DEFAULT_MAX_TURNS, conversationId });
    }
  }

  console.log(`[session-turns] Backfill complete for ${projectId}`);
}
