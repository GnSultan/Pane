/**
 * Pane Session Context — the shared table every LLM eats from.
 *
 * Instead of handing off conversation history between providers, Pane owns
 * the context. LLMs are stateless workers. Each one receives a compiled
 * snapshot of what's happening right now. When you switch from DeepSeek R1
 * to DeepSeek V3, V3 doesn't need to be briefed — the state is already there.
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

    // Files currently in play — sorted by touch count (most active first)
    workingSet: [],         // [{ path, purpose?, touches }]

    // Architectural decisions locked in this session
    decisions: [],          // [{ content, timestamp }]

    // Last 8 actions (file edits, commands, errors, fixes)
    recentActions: [],      // [{ type, content, timestamp }]

    // Git context
    gitStatus: null,        // { branch: string, summary: string }

    turnCount: 0,
    lastProvider: null,
    lastIntent: null,
    startedAt: Date.now(),
  };
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
export function compileContext(projectId, intent = "other", historyLength = 0) {
  const stableParts  = [];
  const dynamicParts = [];

  // ── CORE BEHAVIOR ────────────────────────────────────────────────────────

  const coreInstructions = [
    "You are Gemini CLI, an autonomous CLI agent specializing in software engineering tasks.",
    "Your primary goal is to help users safely and effectively.",
    "",
    "# Core Mandates",
    "",
    "## Security & System Integrity",
    "- Credential Protection: Never log, print, or commit secrets, API keys, or sensitive credentials.",
    "- Source Control: Do not stage or commit changes unless specifically requested by the user.",
    "",
    "## Context Efficiency",
    "- Be strategic in your use of tools to minimize unnecessary context usage.",
    "- Combine turns whenever possible. Prefer targeted, surgical edits (replace) over full file writes (write_file).",
    "- Use grep_search and glob to identify points of interest before reading files.",
    "",
    "## Engineering Standards",
    "- Contextual Precedence: Instructions in project memory (pane_recall) or session state are foundational.",
    "- Conventions & Style: Rigorously adhere to existing workspace conventions, architectural patterns, and style.",
    "- Technical Integrity: You are responsible for the entire lifecycle: implementation, testing, and validation.",
    "- Testing: ALWAYS search for and update related tests after making a code change.",
    "- Expertise & Intent Alignment: Distinguish between Directives (requests for action) and Inquiries (requests for analysis). Assume all requests are Inquiries unless they contain an explicit instruction.",
    "- Proactiveness: Persist through errors. Backtrack and adjust your approach if needed. Validation is not merely running tests; it is the process of ensuring every aspect of your change is correct.",
    "",
    "## Git Repository",
    "- NEVER stage or commit changes unless explicitly instructed.",
    "- When asked to commit, propose a draft commit message focusing on 'why' rather than 'what'.",
    "",
    "## Operational Guidelines",
    "- Tone: Senior software engineer and collaborative peer programmer. Concise and direct.",
    "- Tool Usage: Use run_shell_command for building, testing, and verifying your changes.",
    "- Pane Tools: Use pane_* tools to orient yourself and recall project-specific knowledge.",
    "- Research: Use google_web_search and web_fetch for research and information gathering.",
    "",
    "## Visual & UX Standards",
    "- When implementing UI, prioritize a modern, polished aesthetic with consistent spacing and platform-appropriate design.",
    "- Prefer platform-native primitives and avoid heavy external dependencies unless already established in the project.",
  ].join("\n");

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
  const atoms = brainCtx.profileAtoms || [];
  if (atoms.length > 0) {
    stableParts.push("How they think — relevant to this request:");
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

  // Relevant files from brain index (LLM-described architecture map)
  const relevantFiles = brainCtx.relevantFiles || [];
  if (relevantFiles.length > 0) {
    stableParts.push("Files relevant to this request:");
    for (const f of relevantFiles) stableParts.push(`- ${f.path} — ${f.description}`);
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
    dynamicParts.push(`Active task: ${state.activeTask.description}`);
    if (state.activeTask.goal) dynamicParts.push(`Goal: ${state.activeTask.goal}`);
    dynamicParts.push("");
  }

  if (state.gitStatus) {
    dynamicParts.push(`Git status (branch: ${state.gitStatus.branch}):`);
    dynamicParts.push(state.gitStatus.summary);
    dynamicParts.push("");
  }

  if (state.workingSet.length > 0) {
    dynamicParts.push("Files in play this session:");
    for (const f of state.workingSet.slice(0, 6)) {
      dynamicParts.push(`- ${f.path}${f.purpose ? ` — ${f.purpose}` : ""}`);
    }
    dynamicParts.push("");
  }

  if (state.decisions.length > 0) {
    dynamicParts.push("Decisions locked in this session:");
    for (const d of state.decisions.slice(0, 6)) dynamicParts.push(`- ${d.content}`);
    dynamicParts.push("");
  }

  if (state.recentActions.length > 0) {
    const actions = state.recentActions.slice(0, 5);
    dynamicParts.push("Recent actions:");
    for (const a of actions) dynamicParts.push(`- [${a.type}] ${a.content}`);
    dynamicParts.push("");
  }

  // Brain memories: high-confidence context from the knowledge graph
  const memories = (brainCtx.memories || []).filter(m => (m.confidence || 0) >= 0.75);
  if (memories.length > 0) {
    dynamicParts.push("Relevant context from prior work:");
    for (const mem of memories) dynamicParts.push(`- ${mem.content}`);
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

  // Mid-session reinforcement: restate top pins near the intent directive
  if (historyLength >= 8 && sessionPins.length > 0) {
    const topPins = sessionPins.slice(0, 3).map(p => p.content).join("; ");
    dynamicParts.push(`[Session is ${historyLength} turns deep. Key commitments still active: ${topPins}]`);
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

  const stable  = stableParts.filter(Boolean).join("\n");
  const dynamic = dynamicParts.filter(Boolean).join("\n");

  return {
    stable,
    dynamic,
    full: [stable, dynamic].filter(Boolean).join("\n"),
  };
}
