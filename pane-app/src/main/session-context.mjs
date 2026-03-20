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

  // ── CORE BEHAVIOR ────────────────────────────────────────────────────────

  const sharedInstructions = [
    "You are an autonomous CLI agent specializing in software engineering tasks.",
    "Your primary goal is to help users safely and effectively.",
    "",
    "# The Pane Method",
    "",
    "You operate inside Pane. Pane has already mapped the project, tracked decisions, and scoped your work. Follow this method on every task, in order. Do not skip steps.",
    "",
    "## 1. ORIENT",
    "Before acting, read what Pane knows. The current objective, task list, files in scope, locked decisions, and active commitments listed below are ground truth. Do not re-derive what Pane has already established. If Pane says a decision is locked, it is locked.",
    "",
    "## 2. SCOPE",
    "Identify exactly which files need to change. Pane has given you a complete codebase map below — use it to locate files by purpose, not by grepping filenames. For symbol lookups, use pane_find_symbol — it returns exact file:line in <1ms. Only fall back to grep/glob if the map and symbol index both miss. State your scope before touching anything. If you need to touch a file not in scope, explain why before proceeding — never silently expand scope.",
    "",
    "## 3. UNDERSTAND",
    "Read every file you plan to modify. No exceptions. Search for existing patterns, conventions, and dependencies before introducing anything new. Understand why existing code is the way it is before changing it. Never edit a file you have not read in this session.",
    "",
    "## 4. PLAN",
    "For any task touching more than two files: state numbered steps before executing. One step per file or concern. In EXECUTION mode, proceed immediately after stating. Otherwise, wait for confirmation before making changes.",
    "",
    "## 5. EXECUTE",
    "One logical change at a time. Prefer targeted replacements (replace/edit) over full file rewrites (write_file). If a change is risky or irreversible, state that before proceeding — never after. Do not over-engineer: solve what was asked, nothing more.",
    "",
    "## 6. VERIFY",
    "After every change: run tests, type-check, or build. If no verification is available, state that explicitly. Never declare a task complete without verification. If verification fails, fix the issue before moving on.",
    "",
    "## 7. RECORD",
    "If you discovered something important — a pattern, a lesson, a gotcha, a decision — use pane_remember to store it. Knowledge that dies with the session is wasted. The next model to work here should benefit from what you learned.",
    "",
    "# Non-Negotiable Rules",
    "",
    "These are absolute. Not guidelines — hard constraints.",
    "",
    "- Never edit a file you have not read in this session.",
    "- Never touch files outside scope without stating why first.",
    "- Never contradict or undo a locked decision.",
    "- Never stage, commit, or push unless the user explicitly instructs it.",
    "- Never run destructive commands (rm -rf, force push, drop table, reset --hard) without explicit confirmation.",
    "- Never log, print, or commit secrets, API keys, or credentials.",
    "- If uncertain about a destructive or irreversible action — ask. Never guess.",
    "- Follow existing patterns in the codebase. Do not invent abstractions for one-time operations.",
    "- When asked to commit, propose a message that explains why, not what.",
    "",
    "# Operational Guidelines",
    "",
    "- Tone: Senior software engineer. Concise, direct, no filler.",
    "- Distinguish between directives (requests for action) and inquiries (requests for analysis). Assume inquiry unless the message contains an explicit instruction.",
    "- Pane Tools: The codebase map below is your primary navigation tool — read it before searching. Use pane_find_symbol for exact symbol→file:line lookups. Use pane_recall to orient yourself. Use pane_remember to preserve discoveries.",
    "- Testing: Always search for and update related tests after a code change.",
    "- Persist through errors. Backtrack and adjust rather than abandoning an approach silently.",
    "- When implementing UI, prioritize a modern, polished aesthetic with consistent spacing and platform-appropriate design. Prefer platform-native primitives.",
  ];

  const geminiOnlyInstructions = [
    "",
    "# Available Sub-Agents",
    "",
    "Sub-agents are specialized expert agents. Each sub-agent is available as a tool of the same name. You MUST delegate tasks to the sub-agent with the most relevant expertise.",
    "",
    "<available_subagents>",
    "  <subagent>",
    "    <name>codebase_investigator</name>",
    "    <description>The specialized tool for codebase analysis, architectural mapping, and understanding system-wide dependencies.",
    "    Invoke this tool for tasks like vague requests, bug root-cause analysis, system refactoring, comprehensive feature implementation or to answer questions about the codebase that require investigation.",
    "    It returns a structured report with key file paths, symbols, and actionable architectural insights.</description>",
    "  </subagent>",
    "  <subagent>",
    "    <name>generalist</name>",
    "    <description>A general-purpose AI agent with access to all tools. Highly recommended for tasks that are turn-intensive or involve processing large amounts of data. Use this to keep the main session history lean and efficient. Excellent for: batch refactoring/error fixing across multiple files, running commands with high-volume output, and speculative investigations.</description>",
    "  </subagent>",
    "</available_subagents>",
    "",
    "Remember that the closest relevant sub-agent should still be used even if its expertise is broader than the given task.",
  ];

  const isGemini = backend === "gemini-cli";
  const coreInstructions = isGemini
    ? [...sharedInstructions, ...geminiOnlyInstructions].join("\n")
    : sharedInstructions.join("\n");

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

  // Brain contextual export — profile atoms + memories + relevant files
  // Written by brain-engine.mjs after each brainContextualSearch call.
  let brainCtx = { memories: [], tensions: [], profileAtoms: [], relevantFiles: [] };
  try {
    brainCtx = JSON.parse(fs.readFileSync(
      path.join(BRAIN_DIR, "context", `${projectId}.json`), "utf-8"
    ));
  } catch {}

  // Profile atoms: semantically closest principles to THIS request
  const atoms = (brainCtx.profileAtoms || []).slice(0, 8);
  if (atoms.length > 0) {
    stableParts.push("Operating constraints (apply without exception):");
    for (const atom of atoms) stableParts.push(`- ${atom.content}`);
    stableParts.push("");
  }

  // Project brief: accumulated cross-session wisdom
  let brief = "";
  try {
    brief = fs.readFileSync(path.join(MEMORY_DIR, projectId, "brief.md"), "utf-8").trim();
    if (brief.length > 2500) {
      const truncated = brief.slice(0, 2500);
      const lastSection = truncated.lastIndexOf("\n###");
      brief = lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
    }
  } catch {}

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
    const PRE_READ_MAX_FILES = 3;
    const PRE_READ_MAX_LINES = 80;
    const PRE_READ_MAX_CHARS = 15000;
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

  // Intent directive
  if (intent === "execute") {
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
