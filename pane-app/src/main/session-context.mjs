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
 * compileContext() → { stable, dynamic, full }
 *   stable  — identity + profile + brief + files (cacheable in Anthropic/DeepSeek)
 *   dynamic — session state + memories + intent (changes every turn)
 *   full    — stable + dynamic (for providers that take a single system string)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { METHOD_ATOMS, RULE_ATOMS, GUIDELINE_ATOMS } from "./system-atoms.mjs";

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
  };
}

export const MODEL_CONTEXT_LIMITS = {
  opus: 200000,
  sonnet: 200000,
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
export function compileContext(projectId, intent = "other", historyLength = 0, backend = "gemini-cli") {
  const stableParts  = [];
  const dynamicParts = [];

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

  // Profile atoms: semantically relevant preferences, anti-patterns, and guidelines.
  // Rules are already injected above unconditionally — filter them out so they
  // don't appear twice. System atoms (method/rule/guideline) are already in
  // coreInstructions — filter those too.
  //
  // When the brain has run a contextual search, brainCtx.atoms contains the
  // unified atom pool already scored by cosine × FACET_WEIGHTS × priority +
  // hint boost. We use that directly. Falls back to legacy profileAtoms.
  const profileAtoms = (brainCtx.atoms || brainCtx.profileAtoms || [])
    .filter(a => a.entityType !== "system_atom" && a.facet !== "rule");

  if (profileAtoms.length > 0) {
    stableParts.push("Relevant preferences:");
    for (const atom of profileAtoms.slice(0, 8)) stableParts.push(`- ${atom.content}`);
    stableParts.push("");
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
      if (brief.length > 2500) {
        const truncated = brief.slice(0, 2500);
        const lastSection = truncated.lastIndexOf("\n###");
        brief = lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
      }
    } catch {}
  }

  if (brief) {
    stableParts.push(brief);
    stableParts.push("");
  }

  // ── Codebase map: every indexed file with a one-line description ──────────
  // This is the model's primary navigation tool. It sees the ENTIRE project
  // structure, not a 5-file sample. ~2-4k tokens for a 100-file project.
  // Lives in stable → cached across turns (files don't change that fast).
  const codebaseMap = (brainCtx.codebaseMap || []);
  if (codebaseMap.length > 0) {
    stableParts.push("## Codebase map");
    stableParts.push("Every file in this project and what it does. Use this to navigate — do not grep for files.");
    stableParts.push("");
    for (const f of codebaseMap) {
      stableParts.push(`${f.path} — ${f.desc}`);
    }
    stableParts.push("");
  }

  // Relevant files from brain index — the top semantic matches for THIS query.
  // These are the files most likely to need changes. Approach order is heuristic:
  // config/types → core logic → API/handlers → hooks/stores → UI → tests
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

    stableParts.push("Suggested approach order for this task:");
    ordered.forEach((f, i) => {
      stableParts.push(`${i + 1}. ${f.path} — ${f.description}`);
    });
    stableParts.push("");
  } else if (relevantFiles.length > 0) {
    stableParts.push("Files most likely to need changes:");
    for (const f of relevantFiles) stableParts.push(`- ${f.path} — ${f.description}`);
    stableParts.push("");
  }

  // Layer 3: Project DNA — accumulated decisions, patterns, lessons synthesized into a narrative.
  // Compact (<400 tokens). Changes rarely (only when new decisions/lessons reach confidence threshold).
  // Lives in stable → safe for Anthropic prompt caching. Does NOT change per-query.
  const synthesis = brainCtx.synthesis || "";
  if (synthesis) {
    stableParts.push("## Project DNA");
    stableParts.push(synthesis);
    stableParts.push("");
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

  if (state.activeTask) {
    dynamicParts.push(`Current objective: ${state.activeTask.description}`);
    if (state.activeTask.goal) dynamicParts.push(`Goal: ${state.activeTask.goal}`);
    dynamicParts.push("");
  }

  if (state.todos?.length > 0) {
    dynamicParts.push("Task list:");
    for (const t of state.todos) {
      const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[→]" : "[ ]";
      dynamicParts.push(`${mark} ${t.content}`);
    }
    dynamicParts.push("");
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

  if (state.recentActions.length > 0) {
    const actions = state.recentActions.slice(0, 5);
    dynamicParts.push("What has been done:");
    for (const a of actions) dynamicParts.push(`- [${a.type}] ${a.content}`);
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

  // Mind entries: active thoughts from the user's Mind
  const mindEntries = (brainCtx.mindEntries || []);
  if (mindEntries.length > 0) {
    dynamicParts.push("Active thoughts from Mind (user-authored, treat as high-priority context):");
    for (const m of mindEntries) dynamicParts.push(`- ${m.content}`);
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

  // Behavioral fence — scope enforcement, fires whenever there's an active task or working set
  if (state.activeTask || state.workingSet.length > 0) {
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

  const stable  = stableParts.filter(Boolean).join("\n");
  const dynamic = dynamicParts.filter(Boolean).join("\n");
  const full = [stable, dynamic].filter(Boolean).join("\n") || coreInstructions;

  return {
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
  if (backend === "gemini-cli") {
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
