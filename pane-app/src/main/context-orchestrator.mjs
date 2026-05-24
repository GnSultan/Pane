/**
 * Context Orchestrator — minimal system prompt assembly.
 *
 * Identity + project about + Working in Pane instruction.
 * Everything else is on-demand via tools. The model fetches
 * what it needs via pane_brief, pane_recall, pane_get_handoff.
 *
 * No layers. No tiers. No digest. No pins. No fences.
 * No staleness bugs. No cache invalidation.
 * No settling timers. No relevance adjustments.
 *
 * The system prompt is ~300-500 tokens and identical every turn.
 * This gives the model maximum attention for the conversation.
 * Prefix caching is automatic — a static prompt hits every time.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { estimateTokens } from "./token-budget.mjs";
import { getIdentity } from "./identity.mjs";
import { readVerdict, formatVerdictForContext, formatQualityStatsForContext, formatGuidanceForContext } from "./code-arbiter.mjs";
import { getPaneDb } from "./pane-db.mjs";

const MEMORY_DIR = path.join(os.homedir(), ".pane", "memory");

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

/**
 * Build minimal system prompt: identity + project about + Working in Pane.
 *
 * @param {string} projectId
 * @param {object} [options]
 * @param {string} [options.mode="full"] - "full" (HTTP backends, all pane_ tools)
 *                                         "lean" (CLI backends, MCP tools only)
 * @param {boolean} [options.isResume=false] - true when resuming an existing CLI session
 * @returns {{ frozen, session, turn, stable, dynamic, full, budget, layers }}
 */
export function orchestrateContext(projectId, options = {}) {
  const { mode = "full", isResume = false } = options;

  // ── Lean mode ──────────────────────────────────────────────────────────
  // For CLI backends (Claude SDK, Gemini CLI) that manage their own
  // context, tools, and conversation history. Identity + arbiter findings
  // + MCP orientation. ~200-500 tokens.
  if (mode === "lean") {
    return _buildLeanContext(projectId, isResume);
  }

  // ── Full mode ──────────────────────────────────────────────────────────
  // For HTTP backends with all pane_ tools available. Identity + about +
  // Working in Pane instruction. ~300-500 tokens. Never changes.

  const parts = [];

  // 1. Identity — condensed behavioral identity
  const identity = getIdentity();
  if (identity) parts.push(identity);

  // 2. Project about — what this project is, its purpose, who it's for
  try {
    const aboutPath = path.join(MEMORY_DIR, projectId, "about.md");
    if (fs.existsSync(aboutPath)) {
      const about = fs.readFileSync(aboutPath, "utf-8").trim();
      if (about) parts.push(about);
    }
  } catch {}

  // 3. Working in Pane instruction
  parts.push(
    "## Working in Pane\n\n" +
    "Pane provides project context (about, brief, identity) at start. All other project state — " +
    "file structure, working set, git status, session state, memories — is on-demand via tools. " +
    "Retrieve only what you need for the task at hand.\n\n" +
    "Closed loop: persist discoveries as you go. pane_remember for root causes, patterns, and decisions. " +
    "pane_set_rule when the user states a preference. pane_set_about when you understand the project's purpose. " +
    "A session that discovers but doesn't record forces re-discovery."
  );

  const full = parts.join("\n\n");
  const tokens = estimateTokens(full);

  return {
    frozen: full,
    session: "",
    turn: "",
    stable: full,
    dynamic: "",
    full,
    budget: {
      limit: 0,
      systemBudget: tokens,
      systemUsed: tokens,
      conversationTokens: 0,
      outputBudget: 0,
      remaining: 0,
      pressure: "low",
      layersIncluded: 1,
      layersDropped: 0,
      droppedNames: [],
    },
    layers: [{ name: "system_prompt", priority: 1, tokens, truncated: false }],
  };
}

// ---------------------------------------------------------------------------
// Lean context — for CLI backends (Claude SDK, Gemini CLI) that manage
// their own context, tools, and conversation history. Pane provides only
// identity + arbiter findings + MCP orientation. ~200-500 tokens.
// ---------------------------------------------------------------------------

function _buildLeanContext(projectId, isResume) {
  const parts = [];

  // Identity
  const identity = getIdentity();
  if (identity) parts.push(identity);

  // On resume, the SDK already has full context — just identity + arbiter
  if (!isResume) {
    parts.push(
      "Project context, memory, symbols, codebase structure, and intelligence are available via pane_ MCP tools. " +
      "Call pane_project_context to orient yourself. Use pane_find_symbol for code navigation, pane_recall for project memory, " +
      "and pane_brief for the project brief."
    );
  }

  // Arbiter findings — if unresolved errors exist, the model must see them immediately
  const verdict = readVerdict(projectId);
  const arbiterText = formatVerdictForContext(verdict);
  if (arbiterText) parts.push("", arbiterText);

  // Quality trend — if concerning, nudge the model
  try {
    const qdb = getPaneDb();
    const qualityText = formatQualityStatsForContext(qdb, projectId);
    if (qualityText) parts.push("", qualityText);
  } catch {}

  // Proactive guidance from last verdict
  if (verdict?.guidance) {
    const guidanceText = formatGuidanceForContext(verdict.guidance);
    if (guidanceText) parts.push("", guidanceText);
  }

  const full = parts.join("\n");
  const tokens = estimateTokens(full);

  return {
    frozen: full,
    session: "",
    turn: "",
    stable: full,
    dynamic: "",
    full,
    budget: {
      limit: 0,
      systemBudget: tokens,
      systemUsed: tokens,
      conversationTokens: 0,
      outputBudget: 0,
      remaining: 0,
      pressure: "low",
      layersIncluded: isResume ? 2 : 3,
      layersDropped: 0,
      droppedNames: [],
    },
    layers: [],
  };
}
