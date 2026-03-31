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
 *   frozen  — identity, rules, guide, brief, purpose, DNA, profile atoms, global memory.
 *             Set once per session, never changes between turns.
 *             MUST come first in the prompt to enable prefix caching on all providers.
 *             Anthropic: explicit cache_control breakpoint.
 *             DeepSeek/Kimi/Qwen: automatic prefix caching (prefix must be stable).
 *             Gemini: cachedContents API candidate.
 *
 *   session — codebase map, relevant files, approach order.
 *             Changes when files or task scope change, NOT every turn.
 *             Second in prompt — extends the cacheable prefix when unchanged.
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
import { METHOD_ATOMS, RULE_ATOMS, GUIDELINE_ATOMS } from "./system-atoms.mjs";
import { BASE_CONFIDENCE, getEffectiveConfidence } from "./extraction-tuning.mjs";

const PANE_DIR    = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");
const BRAIN_DIR   = path.join(PANE_DIR, "brain");
const MEMORY_DIR  = path.join(PANE_DIR, "memory");
const PROFILE_DIR = path.join(PANE_DIR, "profile");

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
  "deepseek-v3": 128000,
  "deepseek-chat": 128000,
  "deepseek-reasoner": 128000,
  qwen3: 262144,
  "moonshot": 128000,
  openrouter: 128000,
  // Specific OpenRouter model context windows
  "anthropic/claude-3.5-sonnet": 200000,
  "deepseek/deepseek-r1": 128000,
  "deepseek/deepseek-chat": 128000,
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
  "xiaomi/mimo-v2-flash": 128000,
  "google/gemini-2.0-flash-001": 1000000,
};

/**
 * Get context window limit for a model.
 * Tries exact match first, then partial matches from most to least specific.
 */
export function getContextLimit(model) {
  if (!model) return 200000;
  
  const lower = model.toLowerCase();
  
  // First, try exact match for the full model string
  if (MODEL_CONTEXT_LIMITS[lower]) {
    return MODEL_CONTEXT_LIMITS[lower];
  }
  
  // Try exact match with the model as-is (case-sensitive)
  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model];
  }
  
  // Try partial matches from most specific to least specific
  const partialMatches = [
    "anthropic/claude-3.5-sonnet",
    "deepseek/deepseek-r1",
    "deepseek/deepseek-chat",
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
  
  // Fallback: check for provider-level defaults
  if (lower.includes("openrouter")) return MODEL_CONTEXT_LIMITS["openrouter"] ?? 200000;
  if (lower.includes("anthropic")) return MODEL_CONTEXT_LIMITS["sonnet"] ?? 200000; // Default to sonnet
  if (lower.includes("gemini")) return MODEL_CONTEXT_LIMITS["gemini-1.5"] ?? 200000; // Default to 1.5
  if (lower.includes("deepseek")) return MODEL_CONTEXT_LIMITS["deepseek-chat"] ?? 200000;
  
  return 200000; // Final fallback
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function statePath(projectId) {
  return path.join(SESSION_DIR, projectId, "state.json");
}

export function readState(projectId) {
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
 * Merge a partial update into the current session state.
 * Handles deduplication and size caps internally.
 */
export function mergeState(projectId, delta) {
  const state = readState(projectId);

  // Active task: shallow merge
  if (delta.activeTask !== undefined) {
    state.activeTask = delta.activeTask
      ? { ...state.activeTask, ...delta.activeTask }
      : null;
  }

  // Working set: upsert by path, sort by touches, cap at 10
  if (delta.workingSet?.length) {
    for (const file of delta.workingSet) {
      const idx = state.workingSet.findIndex(f => f.path === file.path);
      if (idx >= 0) {
        state.workingSet[idx] = {
          ...state.workingSet[idx],
          ...file,
          touches: (state.workingSet[idx].touches || 0) + 1,
        };
      } else {
        state.workingSet.push({ ...file, touches: 1 });
      }
    }
    state.workingSet.sort((a, b) => (b.touches || 0) - (a.touches || 0));
    state.workingSet = state.workingSet.slice(0, 10);
  }

  // Decisions: prepend new, deduplicate by content prefix, cap at 8
  if (delta.decisions?.length) {
    for (const d of delta.decisions) {
      const key = d.content.slice(0, 60).toLowerCase();
      const dupe = state.decisions.some(x => x.content.slice(0, 60).toLowerCase() === key);
      if (!dupe) state.decisions.unshift({ content: d.content, timestamp: Date.now() });
    }
    state.decisions = state.decisions.slice(0, 8);
  }

  // Recent actions: prepend, cap at 8
  if (delta.recentActions?.length) {
    state.recentActions = [...delta.recentActions, ...state.recentActions].slice(0, 8);
  }

  // Method notes: replace each turn (not cumulative — only latest turn's violations matter)
  if (delta.methodNotes?.length) {
    state.methodNotes = delta.methodNotes;
  } else if (delta.methodNotes !== undefined) {
    state.methodNotes = []; // Explicit clear — model complied this turn
  }

  if (delta.todos)                   state.todos = delta.todos;
  if (delta.turnCount !== undefined) state.turnCount = delta.turnCount;
  if (delta.lastProvider)           state.lastProvider = delta.lastProvider;
  if (delta.lastIntent)             state.lastIntent = delta.lastIntent;
  if (delta.gitStatus !== undefined) state.gitStatus = delta.gitStatus;

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

export function compileContext(projectId, intent = "other", historyLength = 0, backend = "claude-code", sqliteChanges = null) {
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

  // Brain contextual export — read early so unified atoms are available for
  // both system prompt assembly and profile atom injection below.
  let brainCtx = { memories: [], tensions: [], atoms: [], profileAtoms: [], relevantFiles: [] };
  try {
    brainCtx = JSON.parse(fs.readFileSync(
      path.join(BRAIN_DIR, "context", `${projectId}.json`), "utf-8"
    ));
  } catch {}

  // ── CORE BEHAVIOR ────────────────────────────────────────────────────────
  //
  // Dynamic system prompt assembly. When the brain has run a contextual search
  // its unified atom results (system + profile + learned, scored by cosine ×
  // facetWeight × priority) are used directly. Falls back to ALL_SYSTEM_ATOMS
  // when the brain hasn't produced results yet — zero regression.

  const coreInstructions = _buildSystemPromptFromAtoms(
    brainCtx.atoms || null,
    contextShape?.taskType || null,
    contextShape?.complexity || null,
    backend,
  );
  stableParts.unshift(coreInstructions, "");

  // ── PANE OPERATING PRINCIPLES ───────────────────────────────────────────
  // Compressed from the former ~1,276-token Pane Intelligence Guide.
  // Tool-specific behavioral guidance now lives in tool descriptions
  // (http-backend.mjs / pane-mcp-server.mjs) where it has maximum impact.
  stableParts.push(
    "## Working in Pane",
    "",
    "Pane pre-compiles project context before you see the message — purpose, DNA, codebase map, working set contents, memories, symbols, session state. Start from what you already have. Tools extend context, they don't bootstrap it.",
    "",
    "Closed loop: persist discoveries as you go. pane_remember for root causes, patterns, and decisions. pane_set_rule when the user states a preference. pane_set_why when you understand the project's purpose. A session that discovers but doesn't record forces re-discovery.",
    "",
  );

  // Identity
  let identity = null;
  try { identity = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "identity.json"), "utf-8")); } catch {}

  if (identity?.name) {
    const roleStr = identity.role ? `, ${identity.role}` : "";
    stableParts.push(`You are working with ${identity.name}${roleStr}.`);
    if (identity.bio) stableParts.push(identity.bio);
    stableParts.push("");
  }

  // Explicit rules — ALWAYS injected, never filtered by semantic relevance.
  // These are behavioral invariants that apply to every single response.
  let rules = "";
  try { rules = fs.readFileSync(path.join(PROFILE_DIR, "rules.md"), "utf-8").trim(); } catch {}
  if (rules) {
    stableParts.push("Rules (apply to every response, no exceptions):");
    for (const line of rules.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) stableParts.push(`- ${trimmed}`);
    }
    stableParts.push("");
  }

  // ── Profile digest: compiled behavioral fingerprint ─────────────────────
  // Pre-computed from 584 preferences + 311 anti-patterns + rules + philosophy
  // into a dense ~300-token summary. Stored at ~/.pane/profile/digest.txt.
  // Replaces raw profile atom injection (0-8 atoms) with BETTER coverage
  // of the developer's working style in fewer tokens.
  //
  // Falls back to legacy profile atoms if no digest exists.
  let profileDigest = "";
  try {
    profileDigest = fs.readFileSync(path.join(PROFILE_DIR, "digest.txt"), "utf-8").trim();
  } catch {}

  if (profileDigest) {
    stableParts.push("Developer profile:");
    stableParts.push(profileDigest);
    stableParts.push("");
  } else {
    // Fallback: inject raw scored profile atoms (legacy path)
    const profileAtoms = (brainCtx.atoms || brainCtx.profileAtoms || [])
      .filter(a => a.entityType !== "system_atom" && a.facet !== "rule");

    if (profileAtoms.length > 0) {
      stableParts.push("Relevant preferences:");
      for (const atom of profileAtoms.slice(0, 8)) stableParts.push(`- ${atom.content}`);
      stableParts.push("");
    }
  }

  // Project brief: accumulated cross-session wisdom.
  // Local intelligence can suppress the brief on very short, scoped requests
  // (complexity=low) to save context tokens. Medium+ always includes it.
  const shouldIncludeBrief = contextShape?.includeBrief !== false
    || (contextShape?.complexity !== "low");
  let brief = "";
  if (shouldIncludeBrief) {
    try {
      brief = fs.readFileSync(path.join(MEMORY_DIR, projectId, "brief.md"), "utf-8").trim();
      if (brief.length > 4500) {
        const truncated = brief.slice(0, 4500);
        const lastSection = truncated.lastIndexOf("\n###");
        brief = lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
      }
    } catch {}
  }

  if (brief) {
    stableParts.push(brief);
    stableParts.push("");
  }

  // ── Project purpose (the "why") ───────────────────────────────────────────
  // Per-project foundational context: what this project is trying to be, who
  // it serves, what problem it solves. Captured once through exploration and
  // stored at ~/.pane/memory/{projectId}/why.md.
  //
  // If present → stable layer, always injected. Gives every suggestion
  // criteria to reason against.
  //
  // If absent and first turn → exploration directive in dynamic layer.
  // Model asks conversational questions, calls pane_set_why when it has enough,
  // then answers the original message with that context applied.
  //
  // Skip for mind: threads — those are thought journals, not code projects.
  if (!projectId.startsWith("mind:")) {
    let projectWhy = "";
    try {
      projectWhy = fs.readFileSync(path.join(MEMORY_DIR, projectId, "why.md"), "utf-8").trim();
    } catch {}

    if (projectWhy) {
      stableParts.push("## Project Purpose");
      stableParts.push(projectWhy);
      stableParts.push("Treat this as active criteria, not background. When suggesting approaches or evaluating trade-offs, reason against this purpose — name tensions when something conflicts, and use it as a tie-breaker when alternatives are close. If a request would move the project away from this purpose, say so.");
      stableParts.push("");
    } else if (historyLength < 4) {
      // No why yet and conversation is still early — enter exploration mode.
      // This fires on any project without a why.md, not just brand-new ones.
      dynamicParts.push([
        "This project has no recorded purpose. Before answering, understand what it is trying to be.",
        "",
        "Ask one question at a time — start with: what is this project, and what problem does it solve? Follow the thread naturally: who is it for, where is it headed, what it deliberately isn't. Three solid answers is enough.",
        "",
        "Once you have a clear picture, call pane_set_why with a concise synthesis (2-4 sentences), then answer the original message with that context.",
        "",
        "If the first message is urgent (crash, broken build, critical bug), answer it first — explore purpose on the next turn.",
      ].join("\n"));
      dynamicParts.push("");
    } else {
      // Deeper into a conversation with no why — don't interrupt, just remind.
      dynamicParts.push("Note: This project has no recorded purpose yet. If a natural opening arises, ask about the project's goals and call pane_set_why to record them.");
      dynamicParts.push("");
    }
  }

  // ── Project DNA — accumulated decisions, patterns, lessons synthesized into a narrative.
  // Compact (<400 tokens). Changes rarely (only when new decisions/lessons reach confidence threshold).
  // Lives in FROZEN tier — truly stable across turns.
  const synthesis = brainCtx.synthesis || "";
  if (synthesis) {
    frozenParts.push("## Project DNA");
    frozenParts.push(synthesis);
    frozenParts.push("");
  }

  // ── Codebase map: every indexed file with a one-line description ──────────
  // This is the model's primary navigation tool. It sees the ENTIRE project
  // structure, not a 5-file sample. ~2-4k tokens for a 100-file project.
  // Lives in SESSION tier — changes when files are added/removed, not every turn.
  const codebaseMap = (brainCtx.codebaseMap || []);
  if (codebaseMap.length > 0) {
    sessionParts.push("## Codebase map");
    sessionParts.push("Every file in this project and what it does. Use this to navigate — do not grep for files.");
    sessionParts.push("");
    for (const f of codebaseMap) {
      sessionParts.push(`${f.path} — ${f.desc}`);
    }
    sessionParts.push("");
  }

  // Relevant files from brain index — the top semantic matches for THIS query.
  // These are the files most likely to need changes. Approach order is heuristic.
  // Lives in SESSION tier — changes when query/scope change, stable within same task.
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

    sessionParts.push("Suggested approach order for this task:");
    ordered.forEach((f, i) => {
      sessionParts.push(`${i + 1}. ${f.path} — ${f.description}`);
    });
    sessionParts.push("");
  } else if (relevantFiles.length > 0) {
    sessionParts.push("Files most likely to need changes:");
    for (const f of relevantFiles) sessionParts.push(`- ${f.path} — ${f.description}`);
    sessionParts.push("");
  }

  // Global Memory (Gemini CLI parity)
  try {
    const globalMemoryPath = path.join(os.homedir(), ".gemini", "memory.md");
    if (fs.existsSync(globalMemoryPath)) {
      const globalMemory = fs.readFileSync(globalMemoryPath, "utf-8").trim();
      if (globalMemory) {
        stableParts.push("## Global Memory");
        stableParts.push(globalMemory);
        stableParts.push("");
      }
    }
  } catch {}

  // ── DYNAMIC ───────────────────────────────────────────────────────────────

  // System Info
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  dynamicParts.push(`Current Time: ${dateStr}, ${timeStr}`);
  dynamicParts.push(`OS: ${process.platform}`);
  dynamicParts.push(`User: ${os.userInfo().username}`);
  dynamicParts.push("");

  // Session state: what Pane knows is happening right now
  const state = readState(projectId);

  // ── Task state injection: ONLY on first turn ──────────────────────────
  // On turn 0-1: inject activeTask and todos for cross-session continuity.
  // On turn 2+: skip them. The conversation history already contains the
  // plan, the work, and the user's instructions. Injecting stale session
  // state ON TOP of a live conversation creates conflicts — the model sees
  // "Current objective: [old task]" in the system prompt but a completely
  // different task in the conversation, and follows the system prompt.
  // This is the root cause of the "continue picks up wrong task" bug.
  if (historyLength < 2) {
    const activeTodos = (state.todos || []).filter(t => t.status !== "completed");

    if (state.activeTask && activeTodos.length > 0) {
      dynamicParts.push(`Current objective: ${state.activeTask.description}`);
      if (state.activeTask.goal) dynamicParts.push(`Goal: ${state.activeTask.goal}`);
      dynamicParts.push("");
    }

    if (activeTodos.length > 0) {
      dynamicParts.push("Task list:");
      for (const t of activeTodos) {
        const mark = t.status === "in_progress" ? "[→]" : "[ ]";
        dynamicParts.push(`${mark} ${t.content}`);
      }
      dynamicParts.push("");
    }
  }

  if (state.gitStatus) {
    dynamicParts.push(`Git status (branch: ${state.gitStatus.branch}):`);
    dynamicParts.push(state.gitStatus.summary);
    dynamicParts.push("");
  }

  if (state.workingSet.length > 0) {
    dynamicParts.push("Files in scope — do not touch files outside this list unless explicitly asked:");
    for (const f of state.workingSet.slice(0, 6)) {
      dynamicParts.push(`- ${f.path}${f.purpose ? ` — ${f.purpose}` : ""}`);
    }
    dynamicParts.push("");

    // Pre-read: include actual file content for top working set files.
    // The model doesn't need to explore — Pane has already read these.
    // Local intelligence context shaping adjusts depth:
    //   "none" → skip pre-read entirely, "names" → file list only (already done above),
    //   "shallow" → default (3 files, 80 lines), "deep" → 5 files, 120 lines
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
        } catch {
          // File doesn't exist or isn't readable — skip silently
        }
      }

      if (preReadParts.length > 0) {
        dynamicParts.push("Pre-read file contents (Pane has read these — do not re-read unless they have changed since):");
        dynamicParts.push(preReadParts.join("\n\n"));
        dynamicParts.push("");
      }
    }
  }

  if (state.decisions.length > 0) {
    dynamicParts.push("Locked decisions — do not contradict or undo these:");
    for (const d of state.decisions.slice(0, 6)) dynamicParts.push(`- ${d.content}`);
    dynamicParts.push("");
  }

  // Unified "What has been done" — prefers provided SQLite changes for file edits,
  // falls back to state.recentActions for commands/decisions.
  const hasSqliteChanges = Array.isArray(sqliteChanges) && sqliteChanges.length > 0;
  if (hasSqliteChanges || (state.recentActions && state.recentActions.length > 0)) {
    dynamicParts.push("What has been done:");
    
    // 1. Show SQLite changes if provided (file_edit source of truth)
    if (hasSqliteChanges) {
      for (const c of sqliteChanges.slice(0, 10)) {
        const type = (c.old_string || c.oldString) ? "edit" : "write";
        dynamicParts.push(`- [${type}] ${c.file_path || c.file}`);
      }
    }
    
    // 2. Show non-file actions from recentActions (commands, decisions, etc.)
    // Filter out file edits from recentActions if we have SQLite changes to avoid duplication.
    // Also include "Read" / "read_file" if they are in recentActions since they aren't in SQLite.
    const fileTypes = ["file_edit", "write", "edit", "Write", "Edit"];
    const nonFileActions = (state.recentActions || []).filter(a => 
      !hasSqliteChanges || !fileTypes.includes(a.type)
    ).slice(0, 8);
    
    for (const a of nonFileActions) {
      dynamicParts.push(`- [${a.type}] ${a.content}`);
    }
    dynamicParts.push("");
  }

  // Layer 1: Symbol map — resolved from the codebase index against this specific query.
  // Query-dependent → lives in dynamic (not cached). Models stop grepping for these.
  // Extended: up to 15 symbols — query matches + working set exports so the model
  // already knows the key interfaces in scope without searching for them.
  const relevantSymbols = (brainCtx.relevantSymbols || []).slice(0, 15);
  if (relevantSymbols.length > 0) {
    dynamicParts.push("Symbol map (Pane resolved — use directly, do not search for these):");
    for (const s of relevantSymbols) {
      const doc = s.doc ? ` — ${s.doc}` : "";
      dynamicParts.push(`- \`${s.name}\` (${s.kind}) → ${s.file_path || s.file}:${s.line}${doc}`);
    }
    dynamicParts.push("");
  }

  // Brain memories: high-confidence context from the knowledge graph
  const memories = (brainCtx.memories || []).filter(m => (m.confidence || 0) >= 0.75);
  if (memories.length > 0) {
    dynamicParts.push("Relevant context from prior work:");
    for (const mem of memories) dynamicParts.push(`- ${mem.content}`);
    dynamicParts.push("");
  }

  // Extracted principles: standing project standards identified from past exchanges.
  // Separate from general memories — these are active criteria, not historical observations.
  const principles = (brainCtx.principles || []);
  if (principles.length > 0) {
    dynamicParts.push("Active project standards (extracted from how you work on this project — apply when relevant):");
    for (const p of principles) dynamicParts.push(`- ${p.content}`);
    dynamicParts.push("");
  }

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

  // Mind reference: instead of dumping all mind entries into context (costly),
  // provide a count and summary so the model knows to use pane_recall if needed.
  // The orchestrator handles full injection when budget allows; this path is the
  // legacy compileContext() fallback.
  const mindEntries = (brainCtx.mindEntries || []);
  if (mindEntries.length > 0) {
    if (mindEntries.length <= 2) {
      // Few entries — inline them (small cost)
      dynamicParts.push("Active thoughts from Mind (user-authored, treat as high-priority context):");
      for (const m of mindEntries) dynamicParts.push(`- ${m.content}`);
    } else {
      // Many entries — provide reference, let model pull via tool
      const preview = mindEntries.slice(0, 2).map(m => m.content).join("; ");
      dynamicParts.push(`Mind has ${mindEntries.length} active thoughts. Preview: ${preview}`);
      dynamicParts.push("Use pane_recall to access full Mind entries if relevant to this task.");
    }
    dynamicParts.push("");
  }

  // Session pins: live high-confidence commitments
  let sessionPins = [];
  try {
    sessionPins = JSON.parse(fs.readFileSync(
      path.join(MEMORY_DIR, projectId, "session-pins.json"), "utf-8"
    ));
  } catch {}

  if (sessionPins.length > 0) {
    dynamicParts.push("Active commitments:");
    for (const pin of sessionPins.slice(0, 6)) {
      const label = pin.type === "error_fix" ? "Fix" : pin.type === "lesson" ? "Lesson" : "Decision";
      dynamicParts.push(`- [${label}] ${pin.content}`);
    }
    dynamicParts.push("");
  }

  // Previous session handoff — inject at session start only (historyLength < 2).
  // Uses rolling history (last 3 sessions): most recent shown in full, older shown
  // as one-line summaries to give trajectory without bloating context.
  // Stale handoffs (>24h) are dropped — they're noise, not signal.
  //
  // Confidence filtering (Layer 3):
  //   ≥ 0.80 — shown as-is (high confidence)
  //   0.60–0.79 — shown with "(uncertain)" suffix, model should verify first
  //   < 0.60 — omitted (too noisy)
  // Trajectory summaries only include items with confidence ≥ 0.75.
  if (historyLength < 2) {
    const history = readHandoffHistory(projectId) || [];
    if (history.length > 0) {
      const now = Date.now();

      // Most recent — full detail if fresh enough
      const recent = history[0];
      const recentAgeHours = (now - (recent.timestamp || 0)) / (1000 * 60 * 60);

      // Filter items above the injection threshold, label uncertain ones
      const visibleItems = (arr) => (arr || []).reduce((out, raw) => {
        const item = normalizeHandoffItem(raw);
        if (!item || item.confidence < 0.60) return out;
        const label = item.confidence < 0.80 ? ` (uncertain)` : "";
        out.push({ text: item.text, label });
        return out;
      }, []);

      const recentAccomplishments = visibleItems(recent.accomplishment);

      if (recentAgeHours < 24 && recentAccomplishments.length > 0) {
        const ageLabel = recentAgeHours >= 6 ? ` (~${Math.round(recentAgeHours)}h ago)` : "";

        // Show completed work from previous sessions separately
        // This helps the model distinguish between "already done" and "currently working on"
        const recentCompleted = (recent.completed_from_history || []).reduce((out, raw) => {
          const item = normalizeHandoffItem(raw);
          if (!item || item.confidence < 0.60) return out;
          const label = item.confidence < 0.80 ? ` (uncertain)` : "";
          out.push({ text: item.text, label });
          return out;
        }, []);

        if (recentCompleted.length > 0) {
          dynamicParts.push(`Previous session completed${ageLabel} (done — do not repeat):`);
          for (const { text, label } of recentCompleted) dynamicParts.push(`✓ ${text}${label}`);
          dynamicParts.push("");
        }

        // Show outcomes from current session separately from history
        if (recentAccomplishments.length > 0) {
          dynamicParts.push(`Current session outcome${ageLabel} (just completed):`);
          for (const { text, label } of recentAccomplishments) dynamicParts.push(`✓ ${text}${label}`);
        }

        if (recent.currentObjective) dynamicParts.push(`Still working on: ${recent.currentObjective}`);

        const recentBlockers = visibleItems(recent.blockers);
        if (recentBlockers.length > 0) {
          dynamicParts.push("Unresolved blockers:");
          for (const { text, label } of recentBlockers) dynamicParts.push(`⚠ ${text}${label}`);
        }

        const recentNextSteps = visibleItems(recent.nextSteps);
        if (recentNextSteps.length > 0) {
          dynamicParts.push("Suggested next steps:");
          for (const { text, label } of recentNextSteps) dynamicParts.push(`→ ${text}${label}`);
        }

        const recentFindings = visibleItems(recent.findings);
        if (recentFindings.length > 0) {
          dynamicParts.push("Discoveries from last session:");
          for (const { text, label } of recentFindings) dynamicParts.push(`- ${text}${label}`);
        }

        dynamicParts.push("");

        // Older sessions — one-line trajectory summaries, high-confidence only (≥ 0.75)
        for (const older of history.slice(1)) {
          const ageHrs = (now - (older.timestamp || 0)) / (1000 * 60 * 60);
          if (ageHrs >= 24) continue; // drop stale
          if (!older.accomplishment?.length) continue;
          const highItems = (older.accomplishment || [])
            .map(normalizeHandoffItem)
            .filter(item => item && item.confidence >= 0.75)
            .slice(0, 2);
          if (!highItems.length) continue;
          const summary = highItems.map(i => i.text).join(", ");
          dynamicParts.push(`Earlier (~${Math.round(ageHrs)}h ago): ✓ ${summary}`);
        }
        if (history.length > 1) dynamicParts.push("");
      }
    }
  }

  // Session orientation marker — fires from turn 4 onwards so the model always knows where it stands
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
    dynamicParts.push(orientationParts.join(" "));
    dynamicParts.push("");
  }

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

  // Behavioral fence — scope enforcement, ONLY on first turn.
  // On turn 2+, the conversation defines the scope. Injecting a stale
  // "Objective: [old task]" and "In scope: [old files]" mid-conversation
  // constrains the model to the wrong task.
  if (historyLength < 2 && (state.activeTask || state.workingSet.length > 0)) {
    const fence = ["Behavioral constraints:"];

    if (state.activeTask) {
      fence.push(`- Objective: ${state.activeTask.description}`);
    }

    if (state.workingSet.length > 0) {
      const inScope = state.workingSet.slice(0, 6).map(f => f.path).join(", ");
      fence.push(`- In scope: ${inScope}`);
      fence.push(`- Do not touch files outside this scope — if you must, state why before proceeding`);
    }

    if (state.decisions.length > 0) {
      fence.push(`- Locked decisions must not be contradicted or undone`);
    }

    fence.push(`- Every action must trace back to the current objective`);
    fence.push(`- If you find yourself acting outside scope, stop and explain before continuing`);

    dynamicParts.push(fence.join("\n"));
    dynamicParts.push("");
  }

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
    // Backward compat — used by CLI backends and existing callers
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
// System prompt builder — assembles core instructions from the brain's
// unified atom results when available. Falls back to system-atoms.mjs imports
// when the brain hasn't produced results yet (cold start, no embedder).
//
// The brain scores atoms by cosine × FACET_WEIGHTS × priority + hintBoost,
// so the ranking is already task-aware. We just need to assemble them.
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

function _buildSystemPromptFromAtoms(unifiedAtoms, taskType, complexity, backend) {
  const parts = [];

  // Extract system atoms from brain's unified results when available.
  // These are already scored/filtered by the brain for this specific query.
  const systemAtoms = (unifiedAtoms || []).filter(a => a.entityType === "system_atom");

  if (systemAtoms.length > 0) {
    // Brain-powered path: atoms are pre-scored, just assemble by facet
    const methodAtoms = systemAtoms
      .filter(a => a.facet === "method")
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    const ruleAtoms = systemAtoms
      .filter(a => a.facet === "rule")
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const guideAtoms = systemAtoms
      .filter(a => a.facet === "guideline")
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (methodAtoms.length > 0) {
      parts.push(methodAtoms.map(a => a.content).join("\n\n"));
    }

    if (ruleAtoms.length > 0) {
      parts.push("");
      parts.push("Constraints:");
      for (const r of ruleAtoms) parts.push(`- ${r.content}`);
    }

    if (guideAtoms.length > 0) {
      parts.push("");
      for (const g of guideAtoms) parts.push(`- ${g.content}`);
    }
  } else {
    // Fallback: no brain results — inject all system atoms from source of truth.
    // Identical to the old behavior when no local model was available.
    const methodAtoms = [...METHOD_ATOMS].sort((a, b) => a.sortOrder - b.sortOrder);

    if (methodAtoms.length > 0) {
      parts.push(methodAtoms.map(a => a.text).join("\n\n"));
    }

    if (RULE_ATOMS.length > 0) {
      parts.push("");
      parts.push("Constraints:");
      for (const r of RULE_ATOMS) parts.push(`- ${r.text}`);
    }

    if (GUIDELINE_ATOMS.length > 0) {
      parts.push("");
      for (const g of GUIDELINE_ATOMS) parts.push(`- ${g.text}`);
    }
  }

  // Gemini sub-agents
  if (backend === "gemini") {
    parts.push(_GEMINI_SUBAGENTS);
  }

  return parts.join("\n");
}

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

// ---------------------------------------------------------------------------
// Extract completed items from a single handoff object.
// Returns a normalized ScoredItem[] with confidence sources.
// ---------------------------------------------------------------------------
function extractCompletedFromHandoff(handoff) {
  if (!handoff) return [];

  const items = [];
  const seen = new Set();

  // Helper to add an item with optional deduplication
  const addItem = (text, confidence, source) => {
    if (!text || text.trim().length === 0) return;
    const key = text.trim().toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ text, confidence, source });
  };

  // Extract from accomplishment (hard outcomes from this turn)
  if (handoff.accomplishment) {
    for (const item of (handoff.accomplishment || [])) {
      if (typeof item === 'string') {
        addItem(item, BASE_CONFIDENCE.state_accomplishment, 'handoff_accomplishment');
      } else if (item.text) {
        addItem(item.text, item.confidence, item.source || 'handoff_accomplishment');
      }
    }
  }

  // Extract from progress string (when it describes completed work)
  // e.g., "3/5 tasks completed" or "Working on: X" (in_progress is not completed)
  if (handoff.progress && handoff.progress.includes('completed')) {
    // Could extract individual tasks from "3/5 tasks completed" if we had the task list,
    // but for now we just mark the progress milestone
    addItem(`${handoff.progress} (from previous session)`, BASE_CONFIDENCE.state_progress, 'handoff_progress');
  }

  return items.slice(0, 3); // Max 3 completed items from history
}

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
