/**
 * Context Orchestrator — budget-aware context assembly for Pane.
 *
 * Problem: compileContext() in session-context.mjs assembles every layer
 * unconditionally and hopes it fits. On 128k models (DeepSeek, OpenRouter)
 * the system prompt alone can exceed the context window, leaving no room
 * for conversation history or output tokens.
 *
 * Solution: the orchestrator wraps compileContext's layer-by-layer assembly
 * with token budget management. Each layer has a priority (0 = critical,
 * higher = optional). When the budget is tight, lower-priority layers are
 * truncated or dropped entirely.
 *
 * Token estimation: ~4 chars per token (same heuristic as session-turns.mjs).
 * Not exact, but consistent and fast — no external dependencies.
 *
 * Usage:
 *   import { orchestrateContext } from "./context-orchestrator.mjs";
 *   const result = orchestrateContext(projectId, {
 *     intent, historyLength, backend, model, sqliteChanges,
 *     conversationTokens,  // estimated tokens already used by history
 *     outputBudget,        // reserved for model output (default 8192)
 *   });
 *   // result = { stable, dynamic, full, budget: { limit, system, conversation, output, remaining } }
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { METHOD_ATOMS, RULE_ATOMS, GUIDELINE_ATOMS } from "./system-atoms.mjs";
import { BASE_CONFIDENCE, getEffectiveConfidence } from "./extraction-tuning.mjs";
import { MODEL_CONTEXT_LIMITS, readState } from "./pane-system-prompt.mjs";
import { estimateTokens, getModelLimit, getDefaultOutputBudget, createRequestBudget } from "./token-budget.mjs";
import { saveContextCheckpoint } from "./context-checkpoints.mjs";
import { contextStore } from "./context-store.mjs";
import { detectPhase, filterAtomsForPhase } from "./conversation-phase.mjs";
import { readVerdict, formatVerdictForContext, formatQualityStatsForContext, formatGuidanceForContext } from "./code-arbiter.mjs";
import { getPaneDb } from "./pane-db.mjs";
import { getIdentity } from "./identity.mjs";

const PANE_DIR    = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");
const BRAIN_DIR   = path.join(PANE_DIR, "brain");
const MEMORY_DIR  = path.join(PANE_DIR, "memory");
const PROFILE_DIR = path.join(PANE_DIR, "profile");

// ---------------------------------------------------------------------------
// Context layer priorities (lower = more important, never dropped)
//
//   0 — critical: core instructions, identity, rules (model breaks without these)
//   1 — high: project brief, DNA, purpose (model is blind without these)
//   2 — important: session state, working set, pre-reads, decisions (current task context)
//   3 — useful: memories, symbols, principles, handoff, mind entries (enrichment)
//   4 — optional: orientation marker, behavioral fence, method notes (polish)
//   5 — expendable: global memory, profile atoms (nice-to-have)
// ---------------------------------------------------------------------------

const PRIORITY = {
  CRITICAL:    0,
  HIGH:        1,
  IMPORTANT:   2,
  USEFUL:      3,
  OPTIONAL:    4,
  EXPENDABLE:  5,
};

// ---------------------------------------------------------------------------
// Relevance Engine — dynamically adjusts layer priorities based on brain
// context, intent, and conversation state. Static priorities are good defaults
// but a "debug" intent should boost memories/symbols over brief/DNA, while
// "explain" should boost brief/DNA over pre-reads.
//
// The engine reads the brain's contextual export and context shape (already
// written to disk by brain-engine.mjs), then returns priority adjustments.
// ---------------------------------------------------------------------------

/**
 * Compute dynamic priority adjustments for context layers.
 * Returns a Map<layerName, priorityDelta> where negative = more important.
 *
 * @param {object} contextShape - from brain context shape file
 * @param {object} brainCtx - from brain contextual export
 * @param {string} intent - "execute" | "plan" | "explain" | "other"
 * @param {number} historyLength - conversation turn count
 * @returns {Map<string, number>}
 */
function computeRelevanceAdjustments(contextShape, brainCtx, intent, historyLength) {
  const adjustments = new Map();

  const taskType = contextShape?.taskType || null;
  const complexity = contextShape?.complexity || null;
  const escalation = contextShape?.escalationStage || 0;

  // ── Intent-driven adjustments ──────────────────────────────────────────

  if (taskType === "debug" || taskType === "review") {
    // Debugging: memories, symbols, and pre-reads are critical; brief and DNA less so
    adjustments.set("brain_memories", -1);    // useful → important
    adjustments.set("symbol_map", -1);        // useful → important
    adjustments.set("pre_read_files", -1);    // already important, reinforce
    adjustments.set("project_brief", +1);     // high → important (save tokens)
    adjustments.set("project_dna", +1);       // high → important
  }

  if (taskType === "explain" || taskType === "architect") {
    // Explaining: brief, DNA, and principles matter most; pre-reads less so
    adjustments.set("project_brief", -1);     // reinforce as critical context
    adjustments.set("project_dna", -1);       // reinforce
    adjustments.set("principles", -1);        // useful → important
    adjustments.set("pre_read_files", +1);    // demote slightly (explanation doesn't need full code)
  }

  if (taskType === "implement" || taskType === "refactor") {
    // Implementation: working set and symbols are king
    adjustments.set("pre_read_files", -1);    // reinforce
    adjustments.set("symbol_map", -1);        // useful → important
    adjustments.set("working_set", -1);       // reinforce
    adjustments.set("relevant_files", -1);    // useful → important
  }

  // Analyze mode: boost everything the model needs for deep investigation
  const mode = contextShape?.mode || null;
  if (mode === "analyze") {
    adjustments.set("brain_memories", (adjustments.get("brain_memories") || 0) - 1);
    adjustments.set("symbol_map", (adjustments.get("symbol_map") || 0) - 1);
    adjustments.set("project_dna", (adjustments.get("project_dna") || 0) - 1);
    adjustments.set("principles", (adjustments.get("principles") || 0) - 1);
    adjustments.set("pre_read_files", (adjustments.get("pre_read_files") || 0) + 1);  // model reads its own
  }

  // ── Complexity-driven adjustments ──────────────────────────────────────

  if (complexity === "high") {
    // High complexity: include everything, promote useful layers
    adjustments.set("brain_memories", (adjustments.get("brain_memories") || 0) - 1);
    adjustments.set("principles", (adjustments.get("principles") || 0) - 1);
    adjustments.set("session_pins", (adjustments.get("session_pins") || 0) - 1);
  }

  if (complexity === "low") {
    // Low complexity (quick answer, typo fix): aggressively lean context.
    // Only core instructions + rules + identity + brief survive.
    // Everything else is demoted to EXPENDABLE so the budget drops them.
    // This cuts system prompt from ~5,500 to ~2,400 tokens.
    adjustments.set("pane_guide", +3);          // critical → useful (compressed guide, cut for simple tasks)
    adjustments.set("relevant_files", +3);      // useful → expendable
    adjustments.set("project_dna", +2);         // high → useful
    adjustments.set("brain_memories", +3);      // useful → expendable
    adjustments.set("symbol_map", +3);          // useful → expendable
    adjustments.set("principles", +3);          // useful → expendable
    adjustments.set("pre_read_files", +3);      // important → expendable
    adjustments.set("mind_entries", +3);        // useful → expendable
    adjustments.set("session_pins", +3);        // useful → expendable
    adjustments.set("handoff", +3);             // useful → expendable
    adjustments.set("global_memory", +2);       // expendable → beyond expendable
    adjustments.set("profile_atoms", +2);       // expendable → beyond expendable
    adjustments.set("profile_digest", +2);      // important → optional
  }

  // ── Escalation: boost everything exploration-related ───────────────────

  if (escalation >= 2) {
    adjustments.set("escalation", -2);        // make it critical priority
    adjustments.set("brain_memories", (adjustments.get("brain_memories") || 0) - 1);
  }

  // ── Conversation depth: early turns need handoff, later turns don't ────

  if (historyLength < 2) {
    adjustments.set("handoff", -1);           // useful → important on session start
  }
  if (historyLength >= 8) {
    // Deep in conversation: demote handoff/orientation, boost working context
    adjustments.set("handoff", +2);
    adjustments.set("orientation", +1);
    adjustments.set("recent_actions", (adjustments.get("recent_actions") || 0) - 1);
  }

  // ── Brain richness: if brain has good data, promote its layers ────────

  const hasRichMemories = (brainCtx?.memories || []).filter(m => (m.confidence || 0) >= 0.75).length >= 3;
  const hasSymbols = (brainCtx?.relevantSymbols || []).length >= 5;
  const hasPrinciples = (brainCtx?.principles || []).length >= 2;

  if (hasRichMemories) {
    adjustments.set("brain_memories", (adjustments.get("brain_memories") || 0) - 1);
  }
  if (hasSymbols) {
    adjustments.set("symbol_map", (adjustments.get("symbol_map") || 0) - 1);
  }
  if (hasPrinciples) {
    adjustments.set("principles", (adjustments.get("principles") || 0) - 1);
  }

  return adjustments;
}

/**
 * Apply relevance adjustments to layers, clamping to valid priority range.
 */
function applyRelevanceAdjustments(layers, adjustments) {
  for (const layer of layers) {
    const delta = adjustments.get(layer.name) || 0;
    if (delta !== 0) {
      layer.priority = Math.max(PRIORITY.CRITICAL, Math.min(PRIORITY.EXPENDABLE, layer.priority + delta));
    }
  }
}

// ---------------------------------------------------------------------------
// Layer definitions — each layer is a named unit with a priority and a builder
// function that returns its text content. The orchestrator assembles them in
// priority order, stopping when the budget is exhausted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lean context — for CLI backends (Claude SDK, Gemini CLI) that manage
// their own context, tools, and conversation history. Pane provides only
// identity + rules + arbiter findings + MCP orientation.
// ---------------------------------------------------------------------------

function _buildLeanContext(projectId, isResume) {
  const parts = [];

  // ── Developer Identity: condensed behavioral identity (~120 tokens) ──
  // Replaces separate rules/philosophy/identity/anti-patterns injections.
  // The identity is compiled from the user's profile files and cached to disk.
  const identity = getIdentity();
  if (identity) parts.push(identity);

  // On resume, the SDK already has full context — just DNA + arbiter
  if (!isResume) {
    // MCP orientation — tell the model where to find context
    parts.push(
      "Project context, memory, symbols, codebase structure, and intelligence are available via pane_ MCP tools. " +
      "Call pane_project_context to orient yourself. Use pane_find_symbol for code navigation, pane_recall for project memory, " +
      "pane_brief for the project brief, and pane_synthesize for architectural overview."
    );
  }

  // Arbiter findings — if unresolved errors exist, the model must see them immediately
  const verdict = readVerdict(projectId);
  const arbiterText = formatVerdictForContext(verdict);
  if (arbiterText) {
    parts.push("", arbiterText);
  }

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

  // Return same shape as full orchestrateContext for compatibility
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

/**
 * Build all context layers independently so the orchestrator can measure
 * and prioritize them. Returns an array of { name, priority, placement, tier, text }.
 *
 * placement: "stable" | "dynamic" — backward compat with old callers.
 * tier: "frozen" | "session" | "turn" — three-tier caching model:
 *   frozen  — never changes within a session (identity, rules, brief, DNA)
 *   session — changes when files/scope change (relevant files)
 *   turn    — changes every turn (git, todos, actions, memories, symbols)
 */
function buildLayers(projectId, intent, historyLength, backend, sqliteChanges, lastInjected = null) {
  const layers = [];

  // ── Read shared data sources once ──────────────────────────────────────
  // Prefer in-memory ContextStore (updated by brain-engine via main.mjs).
  // Fall back to disk for cold start (app launch before first brain search).
  const storeCtx = contextStore.getContext(projectId);
  let contextShape = storeCtx?.contextShape || null;
  if (!contextShape) {
    try {
      contextShape = JSON.parse(fs.readFileSync(
        path.join(BRAIN_DIR, "context", `${projectId}-shape.json`), "utf-8"
      ));
    } catch {}
  }

  let brainCtx = storeCtx?.brainExport || null;
  if (!brainCtx) {
    try {
      brainCtx = JSON.parse(fs.readFileSync(
        path.join(BRAIN_DIR, "context", `${projectId}.json`), "utf-8"
      ));
    } catch {}
  }
  if (!brainCtx) brainCtx = { memories: [], tensions: [], atoms: [], profileAtoms: [], relevantFiles: [], authoritativeDecisions: [] };

  let state;
  try {
    state = JSON.parse(fs.readFileSync(
      path.join(SESSION_DIR, projectId, "state.json"), "utf-8"
    ));
  } catch {
    state = {
      activeTask: null, todos: [], workingSet: [], decisions: [],
      recentActions: [], methodNotes: [], gitStatus: null,
      turnCount: 0, lastProvider: null, lastIntent: null,
      startedAt: Date.now(), phase: "idle",
    };
  }

  // ── Detect conversation phase for atom filtering ───────────────────────
  const activeTodos = (state.todos || []).filter(t => t.status !== "completed");
  const completedTodos = (state.todos || []).filter(t => t.status === "completed");
  const lastActions = (state.recentActions || []).slice(0, 3).map(a => a.type || "");
  const conversationPhase = detectPhase({
    turnCount: historyLength,
    lastToolActions: lastActions,
    taskType: contextShape?.taskType || "other",
    mode: contextShape?.mode || intent || "direct",
    pendingTodos: activeTodos.length,
    completedTodos: completedTodos.length,
    hasNewFiles: false, // TODO: track working set changes between turns
  });

  // ── Delta mode: on turn 2+, skip session-stable layers that the model ──
  // already has in its context window. Only inject genuine deltas.
  // The model's context IS the memory — we don't need to re-tell it.
  const isFullAssembly = !lastInjected || lastInjected.turnNumber === 0;

  // ── 0. CORE INSTRUCTIONS (critical) ────────────────────────────────────
  const coreInstructions = _buildSystemPromptFromAtoms(
    brainCtx.atoms || null,
    contextShape?.taskType || null,
    contextShape?.complexity || null,
    backend,
    conversationPhase,
    historyLength,
  );
  layers.push({
    name: "core_instructions",
    priority: PRIORITY.CRITICAL,
    placement: "stable",
    tier: "frozen",
    text: coreInstructions,
  });

  // ── 0. PANE INTELLIGENCE GUIDE (critical) ──────────────────────────────
  layers.push({
    name: "pane_guide",
    priority: PRIORITY.CRITICAL,
    placement: "stable",
    tier: "frozen",
    text: _buildPaneGuide(),
  });

  // ── IDENTITY (~120 tokens) ──────────────────────────────────────────
  // Condensed behavioral identity compiled from rules.md + philosophy.md +
  // identity.json. Written as identity ("you are"), not rules ("don't do").
  // The arbiter enforces compliance — the identity sets the standard.
  const identity = getIdentity();
  if (identity) {
    layers.push({
      name: "identity",
      priority: PRIORITY.CRITICAL,
      placement: "stable",
      tier: "frozen",
      text: identity,
    });
  }

  // ── 1. PROJECT BRIEF (high) ───────────────────────────────────────────
  const shouldIncludeBrief = contextShape?.includeBrief !== false
    || (contextShape?.complexity !== "low");
  if (shouldIncludeBrief) {
    let brief = "";
    try {
      brief = fs.readFileSync(path.join(MEMORY_DIR, projectId, "brief.md"), "utf-8").trim();
      if (brief.length > 4500) {
        const truncated = brief.slice(0, 4500);
        const lastSection = truncated.lastIndexOf("\n###");
        brief = lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
      }
    } catch {}
    if (brief) {
      layers.push({
        name: "project_brief",
        priority: PRIORITY.HIGH,
        placement: "stable",
        tier: "frozen",
        text: brief,
      });
    }
  }

  // ── 1. ABOUT (high) — project purpose + identity ─────────────────────
  // Single per-project file (~/.pane/memory/{projectId}/about.md).
  if (!projectId.startsWith("mind:")) {
    let projectAbout = "";
    try {
      projectAbout = fs.readFileSync(path.join(MEMORY_DIR, projectId, "about.md"), "utf-8").trim();
    } catch {}

    if (projectAbout) {
      layers.push({
        name: "project_about",
        priority: PRIORITY.HIGH,
        placement: "stable",
        tier: "frozen",
        text: [
          "## About",
          projectAbout,
          "Treat this as active criteria, not background. When suggesting approaches or evaluating trade-offs, reason against this purpose — name tensions when something conflicts, and use it as a tie-breaker when alternatives are close. If a request would move the project away from this purpose, say so.",
        ].join("\n"),
      });
    } else if (historyLength < 4) {
      layers.push({
        name: "about_exploration",
        priority: PRIORITY.IMPORTANT,
        placement: "dynamic",
        tier: "turn",
        text: [
          "This project has no recorded context yet. Before answering, understand what it is trying to be.",
          "",
          "Ask one question at a time — start with: what is this project, and what problem does it solve? Follow the thread naturally: who is it for, where is it headed, what it deliberately isn't. Three solid answers is enough.",
          "",
          "Once you have a clear picture, call pane_set_about with a concise synthesis (2-4 sentences), then answer the original message with that context.",
          "",
          "If the first message is urgent (crash, broken build, critical bug), answer it first — explore purpose on the next turn.",
        ].join("\n"),
      });
    } else {
      layers.push({
        name: "about_reminder",
        priority: PRIORITY.OPTIONAL,
        placement: "dynamic",
        tier: "turn",
        text: "Note: This project has no recorded context yet. If a natural opening arises, ask about the project's goals and call pane_set_about to record them.",
      });
    }
  }

  // ── 3. RELEVANT FILES (useful) ────────────────────────────────────────
  const relevantFiles = (brainCtx.relevantFiles || []).slice(0, 5);
  if (relevantFiles.length >= 3) {
    const ordered = [...relevantFiles].sort((a, b) => {
      const rank = (p) => {
        const lp = (p || "").toLowerCase();
        if (lp.includes("config") || lp.includes("types") || lp.includes("schema") || lp.includes("model")) return 0;
        if (lp.includes("lib/") || lp.includes("util") || lp.includes("core") || lp.includes("engine")) return 1;
        if (lp.includes("api") || lp.includes("handler") || lp.includes("route") || lp.includes("backend") || lp.includes("worker")) return 2;
        if (lp.includes("hook") || lp.includes("store") || lp.includes("context")) return 3;
        if (lp.includes("component") || lp.includes("page") || lp.includes("view") || lp.includes(".tsx") || lp.includes(".jsx")) return 4;
        if (lp.includes("test") || lp.includes("spec")) return 5;
        return 3;
      };
      return rank(a.path) - rank(b.path);
    });
    const lines = ["Suggested approach order for this task:"];
    ordered.forEach((f, i) => lines.push(`${i + 1}. ${f.path} — ${f.description}`));
    layers.push({
      name: "relevant_files",
      priority: PRIORITY.USEFUL,
      placement: "stable",
      tier: "session",
      text: lines.join("\n"),
    });
  } else if (relevantFiles.length > 0) {
    const lines = ["Files most likely to need changes:"];
    for (const f of relevantFiles) lines.push(`- ${f.path} — ${f.description}`);
    layers.push({
      name: "relevant_files",
      priority: PRIORITY.USEFUL,
      placement: "stable",
      tier: "session",
      text: lines.join("\n"),
    });
  }

  // ── 5. GLOBAL MEMORY (expendable) ─────────────────────────────────────
  try {
    const globalMemoryPath = path.join(os.homedir(), ".gemini", "memory.md");
    if (fs.existsSync(globalMemoryPath)) {
      const globalMemory = fs.readFileSync(globalMemoryPath, "utf-8").trim();
      if (globalMemory) {
        layers.push({
          name: "global_memory",
          priority: PRIORITY.EXPENDABLE,
          placement: "stable",
          tier: "frozen",
          text: `## Global Memory\n${globalMemory}`,
        });
      }
    }
  } catch {}

  // ── 2. SYSTEM INFO (important — always tiny) ──────────────────────────
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  layers.push({
    name: "system_info",
    priority: PRIORITY.IMPORTANT,
    placement: "dynamic",
    text: `Current Time: ${dateStr}, ${timeStr}\nOS: ${process.platform}\nUser: ${os.userInfo().username}`,
  });

  // ── 2. SESSION STATE (important) ──────────────────────────────────────
  const sessionLines = [];

  // Task state: ONLY on first turn (cross-session continuity).
  // On turn 2+, the conversation history already has the plan and work.
  // Injecting stale activeTask/todos mid-conversation causes the model to
  // follow stale objectives instead of the live conversation.
  if (historyLength < 2) {
    const activeTodos = (state.todos || []).filter(t => t.status !== "completed");

    if (state.activeTask && activeTodos.length > 0) {
      sessionLines.push(`Current objective: ${state.activeTask.description}`);
      if (state.activeTask.goal) sessionLines.push(`Goal: ${state.activeTask.goal}`);
      sessionLines.push("");
    }
    if (activeTodos.length > 0) {
      sessionLines.push("Task list:");
      for (const t of activeTodos) {
        const mark = t.status === "in_progress" ? "[→]" : "[ ]";
        sessionLines.push(`${mark} ${t.content}`);
      }
      sessionLines.push("");
    }
  }

  if (isFullAssembly) {
    // Turn 1: inject full git status
    if (state.gitStatus) {
      sessionLines.push(`Git status (branch: ${state.gitStatus.branch}):`);
      sessionLines.push(state.gitStatus.summary);
      sessionLines.push("");
    }
  } else {
    // Turn 2+: only inject git delta if it changed
    const currentGit = state.gitStatus?.summary || "";
    if (currentGit && currentGit !== lastInjected.gitSummary) {
      sessionLines.push(`[Git update]: ${state.gitStatus.branch} — ${currentGit}`);
      sessionLines.push("");
    }
    // Inject todo delta if changed
    const currentTodos = JSON.stringify((state.todos || []).filter(t => t.status !== "completed").map(t => t.content));
    if (currentTodos !== lastInjected.todoSnapshot) {
      const completed = (state.todos || []).filter(t => t.status === "completed");
      const pending = (state.todos || []).filter(t => t.status !== "completed");
      if (completed.length > 0) sessionLines.push(`[Completed]: ${completed.map(t => t.content).join(", ")}`);
      if (pending.length > 0) sessionLines.push(`[Still pending]: ${pending.map(t => t.content).join(", ")}`);
      sessionLines.push("");
    }
  }

  if (sessionLines.length > 0) {
    layers.push({
      name: "session_state",
      priority: PRIORITY.IMPORTANT,
      placement: "dynamic",
      tier: "turn",
      text: sessionLines.join("\n"),
    });
  }

  // ── 2. WORKING SET + FILE SCOPE (important) ───────────────────────────
  if (state.workingSet.length > 0) {
    const wsLines = ["Files in scope — do not touch files outside this list unless explicitly asked:"];
    for (const f of state.workingSet.slice(0, 6)) {
      wsLines.push(`- ${f.path}${f.purpose ? ` — ${f.purpose}` : ""}`);
    }
    layers.push({
      name: "working_set",
      priority: PRIORITY.IMPORTANT,
      placement: "dynamic",
      tier: "turn",
      text: wsLines.join("\n"),
    });
  }

  // ── 2. PRE-READ FILES (important — biggest token consumer) ────────────
  if (state.workingSet.length > 0) {
    const localFileDepth = contextShape?.fileDepth || "shallow";
    const skipPreRead = localFileDepth === "none" || localFileDepth === "names";

    if (!skipPreRead) {
      const PRE_READ_MAX_FILES = localFileDepth === "deep" ? 5 : 3;
      const PRE_READ_MAX_LINES = localFileDepth === "deep" ? 120 : 80;
      const PRE_READ_MAX_CHARS = localFileDepth === "deep" ? 25000 : 15000;
      let preReadChars = 0;
      const preReadParts = [];

      for (const f of state.workingSet.slice(0, PRE_READ_MAX_FILES)) {
        if (preReadChars >= PRE_READ_MAX_CHARS) break;
        try {
          const raw = fs.readFileSync(f.path, "utf-8");
          const lines = raw.split("\n").slice(0, PRE_READ_MAX_LINES);
          const content = lines.join("\n");
          const remaining = PRE_READ_MAX_CHARS - preReadChars;
          const truncated = content.length > remaining ? content.slice(0, remaining) + "\n[...truncated]" : content;
          preReadParts.push(`### ${f.path}\n\`\`\`\n${truncated}\n\`\`\``);
          preReadChars += truncated.length;
        } catch {}
      }

      if (preReadParts.length > 0) {
        layers.push({
          name: "pre_read_files",
          priority: PRIORITY.IMPORTANT,
          placement: "dynamic",
          text: "Pre-read file contents (Pane has read these — do not re-read unless they have changed since):\n" + preReadParts.join("\n\n"),
        });
      }
    }
  }

  // ── 0. AUTHORITATIVE DECISIONS (critical, frozen) ────────────────────
  // High-confidence decisions from the brain's accumulated evidence.
  // Injected every turn — never delta'd out. The model must not contradict
  // these without explicit user confirmation.
  const authDecisions = brainCtx?.authoritativeDecisions || [];
  if (authDecisions.length > 0) {
    const lines = [
      "## Authoritative Decisions",
      "",
      "These decisions have accumulated enough evidence to be treated as binding constraints. Do not contradict them unless the user explicitly asks you to reconsider.",
      "",
    ];
    for (const d of authDecisions) {
      const label = d.confidence >= 0.90 ? " [confirmed]" : "";
      lines.push(`- ${d.content}${label}`);
    }
    lines.push("");
    lines.push(
      "If you must override one of these, state which decision you're contradicting and why, " +
      "then wait for explicit confirmation before proceeding. Do not silently contradict."
    );
    layers.push({
      name: "authoritative_decisions",
      priority: PRIORITY.CRITICAL,
      placement: "stable",
      tier: "frozen",
      text: lines.join("\n"),
    });
  }

  // ── 2. RECENT ACTIONS (important) ─────────────────────────────────────
  const hasSqliteChanges = Array.isArray(sqliteChanges) && sqliteChanges.length > 0;
  if (hasSqliteChanges || (state.recentActions && state.recentActions.length > 0)) {
    const actionLines = ["What has been done:"];

    if (hasSqliteChanges) {
      for (const c of sqliteChanges.slice(0, 10)) {
        const type = (c.old_string || c.oldString) ? "edit" : "write";
        actionLines.push(`- [${type}] ${c.file_path || c.file}`);
      }
    }

    const fileTypes = ["file_edit", "write", "edit", "Write", "Edit"];
    const nonFileActions = (state.recentActions || []).filter(a =>
      !hasSqliteChanges || !fileTypes.includes(a.type)
    ).slice(0, 8);

    for (const a of nonFileActions) {
      actionLines.push(`- [${a.type}] ${a.content}`);
    }

    layers.push({
      name: "recent_actions",
      priority: PRIORITY.IMPORTANT,
      placement: "dynamic",
      tier: "turn",
      text: actionLines.join("\n"),
    });
  }

  // ── 3. SYMBOLS, MEMORIES, PRINCIPLES ──────────────────────────────────
  // Session-stable: injected fully on turn 1, skipped on turn 2+ (model
  // already has them in context window). Only inject DELTAS — new symbols
  // or memories that appeared since last assembly.
  const relevantSymbols = (brainCtx.relevantSymbols || []).slice(0, 15);
  const memories = (brainCtx.memories || []).filter(m => (m.confidence || 0) >= 0.75);
  const principles = brainCtx.principles || [];

  if (isFullAssembly) {
    // Turn 1: full injection
    if (relevantSymbols.length > 0) {
      const lines = ["Symbol map (Pane resolved — use directly, do not search for these):"];
      for (const s of relevantSymbols) {
        const doc = s.doc ? ` — ${s.doc}` : "";
        lines.push(`- \`${s.name}\` (${s.kind}) → ${s.file_path || s.file}:${s.line}${doc}`);
      }
      layers.push({ name: "symbol_map", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "session", text: lines.join("\n") });
    }
    if (memories.length > 0) {
      const lines = ["Relevant context from prior work:"];
      for (const mem of memories) lines.push(`- ${mem.content}`);
      layers.push({ name: "brain_memories", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "session", text: lines.join("\n") });
    }
    if (principles.length > 0) {
      const lines = ["Active project standards (extracted from how you work on this project — apply when relevant):"];
      for (const p of principles) lines.push(`- ${p.content}`);
      layers.push({ name: "principles", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "session", text: lines.join("\n") });
    }
  } else {
    // Turn 2+: only inject new symbols/memories not in the previous snapshot
    const newSymbols = relevantSymbols.filter(s => !lastInjected.symbolNames?.has(s.name));
    if (newSymbols.length > 0) {
      const lines = ["[New symbols since last turn]:"];
      for (const s of newSymbols) {
        const doc = s.doc ? ` — ${s.doc}` : "";
        lines.push(`- \`${s.name}\` (${s.kind}) → ${s.file_path || s.file}:${s.line}${doc}`);
      }
      layers.push({ name: "symbol_delta", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "turn", text: lines.join("\n") });
    }
    const newMemories = memories.filter(m => !lastInjected.memoryIds?.has(m.id));
    if (newMemories.length > 0) {
      const lines = ["[New context since last turn]:"];
      for (const mem of newMemories) lines.push(`- ${mem.content}`);
      layers.push({ name: "memory_delta", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "turn", text: lines.join("\n") });
    }
    // Principles don't change mid-conversation — skip entirely on turn 2+
  }

  // ── 2. ESCALATION (important when active) ─────────────────────────────
  if (contextShape?.escalationStage >= 2) {
    layers.push({
      name: "escalation",
      priority: PRIORITY.IMPORTANT,
      placement: "dynamic",
      tier: "turn",
      text: _buildEscalation(contextShape),
    });
  }

  // ── 3. MIND ENTRIES + SESSION PINS (session-stable) ──────────────────
  // Injected on turn 1, skipped on turn 2+ (model has them in context).
  const mindEntries = brainCtx.mindEntries || [];
  let sessionPins = [];
  try {
    sessionPins = JSON.parse(fs.readFileSync(
      path.join(MEMORY_DIR, projectId, "session-pins.json"), "utf-8"
    ));
  } catch {}

  if (isFullAssembly) {
    if (mindEntries.length > 0) {
      const lines = ["Active thoughts from Mind (user-authored, treat as high-priority context):"];
      for (const m of mindEntries) lines.push(`- ${m.content}`);
      layers.push({ name: "mind_entries", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "session", text: lines.join("\n") });
    }
    if (sessionPins.length > 0) {
      const lines = ["Active commitments:"];
      for (const pin of sessionPins.slice(0, 6)) {
        const label = pin.type === "error_fix" ? "Fix" : pin.type === "lesson" ? "Lesson" : "Decision";
        lines.push(`- [${label}] ${pin.content}`);
      }
      layers.push({ name: "session_pins", priority: PRIORITY.USEFUL, placement: "dynamic", tier: "session", text: lines.join("\n") });
    }
  }
  // Turn 2+: mind entries and pins already in context — skip

  // ── 3. HANDOFF (useful — session start only) ──────────────────────────
  if (historyLength < 2) {
    const handoffText = _buildHandoff(projectId);
    if (handoffText) {
      layers.push({
        name: "handoff",
        priority: PRIORITY.USEFUL,
        placement: "dynamic",
        text: handoffText,
      });
    }
  }

  // ── 4. SESSION ORIENTATION (optional) ─────────────────────────────────
  if (historyLength >= 4) {
    const orientationParts = [`[Turn ${historyLength}.`];
    if (state.activeTask) orientationParts.push(`Working on: ${state.activeTask.description}.`);
    const activeTodo = (state.todos || []).find(t => t.status === "in_progress");
    if (activeTodo) orientationParts.push(`Current step: ${activeTodo.content}.`);
    if (sessionPins.length > 0) {
      const topPins = sessionPins.slice(0, 2).map(p => p.content).join("; ");
      orientationParts.push(`Commitments still active: ${topPins}.`);
    }
    orientationParts.push("]");
    layers.push({
      name: "orientation",
      priority: PRIORITY.OPTIONAL,
      placement: "dynamic",
      tier: "turn",
      text: orientationParts.join(" "),
    });
  }

  // ── 2. INTENT DIRECTIVE (important) ───────────────────────────────────
  const taskType    = contextShape?.taskType || null;
  const complexity  = contextShape?.complexity || null;
  const reasoning   = contextShape?.reasoning || null;
  const verification = contextShape?.verification || null;

  // ── INTENT DIRECTIVE (session-stable) ────────────────────────────────
  // Set once from the mode pill on turn 1, frozen after. This is the
  // "DISCUSSION mode" / "EXECUTION mode" label. When effectiveMode carries
  // forward, this never changes — the model gets consistent instructions.
  if (isFullAssembly) {
    let directiveText;
    if (contextShape && taskType) {
      directiveText = _buildDirective(intent, taskType, complexity, reasoning, verification);
    } else if (intent === "execute") {
      directiveText = "EXECUTION mode. Do what's asked directly and efficiently. Skip planning unless absolutely necessary.";
    } else if (intent === "plan") {
      directiveText = "PLANNING mode. Think deeply, explore architecture space, consider tradeoffs, surface tensions with past decisions. End with a clear recommendation and wait for confirmation before making changes.";
    } else if (intent === "explain") {
      directiveText = "DISCUSSION mode. Clear, detailed, accurate explanations with code examples where appropriate.";
    } else {
      directiveText = "For non-trivial tasks, present a brief plan and end with: \"Ready to proceed — send 'go' to start.\" Wait for confirmation before making changes. For simple tasks, just do them.";
    }
    layers.push({
      name: "intent_directive",
      priority: PRIORITY.IMPORTANT,
      placement: "dynamic",
      tier: "session",
      text: directiveText,
    });
  }
  // Turn 2+: directive already in context — skip

  // ── 4. BEHAVIORAL FENCE (session-stable) ─────────────────────────────
  if (isFullAssembly && (state.activeTask || state.workingSet.length > 0)) {
    const fence = ["Behavioral constraints:"];
    if (state.activeTask) fence.push(`- Objective: ${state.activeTask.description}`);
    if (state.workingSet.length > 0) {
      const inScope = state.workingSet.slice(0, 6).map(f => f.path).join(", ");
      fence.push(`- In scope: ${inScope}`);
      fence.push(`- Do not touch files outside this scope — if you must, state why before proceeding`);
    }
    if (state.decisions.length > 0) fence.push(`- Locked decisions must not be contradicted or undone`);
    fence.push(`- Every action must trace back to the current objective`);
    fence.push(`- If you find yourself acting outside scope, stop and explain before continuing`);
    layers.push({
      name: "behavioral_fence",
      priority: PRIORITY.OPTIONAL,
      placement: "dynamic",
      tier: "turn",
      text: fence.join("\n"),
    });
  }

  // ── 4. METHOD COMPLIANCE (optional) ───────────────────────────────────
  if (state.methodNotes?.length > 0) {
    const lines = ["⚠ Pane detected method violations on the previous turn. Correct these now:"];
    for (const note of state.methodNotes) lines.push(`- ${note.content}`);
    layers.push({
      name: "method_compliance",
      priority: PRIORITY.OPTIONAL,
      placement: "dynamic",
      tier: "turn",
      text: lines.join("\n"),
    });
  }

  // ── 5. ARBITER FINDINGS (critical) ──────────────────────────────────
  // Turn Sentinel writes a verdict after each turn. If unresolved errors
  // exist, inject them at CRITICAL priority so the LLM must fix them
  // before taking on new work.
  const verdict = readVerdict(projectId);
  const arbiterText = formatVerdictForContext(verdict);
  if (arbiterText) {
    layers.push({
      name: "arbiter_findings",
      priority: PRIORITY.CRITICAL,
      placement: "dynamic",
      tier: "turn",
      text: arbiterText,
    });
  }

  // ── 6. QUALITY TREND (important, only when concerning) ─────────────
  // Behavioral fingerprinting: inject quality stats when metrics degrade.
  // Not CRITICAL — doesn't block work, but nudges the LLM to improve.
  try {
    const qdb = getPaneDb();
    const qualityText = formatQualityStatsForContext(qdb, projectId);
    if (qualityText) {
      layers.push({
        name: "quality_trend",
        priority: PRIORITY.IMPORTANT,
        placement: "dynamic",
        tier: "turn",
        text: qualityText,
      });
    }
  } catch {}

  // ── 7. PROACTIVE GUIDANCE (useful) ──────────────────────────────────
  // Senior-dev suggestions from the Turn Sentinel. Not errors — the code
  // works. But a senior developer would flag these patterns.
  if (verdict?.guidance) {
    const guidanceText = formatGuidanceForContext(verdict.guidance);
    if (guidanceText) {
      layers.push({
        name: "proactive_guidance",
        priority: PRIORITY.USEFUL,
        placement: "dynamic",
        tier: "turn",
        text: guidanceText,
      });
    }
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Budget allocation and assembly
// ---------------------------------------------------------------------------

/**
 * Orchestrate context assembly with token budget management.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} options.intent - "execute" | "plan" | "explain" | "other"
 * @param {number} options.historyLength - conversation turn count
 * @param {string} options.backend - "claude-code" | "http" | "gemini"
 * @param {string} options.model - model identifier for context limit lookup
 * @param {*} options.sqliteChanges - recent file changes from SQLite
 * @param {number} options.conversationTokens - estimated tokens used by conversation history (default 0)
 * @param {number} options.outputBudget - tokens reserved for model output (default 8192)
 * @returns {{ stable, dynamic, full, budget, layers }}
 */
export function orchestrateContext(projectId, options = {}) {
  const {
    intent = "other",
    historyLength = 0,
    backend = "claude-code",
    model = null,
    sqliteChanges = null,
    conversationTokens = 0,
    outputBudget = 8192,
    mode = "full",       // "full" (HTTP backends) or "lean" (CLI backends)
    isResume = false,     // true when resuming an existing CLI session
  } = options;

  // ── Lean mode: minimal context for CLI backends that manage their own context.
  // Identity + rules + arbiter findings + MCP orientation. ~500 tokens.
  if (mode === "lean") {
    return _buildLeanContext(projectId, isResume);
  }

  const contextLimit = getModelLimit(model);
  const effectiveOutputBudget = outputBudget || getDefaultOutputBudget(model);

  // Create a request budget tracker for diagnostics
  const requestBudget = createRequestBudget(model, conversationTokens);

  // Reserve space for conversation history + output
  const systemBudget = Math.max(
    4000, // absolute minimum — core instructions alone
    contextLimit - conversationTokens - effectiveOutputBudget
  );

  // Build all layers — pass lastInjected for delta-aware assembly on turn 2+
  const lastInjected = contextStore.getLastInjected(projectId);
  const allLayers = buildLayers(projectId, intent, historyLength, backend, sqliteChanges, lastInjected);

  // ── Relevance Engine: adjust priorities based on intent, complexity, brain data ──
  // Read from in-memory ContextStore (updated by brain-engine via main.mjs).
  // Fall back to disk for cold start.
  const orchStoreCtx = contextStore.getContext(projectId);
  let contextShape = orchStoreCtx?.contextShape || null;
  if (!contextShape) {
    try {
      contextShape = JSON.parse(fs.readFileSync(
        path.join(BRAIN_DIR, "context", `${projectId}-shape.json`), "utf-8"
      ));
    } catch {}
  }
  let brainCtx = orchStoreCtx?.brainExport || null;
  if (!brainCtx) {
    try {
      brainCtx = JSON.parse(fs.readFileSync(
        path.join(BRAIN_DIR, "context", `${projectId}.json`), "utf-8"
      ));
    } catch {}
  }
  if (!brainCtx) brainCtx = { memories: [], tensions: [], atoms: [], relevantSymbols: [], principles: [], authoritativeDecisions: [] };

  const relevanceAdjustments = computeRelevanceAdjustments(contextShape, brainCtx, intent, historyLength);
  applyRelevanceAdjustments(allLayers, relevanceAdjustments);

  // ── Debug logging: PANE_DEBUG_CONTEXT=1 dumps relevance engine decisions ──
  if (process.env.PANE_DEBUG_CONTEXT === "1") {
    const adjLog = [...relevanceAdjustments.entries()]
      .map(([name, delta]) => `${name}: ${delta > 0 ? "+" : ""}${delta}`)
      .join(", ");
    const typeSummary = allLayers.map(l => `${l.name}(p${l.priority})`).join(", ");
    console.log(`[context] ${projectId} turn=${historyLength} intent=${intent} task=${contextShape?.taskType || "?"}`);
    console.log(`[context] adjustments: ${adjLog || "(none)"}`);
    console.log(`[context] layers (post-adjustment): ${typeSummary}`);
    console.log(`[context] budget: limit=${contextLimit} systemBudget=${systemBudget} conversation=${conversationTokens} output=${effectiveOutputBudget}`);
  }

  // Estimate tokens for each layer
  for (const layer of allLayers) {
    layer.tokens = estimateTokens(layer.text);
  }

  // Sort by priority (lower = more important), then by token count (smaller first within same priority)
  allLayers.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.tokens - b.tokens;
  });

  // Assemble within budget
  const includedLayers = [];
  const droppedLayers = [];
  let usedTokens = 0;

  for (const layer of allLayers) {
    if (usedTokens + layer.tokens <= systemBudget) {
      // Fits entirely
      includedLayers.push(layer);
      usedTokens += layer.tokens;
    } else if (layer.priority <= PRIORITY.HIGH) {
      // Critical/high layers get truncated rather than dropped
      const remainingTokens = systemBudget - usedTokens;
      if (remainingTokens > 200) { // only truncate if meaningful space remains
        const maxChars = remainingTokens * CHARS_PER_TOKEN;
        const truncated = layer.text.slice(0, maxChars);
        const lastNewline = truncated.lastIndexOf("\n");
        layer.text = (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + "\n[...truncated — budget limit]";
        layer.tokens = estimateTokens(layer.text);
        layer.truncated = true;
        includedLayers.push(layer);
        usedTokens += layer.tokens;
      } else {
        droppedLayers.push(layer);
      }
    } else {
      // Lower priority — drop entirely
      droppedLayers.push(layer);
    }
  }

  // ── Debug logging: log what was included vs dropped ──────────────────────
  if (process.env.PANE_DEBUG_CONTEXT === "1") {
    const included = includedLayers.map(l => `${l.name}(${l.tokens}t)`).join(", ");
    const dropped = droppedLayers.map(l => `${l.name}(p${l.priority},${l.tokens}t)`).join(", ");
    console.log(`[context] included (${includedLayers.length}): ${included}`);
    if (droppedLayers.length > 0) console.log(`[context] dropped (${droppedLayers.length}): ${dropped}`);
    console.log(`[context] used: ${usedTokens}/${systemBudget} tokens (${(usedTokens / systemBudget * 100).toFixed(0)}%)`);
  }

  // Assemble tiers (ordering: frozen first, session next, turn last)
  const frozenText  = includedLayers.filter(l => l.tier === "frozen").map(l => l.text).join("\n\n");
  const sessionText = includedLayers.filter(l => l.tier === "session").map(l => l.text).join("\n\n");
  const turnText    = includedLayers.filter(l => l.tier === "turn").map(l => l.text).join("\n\n");

  // Backward compat: stable = frozen + session, dynamic = turn
  const stable  = [frozenText, sessionText].filter(Boolean).join("\n\n");
  const dynamic = turnText;
  const full    = [frozenText, sessionText, turnText].filter(Boolean).join("\n\n");

  // Update request budget tracker with actual system tokens
  requestBudget.addSystem(usedTokens);

  const result = {
    // New tiered API — used by cache-aware backends
    frozen: frozenText,
    session: sessionText,
    turn: turnText,
    // Backward compat
    stable,
    dynamic,
    full,
    budget: {
      limit: contextLimit,
      systemBudget,
      systemUsed: usedTokens,
      conversationTokens,
      outputBudget: effectiveOutputBudget,
      remaining: requestBudget.remaining(),
      pressure: requestBudget.pressure(),
      layersIncluded: includedLayers.length,
      layersDropped: droppedLayers.length,
      droppedNames: droppedLayers.map(l => l.name),
    },
    requestBudget, // expose tracker for downstream use
    layers: includedLayers.map(l => ({
      name: l.name,
      priority: l.priority,
      tokens: l.tokens,
      truncated: !!l.truncated,
    })),
  };

  // Auto-save context checkpoint when budget is healthy (fire-and-forget)
  if (result.budget.pressure === "low" || result.budget.pressure === "medium") {
    try {
      saveContextCheckpoint(projectId, result, { model, intent });
    } catch {}
  }

  // Save snapshot for delta tracking on subsequent turns.
  // On the FIRST full assembly, record what was injected so turn 2+ can diff.
  if (!lastInjected || lastInjected.turnNumber === 0) {
    try {
      const state = readState(projectId);
      const memories = (brainCtx?.memories || []).filter(m => (m.confidence || 0) >= 0.75);
      const symbols = (brainCtx?.relevantSymbols || []).slice(0, 15);
      contextStore.updateLastInjected(projectId, {
        memoryIds: new Set(memories.map(m => m.id).filter(Boolean)),
        symbolNames: new Set(symbols.map(s => s.name).filter(Boolean)),
        gitSummary: state?.gitStatus?.summary || "",
        todoSnapshot: JSON.stringify((state?.todos || []).filter(t => t.status !== "completed").map(t => t.content)),
        directiveText: result.turn?.slice(0, 100) || "",
        turnNumber: historyLength || 1,
      });
    } catch {}
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper builders — extracted from session-context.mjs logic
// ---------------------------------------------------------------------------

function _buildPaneGuide() {
  // Compressed guide (~100 tokens). Tool-specific behavioral guidance lives in
  // tool descriptions (http-backend.mjs / pane-mcp-server.mjs) where it has
  // maximum impact at the decision point. Task playbooks removed — models know
  // how to debug/implement. "What's in your context" list removed — the model
  // can see its own system prompt.
  return [
    "## Working in Pane",
    "",
    "Pane provides project context (about, brief, identity) at start. All other project state — file structure, working set, git status, session state, memories — is on-demand via tools. Retrieve only what you need for the task at hand.",
    "",
    "Closed loop: persist discoveries as you go. pane_remember for root causes, patterns, and decisions. pane_set_rule when the user states a preference. pane_set_about when you understand the project's purpose. A session that discovers but doesn't record forces re-discovery.",
  ].join("\n");
}

function _buildEscalation(contextShape) {
  const parts = ["⚠ ESCALATION ACTIVE — mandatory behavioral contract:", ""];
  const stage = contextShape.escalationStage;

  if (stage >= 2) {
    parts.push("STAGE 2 — EXPLORE FIRST:");
    parts.push("- You MUST read relevant files BEFORE implementing anything.");
    parts.push("- Find patterns in the codebase that inform your approach.");
    parts.push("- State what you found and what you'll do differently.");
    parts.push("- Previous approach failed — do not retry the same strategy.");
    parts.push("");
  }

  if (stage >= 3) {
    parts.push("STAGE 3 — WEB SEARCH + EXPLORE:");
    parts.push("- Search the web for docs, error messages, and similar issues.");
    parts.push("- State what you found from the web search.");
    parts.push("- THEN explore the codebase with fresh eyes.");
    parts.push("- Only implement after both web and codebase research.");
    parts.push("");
  }

  if (stage >= 4) {
    parts.push("STAGE 4 — FULL RESET:");
    parts.push("- Abandon ALL assumptions from previous attempts.");
    parts.push("- Read every relevant file as if you've never seen this codebase.");
    parts.push("- Search the web for documentation and known issues.");
    parts.push("- Decompose the problem into sub-problems.");
    parts.push("- Solve only the failing sub-problem, verify, then integrate.");
    parts.push("");
  }

  if (contextShape?.preActions?.length > 0) {
    parts.push("Pre-actions you must complete before implementing:");
    for (const action of contextShape.preActions) {
      if (action.type === "explore_codebase") {
        parts.push(`- Explore codebase for: "${action.query}"${action.deep ? " (deep — read ALL relevant files)" : ""}`);
      } else if (action.type === "web_search") {
        parts.push(`- Web search for: ${(action.queries || []).join(", ")}`);
      } else if (action.type === "clean_slate") {
        parts.push("- Start with zero assumptions from previous context");
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

function _buildHandoff(projectId) {
  let history;
  try {
    history = JSON.parse(fs.readFileSync(
      path.join(SESSION_DIR, projectId, "handoff-history.json"), "utf-8"
    ));
  } catch { return null; }

  if (!history || history.length === 0) return null;

  const now = Date.now();
  const recent = history[0];
  const recentAgeHours = (now - (recent.timestamp || 0)) / (1000 * 60 * 60);

  const normalizeItem = (item) => {
    if (!item) return null;
    if (typeof item === "string") {
      const t = item.trim();
      return t ? { text: t, confidence: 0.65, source: "legacy" } : null;
    }
    if (typeof item === "object" && item.text) {
      return {
        text: String(item.text).trim(),
        confidence: typeof item.confidence === "number" ? item.confidence : 0.65,
        source: typeof item.source === "string" ? item.source : "legacy",
      };
    }
    return null;
  };

  const visibleItems = (arr) => (arr || []).reduce((out, raw) => {
    const item = normalizeItem(raw);
    if (!item || item.confidence < 0.60) return out;
    const label = item.confidence < 0.80 ? ` (uncertain)` : "";
    out.push({ text: item.text, label });
    return out;
  }, []);

  const recentAccomplishments = visibleItems(recent.accomplishment);
  if (recentAgeHours >= 24 || recentAccomplishments.length === 0) return null;

  const parts = [];
  const ageLabel = recentAgeHours >= 6 ? ` (~${Math.round(recentAgeHours)}h ago)` : "";

  const recentCompleted = visibleItems(recent.completed_from_history || []);
  if (recentCompleted.length > 0) {
    parts.push(`Previous session completed${ageLabel} (done — do not repeat):`);
    for (const { text, label } of recentCompleted) parts.push(`✓ ${text}${label}`);
    parts.push("");
  }

  if (recentAccomplishments.length > 0) {
    parts.push(`Current session outcome${ageLabel} (just completed):`);
    for (const { text, label } of recentAccomplishments) parts.push(`✓ ${text}${label}`);
  }

  if (recent.currentObjective) parts.push(`Still working on: ${recent.currentObjective}`);

  const recentBlockers = visibleItems(recent.blockers);
  if (recentBlockers.length > 0) {
    parts.push("Unresolved blockers:");
    for (const { text, label } of recentBlockers) parts.push(`⚠ ${text}${label}`);
  }

  const recentNextSteps = visibleItems(recent.nextSteps);
  if (recentNextSteps.length > 0) {
    parts.push("Suggested next steps:");
    for (const { text, label } of recentNextSteps) parts.push(`→ ${text}${label}`);
  }

  const recentFindings = visibleItems(recent.findings);
  if (recentFindings.length > 0) {
    parts.push("Discoveries from last session:");
    for (const { text, label } of recentFindings) parts.push(`- ${text}${label}`);
  }

  // Older sessions — one-line trajectory
  for (const older of history.slice(1)) {
    const ageHrs = (now - (older.timestamp || 0)) / (1000 * 60 * 60);
    if (ageHrs >= 24) continue;
    if (!older.accomplishment?.length) continue;
    const highItems = (older.accomplishment || [])
      .map(normalizeItem)
      .filter(item => item && item.confidence >= 0.75)
      .slice(0, 2);
    if (!highItems.length) continue;
    const summary = highItems.map(i => i.text).join(", ");
    parts.push(`Earlier (~${Math.round(ageHrs)}h ago): ✓ ${summary}`);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

// ---------------------------------------------------------------------------
// System prompt builder — same as session-context.mjs
// ---------------------------------------------------------------------------

const _GEMINI_SUBAGENTS = [
  "",
  "# Available Sub-Agents",
  "",
  "Sub-agents are specialized expert agents. Each sub-agent is available as a tool of the same name. Delegate to the sub-agent with the most relevant expertise.",
  "",
  "<available_subagents>",
  "  <subagent>",
  "    <name>codebase_investigator</name>",
  "    <description>Specialized for codebase analysis, architectural mapping, and system-wide dependencies. Use for vague requests, bug root-cause analysis, refactoring, or comprehensive feature implementation.</description>",
  "  </subagent>",
  "  <subagent>",
  "    <name>generalist</name>",
  "    <description>General-purpose agent with all tools. Use for turn-intensive tasks, batch operations, high-volume output, and speculative investigations.</description>",
  "  </subagent>",
  "</available_subagents>",
].join("\n");

function _buildSystemPromptFromAtoms(unifiedAtoms, taskType, complexity, backend, conversationPhase = null, historyLength = 0) {
  const parts = [];

  // On continuation turns (historyLength >= 2), swap ORIENT for CONTINUE.
  // The model already has project context — don't tell it to re-orient.
  const isContinuation = historyLength >= 2;

  const systemAtoms = (unifiedAtoms || []).filter(a => a.entityType === "system_atom");

  if (systemAtoms.length > 0) {
    let methodAtoms = systemAtoms.filter(a => a.facet === "method").sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const ruleAtoms = systemAtoms.filter(a => a.facet === "rule").sort((a, b) => (b.score || 0) - (a.score || 0));
    const guideAtoms = systemAtoms.filter(a => a.facet === "guideline").sort((a, b) => (b.score || 0) - (a.score || 0));

    // Phase-aware filtering: drop irrelevant method atoms based on conversation phase
    if (conversationPhase) {
      methodAtoms = filterAtomsForPhase(conversationPhase, methodAtoms);
    }

    // Continuation: replace orient with continue
    if (isContinuation) {
      const continueAtom = METHOD_ATOMS.find(a => a.id === "method-continue");
      if (continueAtom) {
        methodAtoms = methodAtoms.filter(a => (a.id || a.name) !== "method-orient");
        methodAtoms.push({ ...continueAtom, content: continueAtom.text, sortOrder: continueAtom.sortOrder });
        methodAtoms.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      }
    }

    if (methodAtoms.length > 0) parts.push(methodAtoms.map(a => a.content).join("\n\n"));
    if (ruleAtoms.length > 0) {
      parts.push("", "Constraints:");
      for (const r of ruleAtoms) parts.push(`- ${r.content}`);
    }
    if (guideAtoms.length > 0) {
      parts.push("");
      for (const g of guideAtoms) parts.push(`- ${g.content}`);
    }
  } else {
    let methodAtoms = [...METHOD_ATOMS].sort((a, b) => a.sortOrder - b.sortOrder);
    if (conversationPhase) {
      methodAtoms = filterAtomsForPhase(conversationPhase, methodAtoms);
    }

    // Continuation: replace orient with continue
    if (isContinuation) {
      methodAtoms = methodAtoms.filter(a => a.id !== "method-orient");
      const continueAtom = METHOD_ATOMS.find(a => a.id === "method-continue");
      if (continueAtom) methodAtoms.push(continueAtom);
      methodAtoms.sort((a, b) => a.sortOrder - b.sortOrder);
    }

    if (methodAtoms.length > 0) parts.push(methodAtoms.map(a => a.text).join("\n\n"));
    if (RULE_ATOMS.length > 0) {
      parts.push("", "Constraints:");
      for (const r of RULE_ATOMS) parts.push(`- ${r.text}`);
    }
    if (GUIDELINE_ATOMS.length > 0) {
      parts.push("");
      for (const g of GUIDELINE_ATOMS) parts.push(`- ${g.text}`);
    }
  }

  if (backend === "gemini") parts.push(_GEMINI_SUBAGENTS);

  return parts.join("\n");
}

const TASK_DIRECTIVES = {
  debug: {
    focus: "Root-cause analysis. Reproduce → isolate → fix → verify. Follow the data, not assumptions.",
    deep: "Trace the full execution path. Consider race conditions, state mutation, and edge cases. Check error boundaries and upstream callers.",
    shallow: "Quick fix. Identify the immediate cause, patch it, verify it.",
  },
  implement: {
    focus: "Build it. Follow existing patterns. Minimal footprint — solve what's asked, nothing more.",
    deep: "Consider interfaces, error handling, edge cases, and how this interacts with the rest of the system. Plan before writing.",
    shallow: "Straightforward implementation. Write the code, match the style, move on.",
  },
  explain: {
    focus: "Clear, accurate explanation. Code examples where they help. No hand-waving.",
    deep: "Walk through the architecture. Explain why, not just what. Surface non-obvious implications and tradeoffs.",
    shallow: "Concise answer. Get to the point fast.",
  },
  architect: {
    focus: "System design. Consider constraints, tradeoffs, extensibility, and what will break.",
    deep: "Explore the solution space. Compare approaches. Surface tensions with existing decisions. End with a clear recommendation.",
    shallow: "Quick architectural judgment. State the approach and rationale.",
  },
  refactor: {
    focus: "Improve structure without changing behavior. Every step must preserve semantics.",
    deep: "Map all callers and dependencies before moving anything. Run verification after each structural change.",
    shallow: "Simple rename or extract. Make the change, verify it compiles.",
  },
  review: {
    focus: "Code review. Focus on correctness, edge cases, and maintainability. Skip style nits.",
    deep: "Check logic flow, error handling, security implications, and performance. Verify test coverage.",
    shallow: "Quick scan for obvious issues.",
  },
  analyze: {
    focus: "Deep investigation. Trace connections across modules. Report findings with root causes, implications, and recommendations.",
    deep: "Map the full architecture. Identify systemic issues, hidden dependencies, and design tensions. Surface what the code does vs what it should do.",
    shallow: "Focused investigation. Identify the specific issue and its immediate context.",
  },
  conversation: {
    focus: "Discussion. Think with the developer, not at them.",
    deep: "Engage deeply with the question. Surface assumptions, explore alternatives, provide reasoned opinions.",
    shallow: "Brief, direct response.",
  },
  "quick-answer": {
    focus: "Fast, direct answer. No preamble, no caveats unless critical.",
    deep: "Fast, direct answer. No preamble, no caveats unless critical.",
    shallow: "Fast, direct answer. No preamble, no caveats unless critical.",
  },
};

const VERIFICATION_DIRECTIVES = {
  none: "",
  diff: "After changes: review the diff to confirm correctness before declaring done.",
  test: "After changes: run tests. If no tests exist for the changed code, write them. Do not declare done without green tests.",
};

function _buildDirective(intent, taskType, complexity, reasoning, verification) {
  const parts = [];
  const MODE_LABELS = { plan: "PLANNING", explain: "DISCUSSION", analyze: "ANALYSIS", other: "EXECUTION", execute: "EXECUTION" };
  const modeLabel = MODE_LABELS[intent] || "EXECUTION";
  parts.push(`${modeLabel} mode.`);

  const task = TASK_DIRECTIVES[taskType] || TASK_DIRECTIVES["implement"];
  parts.push(task.focus);

  const depth = reasoning || (complexity === "high" ? "deep" : "shallow");
  parts.push(task[depth] || task.deep);

  if (complexity === "high") {
    parts.push("This is a complex task. Take your time, plan carefully, and verify each step.");
  }

  const isStructural = taskType === "refactor" || taskType === "architect";
  if (isStructural || taskType === "implement") {
    if (isStructural) {
      parts.push(
        "PREFLIGHT (required before structural changes):\n" +
        "1. Call pane_architecture_brief with the subsystem name — get locked decisions, known gotchas, and scope boundaries.\n" +
        "2. Call pane_codebase_navigator with the target — understand what will break if this changes."
      );
    } else {
      parts.push(
        "GUIDANCE TOOLS AVAILABLE:\n" +
        "- pane_ui_constraints: get hard design rules before writing UI. Call before any component work.\n" +
        "- pane_architecture_brief: get locked architectural decisions before structural changes.\n" +
        "- pane_codebase_navigator: map the import graph before modifying shared code."
      );
    }
  }

  if (taskType === "ui" || taskType === "design") {
    parts.push(
      "PREFLIGHT (required before writing any component):\n" +
      "1. Call pane_ui_constraints with the component type — get forbidden patterns, design tokens, and a reference implementation before writing Tailwind classes.\n" +
      "2. Call pane_codebase_navigator with the target component — understand the import graph and blast radius before modifying files."
    );
  }

  const verif = VERIFICATION_DIRECTIVES[verification || "none"];
  if (verif) parts.push(verif);

  return parts.join(" ");
}
