/**
 * Context Orchestrator — single unified system prompt for all backends.
 *
 * Identity + project about + Working in Pane instruction + arbiter/quality.
 * Everything else is on-demand via tools. The model fetches
 * what it needs via pane_brief, pane_recall, pane_get_handoff.
 *
 * No layers. No tiers. No digest. No pins. No fences.
 * No staleness bugs. No cache invalidation.
 * No settling timers. No relevance adjustments.
 *
 * The system prompt is ~300-600 tokens and identical every turn.
 * This gives the model maximum attention for the conversation.
 * Prefix caching is automatic — a static prompt hits every time.
 *
 * All backends receive the same context. Model swapping is seamless —
 * the handoff data is the same, the tools are the same, the instructions
 * are the same.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { estimateTokens } from "./token-budget.mjs";
import { getIdentity } from "./identity.mjs";
import { readVerdict, formatVerdictForContext, formatQualityStatsForContext, formatGuidanceForContext } from "./code-arbiter.mjs";
import { getPaneDb } from "./pane-db.mjs";
import { buildPeerSummary, pruneIntents } from "./intents.mjs";
import { buildSkillListing, getActiveSkillContext, hydrateActiveSkills } from "./skill-registry.mjs";
import { readState } from "./pane-system-prompt.mjs";

const MEMORY_DIR = path.join(os.homedir(), ".pane", "memory");
const PLAYBOOKS_DIR = path.join(os.homedir(), ".pane", "profile", "playbooks");
const MODELS_DIR = path.join(os.homedir(), ".pane", "profile", "models");

// ── Prune throttle ──────────────────────────────────────────────────────
// pruneIntents rewrites the intent log to remove expired entries.
// It's cheap but we don't need to do it every turn — once per 5 minutes
// per project is plenty.

const _lastPrune = new Map(); // projectId → timestamp
const PRUNE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// Playbooks are small by construction (≤30 principles per project, ≤15
// global) but cap defensively — a runaway file must not eat the prompt.
const MAX_PLAYBOOK_CHARS = 4000;

/**
 * Read the distilled playbook for a project (+ global craft profile).
 * These are the few tested principles the reflection engine graduated
 * from accumulated experience — injected every session so they shape
 * behavior without needing recall. Files only change on reflection
 * (hours apart), so the prompt stays byte-stable for prefix caching.
 */
function readPlaybook(projectId) {
  const sections = [];
  try {
    const globalPath = path.join(PLAYBOOKS_DIR, "global.md");
    if (fs.existsSync(globalPath)) {
      const global = fs.readFileSync(globalPath, "utf-8").trim();
      if (global) sections.push(global);
    }
  } catch {}
  try {
    const projectPath = path.join(PLAYBOOKS_DIR, `${projectId}.md`);
    if (fs.existsSync(projectPath)) {
      const project = fs.readFileSync(projectPath, "utf-8").trim();
      if (project) sections.push(project);
    }
  } catch {}
  if (sections.length === 0) return null;

  const body = sections.join("\n").slice(0, MAX_PLAYBOOK_CHARS);
  return (
    "## Playbook — principles earned from working in this codebase\n\n" +
    "These were distilled from real sessions: mistakes made, fixes that held, " +
    "approaches that worked. Follow them by default; if one seems wrong for " +
    "the current task, say so rather than silently ignoring it.\n\n" +
    body
  );
}

/**
 * Read behavioral counter-directives earned for a specific model.
 * These are distilled from real arbiter verdicts for that model —
 * injected only when that model is driving, so it gets briefed on
 * its own known failure modes at the start of every session.
 */
function readModelProfile(modelId) {
  if (!modelId) return null;
  try {
    const safeFilename = modelId.replace(/[/: ]+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "") + ".md";
    const profilePath = path.join(MODELS_DIR, safeFilename);
    if (!fs.existsSync(profilePath)) return null;
    const body = fs.readFileSync(profilePath, "utf-8").trim();
    if (!body) return null;
    return (
      "## Model directives — known failure patterns for this model\n\n" +
      "These were earned from real arbiter verdicts on your outputs. " +
      "They describe YOUR specific tendencies — follow them.\n\n" +
      body
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

/**
 * Build minimal system prompt for ALL backends — HTTP and CLI.
 *
 * Identity + project about + Working in Pane instruction.
 * Arbiter findings and quality trend when relevant.
 *
 * Everything else is on-demand via tools. The model fetches
 * what it needs via pane_brief, pane_recall, pane_get_handoff.
 *
 * The system prompt is ~300-600 tokens and identical every turn.
 * This gives the model maximum attention for the conversation.
 * Prefix caching is automatic — a static prompt hits every time.
 *
 * @param {string} projectId
 * @param {object} [options] — kept for backward compat; all backends get the same treatment
 * @returns {{ frozen, session, turn, stable, dynamic, full, budget, layers }}
 */
export function orchestrateContext(projectId, options = {}) {
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

  // 3. Playbook — tested principles distilled from accumulated experience.
  //    This is the wire that makes memory shape behavior: the reflection
  //    engine writes these files; every session starts already knowing them.
  const playbook = readPlaybook(projectId);
  if (playbook) parts.push(playbook);

  // 3a. Available skills — compact listing of installable skills (names + descriptions only).
  //     Full instructions stay out of context until the model activates a skill.
  const skillListing = buildSkillListing(options.projectRoot);
  if (skillListing) parts.push(skillListing);

  // 3b. Hydrate active skills from persistent state on cold start.
  //     mergeState persists activeSkills to state.json; this call restores
  //     them into the in-memory registry so they survive process restarts.
  const state = readState(projectId);
  if (state?.activeSkills?.length > 0) {
    hydrateActiveSkills(projectId, state.activeSkills);
  }

  // 3c. Active skill context — injected when one or more skills are active.
  //     Provides the full skill instructions so they persist across turns
  //     without needing re-activation every turn.
  const activeSkillContext = getActiveSkillContext(projectId, options.projectRoot);
  if (activeSkillContext) parts.push(activeSkillContext);

  // 3c. Model directives — counter-directives specific to the active model,
  //     earned from its own failure history in this workflow. Different models
  //     have different failure modes; this section adapts to whoever is driving.
  const modelProfile = readModelProfile(options.model);
  if (modelProfile) parts.push(modelProfile);

  // 4. Working in Pane instruction
  parts.push(
    "## Working in Pane\n\n" +
    "Pane provides project context (about, brief, identity) at start. All other project state — " +
    "file structure, working set, git status, session state, memories — is on-demand via tools. " +
    "Retrieve only what you need for the task at hand.\n\n" +
    "Closed loop: persist discoveries as you go. pane_remember for root causes, patterns, and decisions. " +
    "pane_set_rule when the user states a preference. pane_set_about when you understand the project's purpose. " +
    "A session that discovers but doesn't record forces re-discovery."
  );

  // 4b. Terminal-state awareness (API turn-loop only — ask_user exists there).
  //     The loop keeps running while you call tools. Be deliberate about when
  //     you stop: finish, or hand back to the user — don't drift past done.
  if (options.backend === "http") {
    parts.push(
      "## Finishing and asking\n\n" +
      "Every turn you keep calling tools, work continues. When you stop calling tools, control returns to the user. " +
      "Be deliberate about which of three states you're in:\n" +
      "- Still working: keep going, use tools. Don't stop mid-task.\n" +
      "- Done: the task is complete and verified. Stop with a brief summary of what changed. Do not invent more work.\n" +
      "- Need the user: you're unsure how to proceed, a decision is theirs, or you need them to test/confirm something you cannot verify yourself. " +
      "Call ask_user with a concrete question and STOP — you will wait for their reply. Never guess or plow ahead when the right move is to ask.\n\n" +
      "If your work needs to be tested or confirmed and you cannot verify it yourself, ask_user rather than declaring it done.\n\n" +
      "Before a risky or large change — a refactor, a deletion, edits you're unsure about — call pane_checkpoint first so the state can be restored if it doesn't work out."
    );
  }

  // 5. Cross-thread awareness — if other threads are active on the same
  //    project root, surface their file touches so this agent avoids collisions.
  if (options.projectRoot) {
    // Prune expired intents periodically (throttled)
    const lastPrune = _lastPrune.get(projectId) || 0;
    if (Date.now() - lastPrune > PRUNE_THROTTLE_MS) {
      pruneIntents(projectId);
      _lastPrune.set(projectId, Date.now());
    }
    const peerSummary = buildPeerSummary(options.projectRoot, projectId);
    if (peerSummary) parts.push(peerSummary);
  }

  // 6. Arbiter findings — if unresolved errors exist, surface them immediately
  const verdict = readVerdict(projectId);
  const arbiterText = formatVerdictForContext(verdict);
  if (arbiterText) parts.push(arbiterText);

  // 7. Quality trend — if concerning, nudge the model
  try {
    const qdb = getPaneDb();
    const qualityText = formatQualityStatsForContext(qdb, projectId);
    if (qualityText) parts.push(qualityText);
  } catch {}

  // 8. Proactive guidance from last verdict
  if (verdict?.guidance) {
    const guidanceText = formatGuidanceForContext(verdict.guidance);
    if (guidanceText) parts.push(guidanceText);
  }

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
