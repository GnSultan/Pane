/**
 * Pane Session Context — the shared table every LLM eats from.
 *
 * Instead of handing off conversation history between providers, Pane owns
 * the context. LLMs are stateless workers. Each one receives a compiled
 * snapshot of what's happening right now. When you switch from DeepSeek Reasoner
 * to DeepSeek Chat (V3), Chat doesn't need to be briefed — the state is already there.
 *
 * State lives at: ~/.pane/session/{projectId}/state.json
 * Context exports from brain live at: ~/.pane/brain/context/{projectId}.json
 *
 * compileContext() → { frozen, session, turn, stable, dynamic, full }
 *
 * Three-tier context model for provider-agnostic caching:
 *
 *   frozen  — identity, rules, guide, brief, purpose, DNA, global memory.
 *             Set once per session, never changes between turns.
 *             MUST come first in the prompt to enable prefix caching on all providers.
 *             Anthropic: explicit cache_control breakpoint.
 *             DeepSeek/Kimi/Qwen: automatic prefix caching (prefix must be stable).
 *             Gemini: cachedContents API candidate.
 *
 *   session — relevant files, approach order.
 *             Changes when files or task scope change, NOT every turn.
 *             Second in prompt — extends the cacheable prefix when unchanged.
 *             Codebase map is on-demand via pane_get_project_map (~2-4k tokens saved).
 *
 *   turn    — git status, todos, working set, pre-reads, recent actions, memories,
 *             symbols, intent directive, escalation, handoff, pins, fence.
 *             Changes every turn — never cached, always charged full price.
 *
 * Backward compat: stable = frozen + session, dynamic = turn, full = all three.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BASE_CONFIDENCE, getEffectiveConfidence } from "./extraction-tuning.mjs";
import { getActiveJournal, applyMergeDelta } from "./session-journal.mjs";
import { getIdentity } from "./identity.mjs";
import { lookupModelContext } from "./model-registry.mjs";

const PANE_DIR    = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");
const BRAIN_DIR   = path.join(PANE_DIR, "brain");
const MEMORY_DIR  = path.join(PANE_DIR, "memory");

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    // What the LLM is actively working on right now
    activeTask: null,       // { description: string, goal?: string }

    // Project TODO list
    todos: [],              // { content: string, status: string, activeForm?: string }[]

    // Files currently in play — sorted by touch count (most active first)
    workingSet: [],         // [{ path, purpose?, touches }]

    // Architectural decisions locked in this session
    decisions: [],          // [{ content, timestamp }]

    // Last 8 actions (file edits, commands, errors, fixes)
    recentActions: [],      // [{ type, content, timestamp }]

    // Method compliance notes from post-turn verification
    methodNotes: [],        // [{ type: 'scope_violation'|'no_verification', content, timestamp }]

    // Git context
    gitStatus: null,        // { branch: string, summary: string }

    turnCount: 0,
    lastProvider: null,
    lastIntent: null,
    startedAt: Date.now(),

    // Orchestration phase — tracks where in the pipeline this session is
    phase: "idle",  // "idle" | "discovery" | "planning" | "execution"

    // Active skills — names of skills activated during this session
    activeSkills: [],
  };
}

export const MODEL_CONTEXT_LIMITS = {
  // Claude 4.6 models with 1M context beta
  "claude-opus-4-6": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-haiku-4-5-20251001": 200000,
  opus: 1000000,
  sonnet: 1000000,
  haiku: 200000,
  "gemini-3": 2000000,
  "gemini-2": 1000000,
  "gemini-1.5": 1000000,
  "deepseek-v4-flash": 1000000,
  "deepseek-v4-pro": 1000000,
  "deepseek/deepseek-v4-flash": 1000000,
  "deepseek/deepseek-v4-pro": 1000000,
  qwen3: 262144,
  "moonshot": 128000,
  openrouter: 128000,
  // Specific OpenRouter model context windows
  "anthropic/claude-3.5-sonnet": 200000,
  "qwen/qwen3-coder": 262144,
  "qwen/qwen3-coder:free": 262144,
  // Native StepFun model IDs (direct API, not via OpenRouter)
  "step-3.5-flash": 256000,
  "step-2-mini": 32000,
  // OpenRouter-wrapped StepFun
  "stepfun/step-3.5-flash:free": 128000,
  "meta-llama/llama-3.3-70b-instruct:free": 128000,
  "nousresearch/hermes-3-llama-3.1-405b:free": 128000,
  "arcee-ai/trinity-mini:free": 131072,
  "qwen/qwen3-next-80b-a3b-instruct:free": 262144,
  "openai/gpt-oss-120b:free": 131072,
  "z-ai/glm-4.5-air:free": 131072,
  "xiaomi/mimo-v2-flash": 262144,
  "xiaomi/mimo-v2-pro": 1000000,
  "xiaomi/mimo-v2-omni": 1000000,
  "mimo-v2-flash": 262144,
  "mimo-v2-pro": 1000000,
  "mimo-v2-omni": 1000000,
  "google/gemini-2.0-flash-001": 1000000,
};

/**
 * Get context window limit for a model.
 * Tries exact match first, then partial matches from most to least specific.
 */
export function getContextLimit(model) {
  if (!model) return 200000;

  // 1. Live registry — API-reported context_length from model-manager.
  //    Every model fetched from OpenRouter, DeepSeek, Anthropic, etc.
  //    includes its real context_length. This is the authoritative source.
  const registryLimit = lookupModelContext(model);
  if (registryLimit !== null) return registryLimit;

  const lower = model.toLowerCase();

  // 2. Static map — known model aliases. Fallback for models not yet
  //    in the registry (cold start race, local-only models).
  if (MODEL_CONTEXT_LIMITS[lower]) {
    return MODEL_CONTEXT_LIMITS[lower];
  }

  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model];
  }

  // 3. Partial matches from most specific to least specific
  const partialMatches = [
    "anthropic/claude-3.5-sonnet",
    "qwen/qwen3-coder",
    "qwen/qwen3-next",
    "arcee-ai/trinity-mini",
    "openai/gpt-oss-120b",
    "z-ai/glm-4.5-air",
    "step-3.5-flash",
    "step-2-mini",
    "stepfun/step-3.5-flash",
    "meta-llama/llama-3.3",
    "nousresearch/hermes-3",
    "xiaomi/mimo-v2",
    "google/gemini-2.0",
    "gemini-3",
    "gemini-1.5",
    "opus",
    "sonnet",
    "haiku",
    "deepseek",
    "qwen3",
    "moonshot",
    "openrouter",
  ];

  for (const pattern of partialMatches) {
    if (lower.includes(pattern)) {
      const result = MODEL_CONTEXT_LIMITS[pattern];
      if (result !== undefined) return result;
    }
  }

  // 4. Provider-level defaults
  if (lower.includes("openrouter")) return MODEL_CONTEXT_LIMITS["openrouter"] ?? 200000;
  if (lower.includes("anthropic")) return MODEL_CONTEXT_LIMITS["sonnet"] ?? 200000;
  if (lower.includes("gemini")) return MODEL_CONTEXT_LIMITS["gemini-1.5"] ?? 200000;
  if (lower.includes("deepseek")) return 1000000;

  return 200000; // Final fallback
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function statePath(projectId) {
  return path.join(SESSION_DIR, projectId, "state.json");
}

/**
 * Read the current session state. When a journal is active for this project,
 * returns the in-memory state (fast, no disk I/O). Otherwise falls back to
 * reading state.json from disk (cold start, between sessions).
 */
export function readState(projectId) {
  const journal = getActiveJournal(projectId);
  if (journal) return journal.getState();

  // Fallback: read from state.json (no active session)
  try {
    return JSON.parse(fs.readFileSync(statePath(projectId), "utf-8"));
  } catch {
    return defaultState();
  }
}

export function writeState(projectId, state) {
  const dir = path.join(SESSION_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(projectId), JSON.stringify(state, null, 2), "utf-8");
}

export function clearState(projectId) {
  writeState(projectId, defaultState());
}

/**
 * Merge a partial update into the current session state. When a journal is
 * active, delegates to the journal (in-memory update + journal delta entry +
 * debounced state.json flush). Otherwise falls back to read-modify-write on
 * state.json directly.
 *
 * All 15+ callers across the codebase continue calling this unchanged.
 */
export function mergeState(projectId, delta) {
  const journal = getActiveJournal(projectId);
  if (journal) return journal.applyDelta(delta);

  // Fallback: read-modify-write state.json (no active session)
  const state = readState(projectId);
  applyMergeDelta(state, delta);
  writeState(projectId, state);
  return state;
}

// ---------------------------------------------------------------------------
// Context Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a full context snapshot from all available sources.
 *
 * Returns:
 *   stable  — rarely changes during a session → safe to cache (Anthropic ephemeral)
 *   dynamic — changes every turn → never cached
 *   full    — stable + dynamic joined (for providers that take a single string)
 *
 * Stable layer: identity, profile atoms, project brief, relevant files
 * Dynamic layer: session state, brain memories, session pins, intent directive
 */

// ---------------------------------------------------------------------------
// ScoredItem helpers — backward-compatible normalisation for handoff items.
// Pre-L3 handoffs store plain strings; L3+ stores { text, confidence, source }.
// All consumers go through normalizeHandoffItem() to handle both shapes.
// ---------------------------------------------------------------------------

/**
 * Normalise a handoff item to { text, confidence, source }.
 * Returns null for invalid/empty items.
 */
function normalizeHandoffItem(item) {
  if (!item) return null;
  if (typeof item === "string") {
    const t = item.trim();
    // Legacy strings get 0.65 — above the 0.60 injection threshold so they're
    // shown, but below 0.80 so they get the "(uncertain)" label. This ensures
    // handoffs written before Layer 3 aren't silently dropped on first upgrade.
    return t ? { text: t, confidence: 0.65, source: "legacy" } : null;
  }
  if (typeof item === "object" && item.text) {
    return {
      text:       String(item.text).trim(),
      confidence: typeof item.confidence === "number" ? item.confidence : 0.65,
      source:     typeof item.source     === "string"  ? item.source     : "legacy",
    };
  }
  return null;
}

export function compileContext(projectId, intent = "other", historyLength = 0) {
  const frozenParts  = [];   // Tier 1: never changes within session — cacheable prefix
  const sessionParts = [];   // Tier 2: changes when files/scope change — extends cache when stable
  const turnParts    = [];   // Tier 3: changes every turn — never cached

  // Backward compat aliases — existing code pushes to stableParts/dynamicParts.
  // After the refactor, frozen+session = stable, turn = dynamic.
  const stableParts  = frozenParts;
  const dynamicParts = turnParts;

  // ── LOCAL INTELLIGENCE CONTEXT SHAPE ─────────────────────────────────────
  // Read early — drives core instruction selection, atom weighting, brief
  // inclusion, file depth, and directive building below.
  let contextShape = null;
  try {
    contextShape = JSON.parse(fs.readFileSync(
      path.join(BRAIN_DIR, "context", `${projectId}-shape.json`), "utf-8"
    ));
  } catch {}

  // ── CORE BEHAVIOR ────────────────────────────────────────────────────────
  //
  // Behavioral guidance is provided by the "Working in Pane" section below,
  // plus identity, profile rules, and project brief.
  // On continuation turns, remind the model it has full context.

  // ── PANE OPERATING PRINCIPLES ───────────────────────────────────────────
  // Compressed from the former ~1,276-token Pane Intelligence Guide.
  // Tool-specific behavioral guidance now lives in tool descriptions
  // (http-backend.mjs / pane-mcp-server.mjs) where it has maximum impact.
  stableParts.push(
    "## Working in Pane",
    "",
    "Pane provides project context (about, brief, identity) at start. Relevant memories from past sessions are automatically surfaced before you start working — you don't need to search for them first. All other project state — file structure, working set, git status, session state — is on-demand via tools. Retrieve only what you need for the task at hand.",
    "",
    "Closed loop: persist discoveries as you go. pane_remember for root causes, patterns, and decisions. pane_update_memory when you discover something that refines or corrects a prior memory — rewrite it instead of adding a duplicate. pane_delete_memory when a memory is obsolete or wrong. pane_set_rule when the user states a preference. pane_set_about when you understand the project's purpose. A session that discovers but doesn't record forces re-discovery. A session that records but never corrects forces confusion.",
    "",
  );

  // ── Identity: condensed behavioral fingerprint ──────────────────────────
  // Compiled from identity.json, philosophy.md, and rules.md via identity.mjs.
  // Written as "you are" not "don't do" — identity internalizes better.
  const identity = getIdentity();
  if (identity) {
    stableParts.push("Developer Identity:");
    stableParts.push(identity);
    stableParts.push("");
  }

  // ── Project About: what this project is (purpose + identity) ───────────────
  // Single per-project file combining purpose and identity.
  // Stored at ~/.pane/memory/{projectId}/about.md.
  // Captured once through exploration, refined over time.
  //
  // If present → stable layer, always injected. Gives every suggestion
  // criteria to reason against.
  //
  // If absent and early conversation → exploration directive.
  // Model asks questions, calls pane_set_about when it has enough.
  //
  // Skip for mind: threads — those are thought journals, not code projects.
  if (!projectId.startsWith("mind:")) {
    let projectAbout = "";
    try {
      projectAbout = fs.readFileSync(path.join(MEMORY_DIR, projectId, "about.md"), "utf-8").trim();
    } catch {}

    if (projectAbout) {
      stableParts.push("## About");
      stableParts.push(projectAbout);
      stableParts.push("Treat this as active criteria, not background. When suggesting approaches or evaluating trade-offs, reason against this purpose — name tensions when something conflicts, and use it as a tie-breaker when alternatives are close. If a request would move the project away from this purpose, say so.");
      stableParts.push("");
    } else if (historyLength < 4) {
      dynamicParts.push([
        "This project has no recorded context yet. Before answering, understand what it is trying to be.",
        "",
        "Ask one question at a time — start with: what is this project, and what problem does it solve? Follow the thread naturally: who is it for, where is it headed, what it deliberately isn't. Three solid answers is enough.",
        "",
        "Once you have a clear picture, call pane_set_about with a concise synthesis (2-4 sentences), then answer the original message with that context.",
        "",
        "If the first message is urgent (crash, broken build, critical bug), answer it first — explore purpose on the next turn.",
      ].join("\n"));
      dynamicParts.push("");
    } else {
      dynamicParts.push("Note: This project has no recorded context yet. If a natural opening arises, ask about the project's goals and call pane_set_about to record them.");
      dynamicParts.push("");
    }
  }

  // Codebase map and relevant files are now retrieved via pane_get_project_map.
  // This saves ~2-4k tokens from the session tier and makes the system prompt
  // nearly static — improving cache hit rates dramatically.

  // ── DYNAMIC ───────────────────────────────────────────────────────────────

  // Session state: what Pane knows is happening right now
  const state = readState(projectId);

  // ── Task state: retired after 8 hours, never pre-loaded ────────────────
  // Stale objectives from previous sessions were the root cause of the
  // "continue picks up wrong task" bug. Now:
  //   1. Objectives older than 8 hours are retired (cleared from state)
  //   2. Task state is NEVER injected into the system prompt
  //   3. The model can call pane_get_session_state to retrieve it on demand
  // This ensures the model focuses on what the USER just asked, not on
  // stale session state that Pane guessed might be relevant.
  const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 8 hours
  const nowMs = Date.now();

  // Retire stale objectives — clear them from state entirely
  if (state.activeTask?.timestamp && (nowMs - state.activeTask.timestamp) > STALE_THRESHOLD_MS) {
    state.activeTask = null;
    mergeState(projectId, { activeTask: null });
  }
  if (state.todos?.length > 0) {
    const freshTodos = state.todos.filter(t => {
      if (t.status === "completed") return false; // always drop completed
      if (t.timestamp && (nowMs - t.timestamp) > STALE_THRESHOLD_MS) return false; // stale
      return true;
    });
    if (freshTodos.length !== state.todos.length) {
      state.todos = freshTodos;
      mergeState(projectId, { todos: freshTodos });
    }
  }
  // Retire stale decisions (older than 8h) — they're still in memory via pane_recall
  if (state.decisions?.length > 0) {
    const freshDecisions = state.decisions.filter(d =>
      !d.timestamp || (nowMs - d.timestamp) <= STALE_THRESHOLD_MS
    );
    if (freshDecisions.length !== state.decisions.length) {
      state.decisions = freshDecisions;
      mergeState(projectId, { decisions: freshDecisions });
    }
  }

  // Task state is no longer injected into the system prompt.
  // The model retrieves it via pane_get_session_state when needed.

  // On-demand context hint — tells the model how to get project context
  dynamicParts.push("Project context is on-demand. Use these tools to get what you need:");
  dynamicParts.push("- pane_get_session_state → current todos, decisions, recent actions, working set");
  dynamicParts.push("- pane_get_recent_changes → git status, diff, recent commits");
  dynamicParts.push("- pane_get_project_map → codebase file structure");
  dynamicParts.push("- pane_recall(query) → search project memory for relevant context");
  dynamicParts.push("- pane_get_handoff → previous session summary (on cold start)");
  dynamicParts.push("- pane_read_journal → session history and progress snapshots");
  dynamicParts.push("Do NOT pre-emptively call all of these. Only retrieve context you actually need for the task at hand.");
  dynamicParts.push("");

  // ── All project state is now on-demand via tools ──────────────────────
  // Git status, working set, pre-reads, decisions, recent actions, memories,
  // symbols, and principles are retrieved by the model when needed:
  //   pane_get_session_state  → todos, decisions, recent actions, working set
  //   pane_get_recent_changes → git status, diff, recent commits
  //   pane_get_project_map    → codebase file structure
  //   pane_recall(query)      → memories, principles, prior work
  //   pane_read_journal       → session history and progress
  //   pane_get_handoff        → previous session summary
  //
  // This eliminates ~1500-3000 tokens per turn from the system prompt and
  // ensures the model only loads context relevant to its actual task.

  // ── Escalation behavior contract (heuristic router stages 2-4) ─────────
  // When the heuristic router detected consecutive failures and escalated,
  // inject mandatory behavior changes into the dynamic context so the model
  // follows the escalation protocol regardless of backend.
  if (contextShape?.escalationStage >= 2) {
    const stage = contextShape.escalationStage;
    dynamicParts.push("⚠ ESCALATION ACTIVE — mandatory behavioral contract:");
    dynamicParts.push("");

    if (stage >= 2) {
      dynamicParts.push("STAGE 2 — EXPLORE FIRST:");
      dynamicParts.push("- You MUST read relevant files BEFORE implementing anything.");
      dynamicParts.push("- Find patterns in the codebase that inform your approach.");
      dynamicParts.push("- State what you found and what you'll do differently.");
      dynamicParts.push("- Previous approach failed — do not retry the same strategy.");
      dynamicParts.push("");
    }

    if (stage >= 3) {
      dynamicParts.push("STAGE 3 — WEB SEARCH + EXPLORE:");
      dynamicParts.push("- Search the web for docs, error messages, and similar issues.");
      dynamicParts.push("- State what you found from the web search.");
      dynamicParts.push("- THEN explore the codebase with fresh eyes.");
      dynamicParts.push("- Only implement after both web and codebase research.");
      dynamicParts.push("");
    }

    if (stage >= 4) {
      dynamicParts.push("STAGE 4 — FULL RESET:");
      dynamicParts.push("- Abandon ALL assumptions from previous attempts.");
      dynamicParts.push("- Read every relevant file as if you've never seen this codebase.");
      dynamicParts.push("- Search the web for documentation and known issues.");
      dynamicParts.push("- Decompose the problem into sub-problems.");
      dynamicParts.push("- Solve only the failing sub-problem, verify, then integrate.");
      dynamicParts.push("");
    }

    if (contextShape?.preActions?.length > 0) {
      dynamicParts.push("Pre-actions you must complete before implementing:");
      for (const action of contextShape.preActions) {
        if (action.type === "explore_codebase") {
          dynamicParts.push(`- Explore codebase for: "${action.query}"${action.deep ? " (deep — read ALL relevant files)" : ""}`);
        } else if (action.type === "web_search") {
          dynamicParts.push(`- Web search for: ${(action.queries || []).join(", ")}`);
        } else if (action.type === "clean_slate") {
          dynamicParts.push("- Start with zero assumptions from previous context");
        }
      }
      dynamicParts.push("");
    }
  }

  // Mind entries, session pins, handoff, and session orientation are all
  // now tool-retrieved via pane_get_session_state and pane_recall.
  // No longer injected into the system prompt.

  // Intent directive — shaped by local intelligence when available.
  // The local model's taskType, complexity, reasoning, and verification signals
  // produce a tailored behavioral directive. Falls back to generic mode strings.
  const taskType    = contextShape?.taskType    || null;
  const complexity  = contextShape?.complexity  || null;
  const reasoning   = contextShape?.reasoning   || null;
  const verification = contextShape?.verification || null;

  if (contextShape && taskType) {
    // Model-driven directive: specific to the actual task
    const directive = _buildDirective(intent, taskType, complexity, reasoning, verification);
    dynamicParts.push(directive);
  } else if (intent === "execute") {
    dynamicParts.push("EXECUTION mode. Do what's asked directly and efficiently. Skip planning unless absolutely necessary.");
  } else if (intent === "plan") {
    dynamicParts.push("PLANNING mode. Think deeply, explore architecture space, consider tradeoffs, surface tensions with past decisions. End with a clear recommendation and wait for confirmation before making changes.");
  } else if (intent === "explain") {
    dynamicParts.push("EXPLANATION mode. Clear, detailed, accurate explanations with code examples where appropriate.");
  } else {
    dynamicParts.push("For non-trivial tasks, present a brief plan and end with: \"Ready to proceed — send 'go' to start.\" Wait for confirmation before making changes. For simple tasks, just do them.");
  }

  // Behavioral fence removed — it referenced activeTask and workingSet
  // which are now tool-retrieved. The model's scope is defined by the
  // user's message, not by pre-loaded constraints.

  // Method compliance notes — corrections from Pane's post-turn verification
  if (state.methodNotes?.length > 0) {
    dynamicParts.push("⚠ Pane detected method violations on the previous turn. Correct these now:");
    for (const note of state.methodNotes) {
      dynamicParts.push(`- ${note.content}`);
    }
    dynamicParts.push("");
  }

  // ── Assemble tiers ──────────────────────────────────────────────────────
  const frozen  = frozenParts.filter(Boolean).join("\n");
  const session = sessionParts.filter(Boolean).join("\n");
  const turn    = turnParts.filter(Boolean).join("\n");

  // Backward compat: stable = frozen + session, dynamic = turn
  const stable  = [frozen, session].filter(Boolean).join("\n");
  const dynamic = turn;
  const full    = [frozen, session, turn].filter(Boolean).join("\n") || coreInstructions;

  return {
    // New tiered API — used by cache-aware backends
    frozen,    // Tier 1: never changes within session (cacheable prefix)
    session,   // Tier 2: changes when files/scope change (extends cache when stable)
    turn,      // Tier 3: changes every turn (never cached)
    // Backward compat — used by existing callers
    stable,
    dynamic,
    full,
  };
}


// ---------------------------------------------------------------------------
// Directive builder — translates local intelligence signals into a behavioral
// instruction for the cloud model. The goal: the model knows what kind of task
// it's doing, how deeply to reason, and how to verify — before reading the
// user's message.
// ---------------------------------------------------------------------------

const TASK_DIRECTIVES = {
  debug: {
    focus:  "Root-cause analysis. Reproduce → isolate → fix → verify. Follow the data, not assumptions.",
    deep:   "Trace the full execution path. Consider race conditions, state mutation, and edge cases. Check error boundaries and upstream callers.",
    shallow: "Quick fix. Identify the immediate cause, patch it, verify it.",
  },
  implement: {
    focus:  "Build it. Follow existing patterns. Minimal footprint — solve what's asked, nothing more.",
    deep:   "Consider interfaces, error handling, edge cases, and how this interacts with the rest of the system. Plan before writing.",
    shallow: "Straightforward implementation. Write the code, match the style, move on.",
  },
  explain: {
    focus:  "Clear, accurate explanation. Code examples where they help. No hand-waving.",
    deep:   "Walk through the architecture. Explain why, not just what. Surface non-obvious implications and tradeoffs.",
    shallow: "Concise answer. Get to the point fast.",
  },
  architect: {
    focus:  "System design. Consider constraints, tradeoffs, extensibility, and what will break.",
    deep:   "Explore the solution space. Compare approaches. Surface tensions with existing decisions. End with a clear recommendation.",
    shallow: "Quick architectural judgment. State the approach and rationale.",
  },
  refactor: {
    focus:  "Improve structure without changing behavior. Every step must preserve semantics.",
    deep:   "Map all callers and dependencies before moving anything. Run verification after each structural change.",
    shallow: "Simple rename or extract. Make the change, verify it compiles.",
  },
  review: {
    focus:  "Code review. Focus on correctness, edge cases, and maintainability. Skip style nits.",
    deep:   "Check logic flow, error handling, security implications, and performance. Verify test coverage.",
    shallow: "Quick scan for obvious issues.",
  },
  conversation: {
    focus:  "Discussion. Think with the developer, not at them.",
    deep:   "Engage deeply with the question. Surface assumptions, explore alternatives, provide reasoned opinions.",
    shallow: "Brief, direct response.",
  },
  "quick-answer": {
    focus:  "Fast, direct answer. No preamble, no caveats unless critical.",
    deep:   "Fast, direct answer. No preamble, no caveats unless critical.",
    shallow: "Fast, direct answer. No preamble, no caveats unless critical.",
  },
};

const VERIFICATION_DIRECTIVES = {
  none: "",
  diff: "After changes: review the diff to confirm correctness before declaring done.",
  test: "After changes: run tests. If no tests exist for the changed code, write them. Do not declare done without green tests.",
};

// ---------------------------------------------------------------------------
// System prompt builder — retired. All behavioral guidance is now provided by
// the "Working in Pane" section, identity, profile rules, and project brief.
// The continuation instruction is inlined at the call site in compileContext().
// ---------------------------------------------------------------------------

function _buildDirective(intent, taskType, complexity, reasoning, verification) {
  const parts = [];

  // Mode line
  const modeLabel = intent === "plan" ? "PLANNING" : intent === "explain" ? "EXPLANATION" : "EXECUTION";
  parts.push(`${modeLabel} mode.`);

  // Task-specific focus
  const task = TASK_DIRECTIVES[taskType] || TASK_DIRECTIVES["implement"];
  parts.push(task.focus);

  // Reasoning depth
  const depth = reasoning || (complexity === "high" ? "deep" : "shallow");
  parts.push(task[depth] || task.deep);

  // Complexity signal — high complexity gets explicit guardrails
  if (complexity === "high") {
    parts.push("This is a complex task. Take your time, plan carefully, and verify each step.");
  }

  // Verification
  const verif = VERIFICATION_DIRECTIVES[verification || "none"];
  if (verif) parts.push(verif);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Handoff Document — captures session/turn outcome for continuity and model swaps
// ---------------------------------------------------------------------------
//
// The handoff document is the bridge between sessions and model swaps. It captures:
// - What was accomplished (facts extracted from session state.recentActions)
// - Work already completed in previous sessions (completed_from_history)
// - Current objective and progress (for the next model to pick up immediately)
// - Decisions made (immutable once locked)
// - Key findings (discoveries worth remembering)
// - Next steps (what should happen next)
//
// Lives at: ~/.pane/session/{projectId}/handoff.json
//
// Schema:
// {
//   timestamp: number,
//   turn: number,
//   model: string,
//   accomplishment: string[],      // What was accomplished this turn
//   completed_from_history: ScoredItem[],  // NEW: Work already done in previous sessions
//   currentObjective: string,       // What is being worked on
//   progress: string,               // How far along
//   decisionsLocked: string[],      // Immutable decisions from this turn
//   findings: string[],             // Discoveries, patterns, fixes
//   nextSteps: string[],            // What should happen next
//   blockers: string[],             // Unresolved issues
//   workingSet: { path, purpose }[], // Files most likely to need changes
// }


export function generateHandoff(projectId, { writeFile = true } = {}) {
  const state = readState(projectId);
  const handoff = {
    timestamp: Date.now(),
    turn: state.turnCount,
    model: state.lastProvider,
    accomplishment: [],
    completed_from_history: [], // NEW: Work already done in previous sessions
    currentObjective: state.activeTask?.description || "",
    progress: "",
    decisionsLocked: state.decisions.map(d => d.content),
    findings: [],
    nextSteps: [],
    blockers: [],
    workingSet: state.workingSet.slice(0, 5),
  };

  // Extract accomplishment from recent actions — tagged with source + confidence (Layer 3)
  const completedActions = state.recentActions.filter(a =>
    a.type === "file_edit" || a.type === "command" || a.type === "decision"
  );
  if (completedActions.length > 0) {
    handoff.accomplishment = completedActions.slice(0, 3).map(a => ({
      text:       a.content,
      confidence: a.type === "decision" ? BASE_CONFIDENCE.state_decision
                : a.type === "file_edit" ? BASE_CONFIDENCE.state_action
                :                          BASE_CONFIDENCE.state_command,
      source:     a.type === "decision" ? "state_decision"
                : a.type === "file_edit" ? "state_action"
                :                          "state_command",
    }));
  }

  // Extract completed items from previous sessions — tagged as completed_from_history
  // This separates previous session work from current session accomplishments
  const history = readHandoffHistory(projectId);
  if (history?.length > 0) {
    const historyCompleted = [];
    for (const h of history) {
      if (h.completed_from_history?.length) {
        historyCompleted.push(...h.completed_from_history);
      }
    }
    if (historyCompleted.length > 0) {
      handoff.completed_from_history = mergeItemArrays(
        historyCompleted,
        [],
        3 // Max 3 items total from history
      );
    }
  }

  // Progress from active todo
  const activeTodo = (state.todos || []).find(t => t.status === "in_progress");
  if (activeTodo) {
    handoff.progress = `Working on: ${activeTodo.content}`;
  } else {
    const completed = (state.todos || []).filter(t => t.status === "completed").length;
    const total = (state.todos || []).length;
    if (total > 0) {
      handoff.progress = `${completed}/${total} tasks completed`;
    }
  }

  // Next steps from pending todos — tagged as state_todo (Layer 3)
  const pending = (state.todos || []).filter(t => t.status === "pending").slice(0, 2);
  if (pending.length > 0) {
    handoff.nextSteps = pending.map(t => ({
      text:       t.content,
      confidence: BASE_CONFIDENCE.state_todo,
      source:     "state_todo",
    }));
  }

  if (writeFile) {
    writeHandoffWithHistory(projectId, handoff);
  }

  return handoff;
}

/**
 * Write handoff and maintain a rolling history of the last 3 sessions.
 *
 * Writes two files:
 *   handoff.json         — current handoff (for quick reads by compileContext)
 *   handoff-history.json — array of last 3 handoffs (for trajectory display)
 */
export function writeHandoffWithHistory(projectId, handoff) {
  try {
    const projectSessionDir = path.join(SESSION_DIR, projectId);
    fs.mkdirSync(projectSessionDir, { recursive: true });

    // Read existing history
    let history = [];
    try {
      history = JSON.parse(
        fs.readFileSync(path.join(projectSessionDir, "handoff-history.json"), "utf-8")
      );
    } catch {}

    // Prepend new handoff, keep last 3
    history = [handoff, ...history].slice(0, 3);

    // Write both files
    fs.writeFileSync(path.join(projectSessionDir, "handoff.json"), JSON.stringify(handoff, null, 2), "utf-8");
    fs.writeFileSync(path.join(projectSessionDir, "handoff-history.json"), JSON.stringify(history, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[context] Failed to write handoff: ${err.message}`);
  }
}

/**
 * Update the most recent handoff entry in-place (same session, enriched version).
 *
 * Used by the LLM fallback path: the initial handoff is already written via
 * writeHandoffWithHistory(); when the async LLM enrichment completes, we
 * REPLACE history[0] rather than prepending — otherwise the same session
 * would appear twice, ejecting an older legitimate session from the rolling 3.
 *
 * Match criterion: history[0].timestamp within 2 minutes of the new handoff.
 * If no match (edge case — shouldn't happen in normal flow), falls back to
 * a normal prepend so data is never lost.
 */
export function updateLatestHandoff(projectId, handoff) {
  try {
    const projectSessionDir = path.join(SESSION_DIR, projectId);
    fs.mkdirSync(projectSessionDir, { recursive: true });

    let history = [];
    try {
      history = JSON.parse(
        fs.readFileSync(path.join(projectSessionDir, "handoff-history.json"), "utf-8")
      );
    } catch {}

    const TWO_MINUTES = 2 * 60 * 1000;
    if (
      history.length > 0 &&
      Math.abs((history[0].timestamp || 0) - (handoff.timestamp || 0)) < TWO_MINUTES
    ) {
      // Same session — replace in-place, no new entry
      history[0] = handoff;
    } else {
      // Unexpected: different session timestamp, fall back to normal prepend
      history = [handoff, ...history].slice(0, 3);
    }

    fs.writeFileSync(path.join(projectSessionDir, "handoff.json"), JSON.stringify(handoff, null, 2), "utf-8");
    fs.writeFileSync(path.join(projectSessionDir, "handoff-history.json"), JSON.stringify(history, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[context] Failed to update handoff: ${err.message}`);
  }
}

export function readHandoff(projectId) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(SESSION_DIR, projectId, "handoff.json"),
        "utf-8"
      )
    );
  } catch {
    return null;
  }
}

function readHandoffHistory(projectId) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(SESSION_DIR, projectId, "handoff-history.json"),
        "utf-8"
      )
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pattern-based extraction (Layer 2b + 3) — extract structured information
// from model output using per-pattern regex, each with a confidence score.
//
// Each pattern family is split into individual patterns so confidence can be
// assigned per-signal-strength. Stronger markers (✓, ⚠) score higher than
// softer prose markers (coming up:, following steps:).
//
// With Layer 5 active, getEffectiveConfidence() adjusts each score downward
// when a source has been historically over-corrected by subsequent sessions.
// ---------------------------------------------------------------------------

/**
 * Run a single regex against text and collect unique matches as ScoredItems.
 *
 * @param {RegExp} pattern — must have global + multiline flags, one capture group
 * @param {string} text
 * @param {string} source — key into BASE_CONFIDENCE
 * @param {number} baseConf — nominal confidence for this pattern
 * @param {string|null} projectId — if provided, effective confidence is used
 * @param {Set} seen — deduplication set shared across passes for the same field
 * @returns {Array<{text,confidence,source}>}
 */
function runPattern(pattern, text, source, baseConf, projectId, seen) {
  const items = [];
  const conf = projectId ? getEffectiveConfidence(projectId, source) : baseConf;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1]?.trim().slice(0, 100);
    if (!raw) continue;
    const key = raw.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text: raw, confidence: conf, source });
  }
  return items;
}

/**
 * Extract structured items from model output text.
 * Returns ScoredItem arrays — each item has { text, confidence, source }.
 *
 * Includes correction patterns (Layer 5) to capture when the model disagrees
 * with a previously injected handoff claim.
 *
 * @param {string} text — accumulated model output
 * @param {string|null} projectId — when provided, effective confidence is used
 * @returns {{ accomplishments, blockers, nextSteps, discoveries, corrections }}
 */
export function extractFromModelOutput(text, projectId = null) {
  if (!text || typeof text !== "string") return {
    accomplishments: [], blockers: [], nextSteps: [], discoveries: [], corrections: [],
  };

  const BULLET = /(?:^|\n)[-*•]?\s*/;

  // ── Accomplishments ──────────────────────────────────────────────────────
  const accSeen = new Set();
  const accomplishments = [
    // ✓ at line start — strongest possible signal
    ...runPattern(
      new RegExp(`${BULLET.source}✓\\s*([^\\n]+)`, "gim"),
      text, "marker_checkmark", BASE_CONFIDENCE.marker_checkmark, projectId, accSeen,
    ),
    // fixed: / solved: — explicit outcome verb
    ...runPattern(
      new RegExp(`${BULLET.source}(?:fixed:|solved:)\\s*([^\\n]+)`, "gim"),
      text, "marker_outcome", BASE_CONFIDENCE.marker_outcome, projectId, accSeen,
    ),
    // completed: / implemented: — could describe others' work, slightly lower
    ...runPattern(
      new RegExp(`${BULLET.source}(?:completed:|implemented:)\\s*([^\\n]+)`, "gim"),
      text, "marker_completion", BASE_CONFIDENCE.marker_completion, projectId, accSeen,
    ),
  ].slice(0, 5);

  // ── Blockers ─────────────────────────────────────────────────────────────
  const blkSeen = new Set();
  const blockers = [
    // ⚠ at line start — strongest blocker signal
    ...runPattern(
      new RegExp(`${BULLET.source}⚠\\s*([^\\n]+)`, "gim"),
      text, "marker_warning", BASE_CONFIDENCE.marker_warning, projectId, blkSeen,
    ),
    // blocker: / blocked on:
    ...runPattern(
      new RegExp(`${BULLET.source}(?:blocker:|blocked on:)\\s*([^\\n]+)`, "gim"),
      text, "marker_blocker", BASE_CONFIDENCE.marker_blocker, projectId, blkSeen,
    ),
    // failed to:
    ...runPattern(
      new RegExp(`${BULLET.source}failed to:\\s*([^\\n]+)`, "gim"),
      text, "marker_failure", BASE_CONFIDENCE.marker_failure, projectId, blkSeen,
    ),
  ].slice(0, 3);

  // ── Next steps ───────────────────────────────────────────────────────────
  const nxtSeen = new Set();
  const nextSteps = [
    // next: — clearest intent signal
    ...runPattern(
      new RegExp(`${BULLET.source}next:\\s*([^\\n]+)`, "gim"),
      text, "marker_next", BASE_CONFIDENCE.marker_next, projectId, nxtSeen,
    ),
    // → at line start — directional arrow
    ...runPattern(
      new RegExp(`${BULLET.source}→\\s*([^\\n]+)`, "gim"),
      text, "symbol_arrow", BASE_CONFIDENCE.symbol_arrow, projectId, nxtSeen,
    ),
    // will proceed: / coming up: / following steps:
    ...runPattern(
      new RegExp(`${BULLET.source}(?:will proceed:|coming up:|following steps?:)\\s*([^\\n]+)`, "gim"),
      text, "marker_proceed", BASE_CONFIDENCE.marker_proceed, projectId, nxtSeen,
    ),
  ].slice(0, 3);

  // ── Discoveries ──────────────────────────────────────────────────────────
  const dscSeen = new Set();
  const discoveries = [
    // discovered: / realized: — most explicit discovery signal
    ...runPattern(
      new RegExp(`${BULLET.source}(?:discovered:|realized:)\\s*([^\\n]+)`, "gim"),
      text, "marker_discovery", BASE_CONFIDENCE.marker_discovery, projectId, dscSeen,
    ),
    // learned:
    ...runPattern(
      new RegExp(`${BULLET.source}learned:\\s*([^\\n]+)`, "gim"),
      text, "marker_learned", BASE_CONFIDENCE.marker_learned, projectId, dscSeen,
    ),
    // insight:
    ...runPattern(
      new RegExp(`${BULLET.source}insight:\\s*([^\\n]+)`, "gim"),
      text, "marker_insight", BASE_CONFIDENCE.marker_insight, projectId, dscSeen,
    ),
  ].slice(0, 5);

  // ── Corrections (Layer 5) ────────────────────────────────────────────────
  // Capture when the model explicitly disagrees with a previously injected
  // handoff claim. These are fed into recordCorrections() at session end to
  // update per-source accuracy scores — they do NOT go into the handoff itself.
  const corSeen = new Set();
  const corrections = [
    // actually: / correction: — explicit disagreement
    ...runPattern(
      new RegExp(`${BULLET.source}(?:actually:|correction:)\\s*([^\\n]+)`, "gim"),
      text, "correction_explicit", BASE_CONFIDENCE.correction_explicit, projectId, corSeen,
    ),
    // already resolved: / not accurate:
    ...runPattern(
      new RegExp(`${BULLET.source}(?:already resolved:|not accurate:)\\s*([^\\n]+)`, "gim"),
      text, "correction_resolved", BASE_CONFIDENCE.correction_resolved, projectId, corSeen,
    ),
  ].slice(0, 5);

  return { accomplishments, blockers, nextSteps, discoveries, corrections };
}

/**
 * Merge two arrays of handoff items (string | ScoredItem), deduplicating by
 * text, keeping the highest confidence on collision, and sorting by confidence
 * descending before applying the cap.
 */
function mergeItemArrays(existing, incoming, cap) {
  const map = new Map();
  const add = (raw) => {
    const item = normalizeHandoffItem(raw);
    if (!item) return;
    const key = item.text.toLowerCase().slice(0, 60);
    const prev = map.get(key);
    if (!prev || prev.confidence < item.confidence) map.set(key, item);
  };
  for (const item of (existing || [])) add(item);
  for (const item of (incoming || [])) add(item);
  return [...map.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, cap);
}

/**
 * Merge pattern-extracted items into an existing handoff object.
 * Handles both old-format (string[]) and new-format (ScoredItem[]) fields.
 * corrections field is intentionally excluded — it's handled separately by
 * recordCorrections() and must not pollute the handoff's claims.
 */
export function mergeExtractedIntoHandoff(handoff, extracted) {
  if (!handoff || !extracted) return handoff;

  if (extracted.accomplishments?.length > 0) {
    handoff.accomplishment = mergeItemArrays(handoff.accomplishment, extracted.accomplishments, 5);
  }

  if (extracted.blockers?.length > 0) {
    handoff.blockers = mergeItemArrays(handoff.blockers, extracted.blockers, 3);
  }

  if (extracted.nextSteps?.length > 0) {
    handoff.nextSteps = mergeItemArrays(handoff.nextSteps, extracted.nextSteps, 3);
  }

  if (extracted.discoveries?.length > 0) {
    handoff.findings = mergeItemArrays(handoff.findings, extracted.discoveries, 5);
  }

  return handoff;
}
