/**
 * Context Digest — a living system prompt layer that tracks what's been
 * done, discovered, and decided during a long session.
 *
 * Problem: When context pressure drops turns 1-20 of a 30-turn session,
 * the model loses HOW it got here. The system prompt layers (brief, handoff,
 * memories) are static — they don't evolve with the conversation.
 *
 * Solution: The digest is updated incrementally whenever turns are pruned.
 * It captures the key facts from pruned content — objectives, decisions,
 * discoveries, approaches tried — and injects them as a system prompt layer
 * when pressure is high. This gives the model continuity even after losing
 * raw conversation history.
 *
 * Storage: ~/.pane/session/{projectId}/context-digest.json
 *
 * Schema:
 * {
 *   sessionId: string,
 *   updatedAt: number,
 *   turnRange: string,          // "1-25"
 *   originalObjective: string,
 *   keyDecisions: string[],
 *   discoveries: string[],
 *   approachesTried: string[],   // what didn't work
 *   openQuestions: string[],
 *   narrativeSummary: string     // compact narrative of progress so far
 * }
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");

// ──────────────────────────────────────────────────────────────────────────
// File I/O
// ──────────────────────────────────────────────────────────────────────────

function digestPath(projectId, conversationId = null) {
  const fileName = conversationId
    ? `context-digest-${conversationId}.json`
    : "context-digest.json";
  return path.join(SESSION_DIR, projectId, fileName);
}

function ensureSessionDir(projectId) {
  const dir = path.join(SESSION_DIR, projectId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Core API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the current context digest for a project session.
 * @param {string} projectId
 * @param {string|null} [conversationId] - scope by conversation when available
 * @returns {object|null}
 */
export function readDigest(projectId, conversationId = null) {
  try {
    const filePath = digestPath(projectId, conversationId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // File missing or invalid JSON — no digest exists, return null
  }
  return null;
}

/**
 * Create a new digest at session start.
 * @param {string} projectId
 * @param {string} sessionId
 * @param {string} originalObjective - first user message or task description
 * @param {string|null} [conversationId] - scope by conversation when available
 */
export function createDigest(projectId, sessionId, originalObjective, conversationId = null) {
  ensureSessionDir(projectId);

  const digest = {
    sessionId,
    updatedAt: Date.now(),
    turnRange: "0-0",
    originalObjective: truncateForField(originalObjective, 300),
    keyDecisions: [],
    discoveries: [],
    approachesTried: [],
    openQuestions: [],
    narrativeSummary: "",
  };

  try {
    fs.writeFileSync(digestPath(projectId, conversationId), JSON.stringify(digest, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[context-digest] createDigest failed: ${err.message}`);
  }

  return digest;
}

/**
 * Update the digest with information extracted from dropped turns.
 * Merges discoveries, decisions, and approaches from pruned content.
 *
 * @param {string} projectId
 * @param {Array<{ turnIndex: number, request: string, tools: string[], conclusion: string }>} droppedTurns
 * @param {object} state - optional session state for decisions/deeper context
 * @param {string|null} [conversationId] - scope by conversation when available
 */
export function updateDigest(projectId, droppedTurns, state = null, conversationId = null) {
  if (!droppedTurns || droppedTurns.length === 0) return;

  let digest = readDigest(projectId, conversationId);
  if (!digest) {
    // No digest yet — create one from first dropped turn's request
    digest = createDigest(
      projectId,
      `auto-${Date.now()}`,
      droppedTurns[0]?.request || "(unknown)",
      conversationId,
    );
  }

  const updated = { ...digest };

  // ── Update turn range ─────────────────────────────────────────────────
  const lastTurn = droppedTurns[droppedTurns.length - 1];
  if (lastTurn) {
    const currentEnd = parseInt(digest.turnRange.split("-")[1] || "0", 10);
    updated.turnRange = `${digest.turnRange.split("-")[0]}-${Math.max(currentEnd, lastTurn.turnIndex)}`;
  }

  // ── Extract decisions from state ───────────────────────────────────────
  if (state?.decisions?.length > 0) {
    const existingDecisions = new Set(updated.keyDecisions.map(d => d.toLowerCase().slice(0, 60)));
    for (const d of state.decisions) {
      const content = typeof d === "string" ? d : d.content;
      if (content && !existingDecisions.has(content.toLowerCase().slice(0, 60))) {
        updated.keyDecisions.push(content);
        existingDecisions.add(content.toLowerCase().slice(0, 60));
      }
    }
    // Cap at 12 decisions
    if (updated.keyDecisions.length > 12) {
      updated.keyDecisions = updated.keyDecisions.slice(-12);
    }
  }

  // ── Extract discoveries from tool usage patterns ──────────────────────
  const allTools = new Set();
  for (const drop of droppedTurns) {
    for (const tool of drop.tools) {
      allTools.add(tool);
    }
  }

  // If substantial tool use (reads + writes), capture as discovery
  if (allTools.has("read_file") || allTools.has("pane_read_files")) {
    const conclusion = droppedTurns[droppedTurns.length - 1]?.conclusion || "";
    if (conclusion.length > 20) {
      const snippet = truncateForField(conclusion, 250);
      const existingDiscoveries = new Set(updated.discoveries.map(d => d.toLowerCase().slice(0, 40)));
      if (!existingDiscoveries.has(snippet.toLowerCase().slice(0, 40))) {
        updated.discoveries.push(snippet);
        if (updated.discoveries.length > 8) {
          updated.discoveries = updated.discoveries.slice(-8);
        }
      }
    }
  }

  // ── Extract approaches tried from dropped turns ────────────────────────
  const hasWrites =
    allTools.has("write_file") ||
    allTools.has("replace") ||
    allTools.has("bash") ||
    allTools.has("pane_run_in_terminal");
  if (hasWrites) {
    for (const drop of droppedTurns) {
      const request = truncateForField(drop.request, 150);
      const existingApproaches = new Set(updated.approachesTried.map(a => a.toLowerCase().slice(0, 40)));
      if (!existingApproaches.has(request.toLowerCase().slice(0, 40))) {
        updated.approachesTried.push(request);
        if (updated.approachesTried.length > 6) {
          updated.approachesTried = updated.approachesTried.slice(-6);
        }
      }
    }
  }

  // ── Build narrative summary ────────────────────────────────────────────
  updated.narrativeSummary = buildNarrativeSummary(updated);
  updated.updatedAt = Date.now();

  try {
    ensureSessionDir(projectId);
    fs.writeFileSync(digestPath(projectId, conversationId), JSON.stringify(updated, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[context-digest] updateDigest failed: ${err.message}`);
  }
}

/**
 * Format the digest for injection into the system prompt.
 * Compact, scannable, ~200-400 tokens.
 *
 * @param {object} digest
 * @returns {string|null}
 */
export function formatDigestForContext(digest) {
  if (!digest) return null;

  const hasContent =
    digest.keyDecisions.length > 0 ||
    digest.discoveries.length > 0 ||
    digest.approachesTried.length > 0 ||
    digest.narrativeSummary;

  if (!hasContent) return null;

  const lines = ["## Session Context Digest", ""];

  if (digest.narrativeSummary) {
    lines.push(digest.narrativeSummary);
    lines.push("");
  }

  if (digest.originalObjective && digest.turnRange !== "0-0") {
    lines.push(`Original objective: ${digest.originalObjective}`);
    lines.push(`Turns covered: ${digest.turnRange}`);
    lines.push("");
  }

  if (digest.keyDecisions.length > 0) {
    lines.push("Decisions made in this session:");
    for (const d of digest.keyDecisions.slice(-6)) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (digest.discoveries.length > 0) {
    lines.push("Key discoveries:");
    for (const d of digest.discoveries.slice(-4)) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (digest.approachesTried.length > 0) {
    lines.push("Approaches completed (do not repeat):");
    for (const a of digest.approachesTried.slice(-4)) {
      lines.push(`- ✓ ${a}`);
    }
    lines.push("");
  }

  lines.push(
    "Important: You are deep in this session. The conversation above has been summarized " +
    "as it exceeded the context window. Use this digest + pane_recall for continuity. " +
    "Do not re-do completed work.",
  );

  return lines.join("\n");
}

/**
 * Check if a digest exists and has meaningful content.
 * @param {string} projectId
 * @param {string|null} [conversationId] - scope by conversation when available
 * @returns {boolean}
 */
export function hasDigest(projectId, conversationId = null) {
  const digest = readDigest(projectId, conversationId);
  if (!digest) return false;
  return (
    digest.keyDecisions.length > 0 ||
    digest.discoveries.length > 0 ||
    digest.approachesTried.length > 0
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function truncateForField(text, maxLen) {
  if (!text) return "";
  const cleaned = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + "..." : cleaned;
}

function buildNarrativeSummary(digest) {
  const parts = [];

  if (digest.originalObjective) {
    parts.push(`Session started: ${digest.originalObjective}`);
  }

  if (digest.approachesTried.length > 0) {
    const last = digest.approachesTried.slice(-2);
    parts.push(`Recent work: ${last.join("; ")}`);
  }

  if (digest.keyDecisions.length > 0) {
    const last = digest.keyDecisions.slice(-3).join(", ");
    parts.push(`Key decisions: ${last}`);
  }

  if (parts.length === 0) return "";

  return parts.join(". ") + ".";
}
