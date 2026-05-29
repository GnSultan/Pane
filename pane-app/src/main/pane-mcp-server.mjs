// Pane MCP Server — standalone stdio MCP server for Pane IDE.
// Spawned by Claude CLI via --mcp-config, NOT by Electron.
// Reads project state and memory from ~/.pane/ filesystem.
// Convention over coupling: no direct IPC with Pane main process.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execSync } from "node:child_process";
import { findReferences, formatReferencesOutput } from "./find-references.mjs";

import { createRequire } from "node:module";

// better-sqlite3 is a native addon — it may not be resolvable when the MCP
// server runs under a different Node.js binary than the one Pane was built
// with (e.g. the system node used by Gemini CLI). Load it optionally so the
// server can still start and serve all non-DB tools.
let Database = null;
try {
  const _require = createRequire(import.meta.url);
  Database = _require("better-sqlite3");
} catch {
  // DB-dependent tools will return a graceful error; all others work fine.
}

const PANE_DIR = process.env.PANE_DATA_DIR || path.join(os.homedir(), ".pane");
const PROJECT_ID = process.env.PANE_PROJECT_ID || "";
const PROJECT_ROOT = process.env.PANE_PROJECT_ROOT || "";
const DB_PATH = path.join(PANE_DIR, "pane.db");

// Database instance — opened lazily. Returns null if better-sqlite3 is unavailable.
let _db = null;
function getDb() {
  if (!Database) return null;
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
  }
  return _db;
}

// --- JSON-RPC helpers ---

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// --- File helpers ---

async function readJson(filePath) {
  try { return JSON.parse(await fs.promises.readFile(filePath, "utf-8")); }
  catch { return null; }
}

async function writeJson(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readText(filePath) {
  try { return await fs.promises.readFile(filePath, "utf-8"); }
  catch { return null; }
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

// --- Contextual augmentation ---
// When tool output contains stack traces or file:line references, auto-attach
// the referenced code. Eliminates 1-3 Read round-trips per error investigation.

const FILE_LINE_PATTERN = /(?:at\s+(?:\S+\s+\()?)?((?:\/[^\s:()]+|src\/[^\s:()]+|[a-zA-Z][a-zA-Z0-9._/-]+\.[a-z]{1,4})):(\d+)/g;
const MAX_AUGMENT_FILES = 3;
const AUGMENT_CONTEXT_LINES = 10; // lines above and below the referenced line

async function augmentWithReferencedFiles(output, projectRoot) {
  if (!output || output.length < 20) return "";

  // Extract unique file:line references
  const refs = new Map(); // path → Set<lineNumbers>
  let match;
  const regex = new RegExp(FILE_LINE_PATTERN.source, "g");
  while ((match = regex.exec(output)) !== null) {
    const [, filePath, lineStr] = match;
    const line = parseInt(lineStr, 10);
    if (isNaN(line) || line < 1) continue;

    // Skip node_modules and internal Node paths
    if (filePath.includes("node_modules") || filePath.startsWith("node:")) continue;

    // Resolve relative to project root
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(projectRoot, filePath);

    if (!refs.has(resolved)) refs.set(resolved, new Set());
    refs.get(resolved).add(line);
  }

  if (refs.size === 0) return "";

  // Read and attach context for top references (max 3 files)
  const augmented = [];
  let count = 0;
  for (const [resolved, lines] of refs) {
    if (count >= MAX_AUGMENT_FILES) break;
    try {
      const content = await fs.promises.readFile(resolved, "utf-8");
      const allLines = content.split("\n");
      const relativePath = path.relative(projectRoot, resolved);

      // For each referenced line, extract surrounding context
      const snippets = [];
      for (const lineNum of [...lines].sort((a, b) => a - b).slice(0, 3)) {
        const start = Math.max(0, lineNum - 1 - AUGMENT_CONTEXT_LINES);
        const end = Math.min(allLines.length, lineNum + AUGMENT_CONTEXT_LINES);
        const snippet = allLines.slice(start, end)
          .map((l, i) => {
            const num = start + i + 1;
            const marker = num === lineNum ? "→" : " ";
            return `${marker}${String(num).padStart(4)} ${l}`;
          })
          .join("\n");
        snippets.push(snippet);
      }

      augmented.push(`\n--- auto-attached: ${relativePath} (around line${lines.size > 1 ? "s" : ""} ${[...lines].join(", ")}) ---\n${snippets.join("\n...\n")}`);
      count++;
    } catch {
      // File doesn't exist or not readable — skip
    }
  }

  return augmented.length > 0
    ? `\n\n[Pane auto-attached ${augmented.length} referenced file${augmented.length > 1 ? "s" : ""}]${augmented.join("")}`
    : "";
}

// --- Shell execution helpers ---

function getEnvWithPath() {
  const home = os.homedir();
  const nvmVersionsDir = path.join(home, ".nvm", "versions", "node");
  const nvmBins = [];
  try {
    const versions = fs.readdirSync(nvmVersionsDir);
    for (const v of versions) nvmBins.push(path.join(nvmVersionsDir, v, "bin"));
  } catch {}
  const extra = [...nvmBins, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const existing = process.env.PATH || "";
  const combined = [...extra, ...existing.split(":")].filter(Boolean).join(":");
  return { ...process.env, PATH: combined };
}

async function appendTerminalHistory(stateDir, cmd, output) {
  const filePath = path.join(stateDir, "terminal.json");
  let data = null;
  try { data = JSON.parse(await fs.promises.readFile(filePath, "utf-8")); } catch {}
  const commands = Array.isArray(data?.commands) ? data.commands : [];
  commands.push({ cmd, output, timestamp: Date.now(), source: "claude" });
  const trimmed = commands.slice(-20);
  try {
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ commands: trimmed }));
  } catch {}
}

// --- Search helpers ---

function fuzzyScore(query, text) {
  const queryWords = query.split(/\s+/).filter(w => w.length > 2);
  if (queryWords.length === 0) return 0;
  const lower = text.toLowerCase();
  const matches = queryWords.filter(w => lower.includes(w)).length;
  return matches / queryWords.length;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Pre-normalized vectors
}

// Lazy-loaded embedder for semantic search in MCP server (pure WASM, no native deps)
let mcpEmbedder = null;
let mcpEmbedderLoading = false;

async function getMcpEmbedder() {
  if (mcpEmbedder) return mcpEmbedder;
  if (mcpEmbedderLoading) return null;
  mcpEmbedderLoading = true;
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(PANE_DIR, "brain", "models");
    env.backends.onnx.wasm.numThreads = 1;
    mcpEmbedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
    return mcpEmbedder;
  } catch {
    mcpEmbedderLoading = false;
    return null;
  }
}

async function embedText(text) {
  const embedder = await getMcpEmbedder();
  if (!embedder) return null;
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(result.data);
  } catch {
    return null;
  }
}

// Read brain export for a project (written by brain-engine.mjs)
async function readBrainExport(projectId) {
  return readJson(path.join(PANE_DIR, "brain", "exports", `${projectId}.json`));
}

// Semantic search using brain export + optional embedder
async function semanticSearch(query, projectId, limit = 20) {
  const exported = await readBrainExport(projectId);
  if (!exported || exported.length === 0) return null; // Fall back to JSONL search

  const queryEmbedding = await embedText(query);

  const scored = exported.map(node => {
    let score = 0;
    // Semantic score (if we have embeddings)
    if (queryEmbedding && node.embedding) {
      score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
    }
    // Keyword score
    score += 0.4 * fuzzyScore(query.toLowerCase(), (node.content || "").toLowerCase());
    return { ...node, score };
  }).filter(s => s.type !== "mind" && s.score > 0.15).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "pane_project_context",
    description: "Get project name, root path, git branch, and top-level file list. Use when you need the physical layout or git state. For deeper orientation, prefer pane_brief first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_open_files",
    description: "Get the file the user currently has open in Pane's editor, including its full content and recent file history. Call this when the user's message is about 'this file', 'here', or 'what I'm looking at' — it gives you their exact context without asking.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_recent_terminal",
    description: "Get recent terminal commands and their outputs from Pane's terminal. Call this when the user references a command they ran, an error they saw, or 'what I just did'. Combine with pane_open_files to get the full picture of their current work context.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_run_in_terminal",
    description: "Run a shell command and return its output. Use for builds, tests, git operations, installs, or any verification step. Commands run in the project root with the user's full environment (nvm, homebrew, local tools). Prefer this over speculating about whether something works — just run it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)." },
      },
      required: ["command"],
    },
  },
  {
    name: "pane_recall",
    description: "Search this project's memory for past decisions, lessons, patterns, and error fixes from previous sessions. Call this BEFORE searching files when you're trying to understand why something is the way it is, or when you suspect the answer was already worked out. Uses fuzzy matching — 'auth bug' matches 'authentication error'. Combine with pane_find_symbol to go from memory to code.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms. Leave empty to surface recent history." },
      },
    },
  },
  {
    name: "pane_recall_all",
    description: "Search memory across ALL projects. Use when solving a problem that other projects may have already solved, or when looking for patterns that transcend this project. More targeted than pane_cross_project — use when you have a specific query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms to find across all projects." },
      },
      required: ["query"],
    },
  },
  {
    name: "pane_remember",
    description: "Save a decision, lesson, pattern, or error fix to project memory for future sessions. Call this when you discover something worth preserving — a root cause, a constraint, a design decision, a fix that wasn't obvious. Good memory saves future sessions from re-discovering the same things.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["decision", "lesson", "pattern", "error_fix"],
          description: "Category of memory",
        },
        content: { type: "string", description: "What to remember — be specific and include context" },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "pane_brief",
    description: "Read the project's accumulated memory brief — top decisions, lessons, frequently modified files, and the last session summary. Good starting point when resuming work or when you need a quick read on project history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_checkpoints",
    description: "List available file snapshots captured before edits. Use when the user wants to review or roll back a specific file to an earlier state. Pair with pane_revert_change when a specific change needs to be undone.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_change_history",
    description: "List all file changes made during this session — file, old content, new content, timestamp. Use when the user asks what was changed, wants to audit edits, or needs to undo something. Pair with pane_search_changes to narrow by file or content.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_search_changes",
    description: "Search change history by file path or content. Use instead of pane_change_history when you're looking for a specific edit rather than reviewing the full list.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (matches file, content, or description)" },
        file_path: { type: "string", description: "Filter to a specific file path" },
      },
    },
  },
  {
    name: "pane_revert_change",
    description: "Revert a specific change by ID, restoring the file to its previous state. Get the change ID from pane_change_history or pane_search_changes first. Use when the user wants to undo a specific edit rather than a full rollback.",
    inputSchema: {
      type: "object",
      properties: {
        change_id: { type: "string", description: "The ID of the change to revert" },
      },
      required: ["change_id"],
    },
  },
  {
    name: "pane_knowledge_graph",
    description: "View the project's knowledge graph — how decisions, patterns, lessons, and errors connect to each other, including cross-project links. Use when you need to understand the relationships between architectural choices. Complements pane_brief: brief for the summary, graph for the connections.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_cross_project",
    description: "Find patterns, decisions, and lessons from OTHER projects relevant to current work. Use when facing a problem that other projects may have already solved — architecture patterns, recurring bugs, integration approaches. More contextual than pane_recall_all — it finds connections, not just keyword matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for across other projects." },
      },
      required: ["query"],
    },
  },
  {
    name: "pane_profile",
    description: "View the user's profile — explicit rules, learned preferences, design philosophy, and known anti-patterns. Call this when you need to understand how the user likes to work before proposing an approach, or when their preferences are directly relevant to the task. Rules in this profile are binding.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_set_rule",
    description: "Add a firm behavioral rule to the user's profile. Call this immediately when the user says 'always X', 'never Y', or states a hard preference. Rules override everything else and apply across all future sessions. Do not wait — capture it when it's stated.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The rule, e.g. 'always use bun instead of npm'" },
      },
      required: ["rule"],
    },
  },
  {
    name: "pane_set_philosophy",
    description: "Update the user's design philosophy — aesthetic principles and values that apply across all projects. Call when the user articulates how they think about design, architecture, or code quality at a general level. Replaces the existing philosophy, so include everything.",
    inputSchema: {
      type: "object",
      properties: {
        philosophy: { type: "string", description: "The full design philosophy (replaces existing)" },
      },
      required: ["philosophy"],
    },
  },
  {
    name: "pane_set_about",
    description: "Record what this project is — its purpose, identity, and how it works. Call this once you have understood the project deeply enough to articulate it clearly. This grounds every future suggestion in the project's actual context. Per-project, not global. Writes to about.md.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "The project's description — what it is, who it's for, the problem it solves, its identity and direction" },
      },
      required: ["about"],
    },
  },
  {
    name: "pane_find_symbol",
    description: "Find any exported symbol — function, class, type, interface, constant — by name. Returns exact file and line number instantly from the index. Always call this FIRST when you know the name of something you're looking for. Do not use Grep to find a symbol by name when this tool exists.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name to find (partial match supported)" },
        kind: {
          type: "string",
          enum: ["function", "class", "const", "let", "var", "type", "interface", "enum", "default", "namespace", "reexport", "async_fn"],
          description: "Narrow by symbol kind (optional)",
        },
        file: { type: "string", description: "Narrow by file path (partial match, optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "pane_find_references",
    description: "Find every place a symbol is used across the codebase — imports, call sites, JSX usage, and type references. Use after pane_find_symbol to go from declaration to all usages. Grouped by file with surrounding context. Does not require the symbol to be indexed.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Exact symbol name to find usages of (e.g. 'useAuth', 'ProjectList', 'MAX_RETRIES')",
        },
        projectRoot: {
          type: "string",
          description: "Absolute path to the project root to search within",
        },
        projectId: {
          type: "string",
          description: "Optional project ID — used to tag the declaration site in results",
        },
      },
      required: ["symbol", "projectRoot"],
    },
  },
  {
    name: "pane_ui_constraints",
    description: "Get the hard design constraints for a specific component type before writing any UI code. Returns forbidden Tailwind patterns, design tokens, a reference implementation, and active anti-patterns. Call this before writing any React component or Tailwind classes.",
    inputSchema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Component type or description, e.g. 'search input', 'floating panel', 'terminal output'" },
        projectId: { type: "string" },
      },
      required: ["component"],
    },
  },
  {
    name: "pane_record_ui_decision",
    description: "Record a confirmed UI design decision into the constraint registry. Call this after the developer confirms a design choice so it persists for future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The design rule to record" },
        categories: { type: "string", description: "Comma-separated categories (e.g. 'input,search,floating')" },
        forbiddenPatterns: { type: "string", description: "Comma-separated forbidden Tailwind patterns" },
        positiveExample: { type: "string", description: "Example of the correct approach" },
        negativeExample: { type: "string", description: "Example of what NOT to do" },
        hardness: { type: "string", description: "'firm' or 'prefer'" },
        projectId: { type: "string" },
      },
      required: ["rule", "categories"],
    },
  },
  {
    name: "pane_codebase_navigator",
    description: "Build a structural dependency map for a component or symbol — what it imports, what imports it, relevant types, and the suggested read order. Use this before making changes to understand the blast radius. Unlike pane_codebase_compass (semantic), this traverses the actual import graph.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Component name, file path, or symbol to map (e.g. 'InputBar', 'src/renderer/components/Workspace/InputBar.tsx', 'useProjectsStore')" },
        projectRoot: { type: "string" },
        depth: { type: "number", description: "Traversal depth (1 or 2, default 1)" },
      },
      required: ["target"],
    },
  },
  {
    name: "pane_architecture_brief",
    description: "Get the architectural decisions, locked patterns, and gotchas for a specific subsystem before making changes. Call this before touching files in an unfamiliar subsystem. Returns the pattern in effect, locked decisions not open for reconsideration, known tensions resolved, and specific failure modes.",
    inputSchema: {
      type: "object",
      properties: {
        subsystem: { type: "string", description: "Subsystem name or file path (e.g. 'terminal', 'ipc', 'src/main/pty-worker.mjs')" },
        projectId: { type: "string" },
      },
      required: ["subsystem"],
    },
  },
  {
    name: "pane_record_architecture_decision",
    description: "Record a confirmed architectural decision into the subsystem registry. Call this after the developer confirms an architectural choice.",
    inputSchema: {
      type: "object",
      properties: {
        subsystem: { type: "string", description: "The subsystem name or id to record the decision for" },
        decision: { type: "string", description: "The architectural decision" },
        rationale: { type: "string", description: "Why this decision was made" },
        projectId: { type: "string" },
      },
      required: ["subsystem", "decision", "rationale"],
    },
  },
  {
    name: "pane_read_files",
    description: "Read multiple files at once and return all contents in a single response. Use this instead of sequential Read calls when you need several files — batching saves significant round-trip overhead. Max 15 files per call.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of file paths to read (relative to project root or absolute)",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "pane_roadmap",
    description: "Read or update the project roadmap and workflow phase. Use this to manage the entire build lifecycle: discovery → planning → execution → verification → reflection.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "create", "set_kickoff_field", "populate_steps", "update_step", "add_decision", "update_verification", "complete_milestone", "log_session", "skip_milestone", "add_milestone", "reorder_milestones"],
          description: "read: get current roadmap | create: create roadmap with milestones | set_kickoff_field: save a discovery field | populate_steps: add steps to active milestone | update_step: mark a step status | add_decision: log a product decision | update_verification: record verification results | complete_milestone: finish milestone and advance | log_session: log session notes | skip_milestone: skip with reason | add_milestone: add a new milestone | reorder_milestones: reorder upcoming milestones",
        },
        field: { type: "string", description: "For set_kickoff_field: one of projectName, corePurpose, targetUser, platform, coreEntities, firstUsableAction, scopeBoundaries, existingContext, referenceApps, constraints, deployTarget" },
        value: { description: "For set_kickoff_field: the value to store (string or array)" },
        name: { type: "string", description: "For create: project name" },
        purpose: { type: "string", description: "For create: core purpose of the project" },
        stack: { type: "object", description: "For create: technology stack info" },
        milestones: { type: "array", description: "For create: array of {title, description} objects" },
        steps: { type: "array", description: "For populate_steps: array of {title, detail?} objects" },
        milestone_id: { type: "string", description: "For update_step, add_decision, skip_milestone" },
        step_id: { type: "string", description: "For update_step" },
        step_status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"], description: "For update_step" },
        question: { type: "string", description: "For add_decision" },
        answer: { type: "string", description: "For add_decision" },
        verification_passed: { type: "boolean", description: "For update_verification" },
        checks: { type: "array", description: "For update_verification: array of check result strings" },
        steps_completed: { type: "number", description: "For log_session" },
        notes: { type: "string", description: "For log_session" },
        reason: { type: "string", description: "For skip_milestone" },
        title: { type: "string", description: "For add_milestone" },
        description: { type: "string", description: "For add_milestone" },
        order: { type: "number", description: "For add_milestone" },
        ordered_ids: { type: "array", description: "For reorder_milestones: milestone IDs in desired order" },
      },
      required: ["action"],
    },
  },
  {
    name: "explore",
    description: "Semantic codebase exploration — search by meaning, get the full picture. Returns relevant files, key functions with code excerpts, module relationships, and project constraints. One call replaces multiple grep + read cycles. Use this when you need to understand how something works, find where something is implemented, or get context before making changes.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language question about the codebase. Examples: 'how does routing work', 'where is auth handled', 'what calls orchestrateContext'",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Roadmap + workflow helpers — self-contained file I/O, no Electron imports.
// Mirrors roadmap-manager.mjs and workflow-manager.mjs but uses only node:fs.
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(PANE_DIR, "projects");
const SESSION_DIR  = path.join(PANE_DIR, "session");

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Roadmap CRUD
function roadmapPath(id) { return path.join(PROJECTS_DIR, id, "roadmap.json"); }
function readRoadmap(id) {
  try { return JSON.parse(fs.readFileSync(roadmapPath(id), "utf-8")); } catch { return null; }
}
function writeRoadmap(id, roadmap) {
  fs.mkdirSync(path.join(PROJECTS_DIR, id), { recursive: true });
  fs.writeFileSync(roadmapPath(id), JSON.stringify(roadmap, null, 2), "utf-8");
}

// Session state (phase + kickoff context)
function statePath(id) { return path.join(SESSION_DIR, id, "state.json"); }
function readSessionState(id) {
  try { return JSON.parse(fs.readFileSync(statePath(id), "utf-8")); } catch { return {}; }
}
function writeSessionState(id, state) {
  fs.mkdirSync(path.join(SESSION_DIR, id), { recursive: true });
  fs.writeFileSync(statePath(id), JSON.stringify(state, null, 2), "utf-8");
}
function mergeSessionState(id, delta) {
  const state = readSessionState(id);
  writeSessionState(id, { ...state, ...delta });
}

// Phase helpers
function getPhase(id) { return readSessionState(id).phase || "idle"; }
function transitionPhase(id, phase) {
  mergeSessionState(id, { phase, phaseEnteredAt: Date.now(), suspended: false, clarification: null });
}

// Kickoff validation — mirrors KICKOFF_REQUIRED_FIELDS in workflow-manager.mjs
const KICKOFF_FIELDS = {
  projectName:       { label: "project name",            validator: null },
  corePurpose:       { label: "core purpose",            validator: null },
  targetUser:        { label: "who uses it",             validator: null },
  platform:          { label: "platform",                validator: null },
  coreEntities:      { label: "core data entities (≥2)", validator: (v) => Array.isArray(v) && v.length >= 2 },
  firstUsableAction: { label: "first usable action",     validator: null },
  scopeBoundaries:   { label: "scope boundaries (≥1)",   validator: (v) => Array.isArray(v) && v.length >= 1 },
};
const KICKOFF_OPTIONAL = new Set(["existingContext", "referenceApps", "constraints", "deployTarget"]);
const ALL_KICKOFF_FIELD_NAMES = new Set([...Object.keys(KICKOFF_FIELDS), ...KICKOFF_OPTIONAL]);

function getKickoffCtx(id)    { return readSessionState(id).kickoffContext || {}; }
function setKickoffFieldValue(id, field, value) {
  const state = readSessionState(id);
  const kickoff = state.kickoffContext || {};
  kickoff[field] = value;
  writeSessionState(id, { ...state, kickoffContext: kickoff });
}
function getMissingKickoffFields(id) {
  const ctx = getKickoffCtx(id);
  return Object.entries(KICKOFF_FIELDS)
    .filter(([key, def]) => {
      const v = ctx[key];
      if (v === undefined || v === null || v === "") return true;
      return def.validator && !def.validator(v);
    })
    .map(([key]) => key);
}

// Roadmap mutation helpers (mirrors roadmap-manager.mjs)
function getActiveMilestone(id) {
  const r = readRoadmap(id);
  return r ? (r.milestones.find(m => m.status === "active") || null) : null;
}
function updateMilestone(id, milestoneId, delta) {
  const r = readRoadmap(id);
  if (!r) return null;
  const i = r.milestones.findIndex(m => m.id === milestoneId);
  if (i === -1) return null;
  r.milestones[i] = { ...r.milestones[i], ...delta };
  r.updatedAt = Date.now();
  writeRoadmap(id, r);
  return r;
}
function updateStepInMilestone(id, milestoneId, stepId, delta) {
  const r = readRoadmap(id);
  if (!r) return null;
  const m = r.milestones.find(m => m.id === milestoneId);
  if (!m) return null;
  const i = (m.steps || []).findIndex(s => s.id === stepId);
  if (i === -1) return null;
  m.steps[i] = { ...m.steps[i], ...delta };
  r.updatedAt = Date.now();
  writeRoadmap(id, r);
  return r;
}
function advanceToNextMilestone(id) {
  const r = readRoadmap(id);
  if (!r) return null;
  const ai = r.milestones.findIndex(m => m.status === "active");
  if (ai !== -1) { r.milestones[ai].status = "done"; r.milestones[ai].completedAt = Date.now(); }
  const upcoming = r.milestones
    .filter(m => m.status === "upcoming")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let next = null;
  if (upcoming.length > 0) {
    const ni = r.milestones.findIndex(m => m.id === upcoming[0].id);
    r.milestones[ni].status = "active";
    r.milestones[ni].startedAt = Date.now();
    next = r.milestones[ni];
  }
  r.updatedAt = Date.now();
  writeRoadmap(id, r);
  return next;
}

// --- Tool implementations ---

async function handleToolCall(name, args) {
  const stateDir = path.join(PANE_DIR, "state", PROJECT_ID);
  const memoryDir = path.join(PANE_DIR, "memory", PROJECT_ID);

  switch (name) {
    case "pane_project_context": {
      const data = await readJson(path.join(stateDir, "project.json"));
      if (!data) {
        return text(`Project: ${PROJECT_ID}\nRoot: ${PROJECT_ROOT}\nNo state file found yet — Pane hasn't synced state.`);
      }
      let out = `Project: ${data.name}\nRoot: ${data.root}`;
      if (data.gitBranch) out += `\nGit branch: ${data.gitBranch}`;
      if (data.topLevelFiles?.length) out += `\nTop-level files:\n${data.topLevelFiles.map(f => `  ${f}`).join("\n")}`;
      return text(out);
    }

    case "pane_open_files": {
      const data = await readJson(path.join(stateDir, "editor.json"));
      if (!data || !data.activeFile) return text("No file currently open in editor.");
      let out = `Open file: ${data.activeFile}`;
      if (data.recentFiles?.length > 1) {
        out += `\nRecent files: ${data.recentFiles.slice(0, 10).join(", ")}`;
      }
      if (data.content) {
        const lines = data.content.split("\n");
        const preview = lines.length > 200
          ? lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`
          : data.content;
        out += `\n\n--- Content ---\n${preview}`;
      }
      return text(out);
    }

    case "pane_recent_terminal": {
      const data = await readJson(path.join(stateDir, "terminal.json"));
      if (!data?.commands?.length) return text("No terminal history.");
      const cmds = data.commands.slice(-20);
      const out = cmds.map(c => {
        const output = c.output?.length > 1000
          ? c.output.slice(0, 1000) + "\n... (truncated)"
          : c.output || "(no output)";
        return `$ ${c.cmd}\n${output}`;
      }).join("\n\n");

      // Contextual augmentation: if terminal has errors with file references,
      // auto-attach the relevant code so the model doesn't need extra Read calls.
      const lastOutput = cmds[cmds.length - 1]?.output || "";
      const augmentation = await augmentWithReferencedFiles(lastOutput, PROJECT_ROOT);
      return text(out + augmentation);
    }

    case "pane_run_in_terminal": {
      const command = (args?.command || "").trim();
      if (!command) return text("Error: no command provided.");
      const timeoutSecs = Math.min(Math.max(Number(args?.timeout) || 30, 1), 120);
      const cwd = PROJECT_ROOT || process.cwd();
      let output = "";
      let exitCode = 0;
      try {
        // execSync avoids libuv's uv_spawn/kqueue EVFILT_PROC path (macOS leak).
        // Append 2>&1 to merge stderr into stdout for capture.
        const result = execSync(`${command} 2>&1`, {
          cwd,
          env: getEnvWithPath(),
          timeout: timeoutSecs * 1000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        output = (result || "").trimEnd();
      } catch (err) {
        exitCode = err.status ?? 1;
        const partial = (err.stdout?.toString?.() || err.stderr?.toString?.() || "").trimEnd();
        output = partial
          ? `Exit ${exitCode}\n${partial}`
          : (err.killed ? `Error: command timed out after ${timeoutSecs}s` : `Error: ${err.message}`);
      }
      await appendTerminalHistory(stateDir, command, output);
      const result = output || "(no output)";

      // Contextual augmentation: if command output has errors with file references,
      // auto-attach the code so the model can fix without extra Read calls.
      const augmentation = exitCode !== 0
        ? await augmentWithReferencedFiles(output, PROJECT_ROOT)
        : "";
      return text((exitCode === 0 ? result : `Exit ${exitCode}\n${result}`) + augmentation);
    }

    case "pane_recall": {
      const query = (args?.query || "").trim();

      // Try brain semantic search first (if export exists)
      if (query) {
        const brainResults = await semanticSearch(query, PROJECT_ID);
        if (brainResults && brainResults.length > 0) {
          const out = brainResults.map(r => {
            return `[${r.type}] (confidence: ${r.confidence.toFixed(2)}, match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`;
          }).join("\n\n");
          return text(out);
        }
      }

      // Fallback: JSONL fuzzy search
      const queryLower = query.toLowerCase();
      const eventsPath = path.join(memoryDir, "events.jsonl");
      const raw = await readText(eventsPath);
      if (!raw) return text("No project memory yet — this is the first session.");

      const events = raw.trim().split("\n").map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      let matches;
      if (queryLower) {
        const scored = events.map(e => {
          const content = (e.content || "").toLowerCase();
          const type = (e.type || "").toLowerCase();
          const score = Math.max(fuzzyScore(queryLower, content), fuzzyScore(queryLower, type));
          return { event: e, score };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
        matches = scored.map(s => s.event).slice(0, 30);
      } else {
        matches = events.slice(-30);
      }

      if (matches.length === 0) {
        return text(query ? `No memories matching "${query}".` : "No memories recorded yet.");
      }

      const out = matches.map(e => {
        const ago = e.timestamp ? timeSince(e.timestamp) : "";
        const meta = e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join(" ") : "";
        return `[${e.type}]${ago ? ` (${ago})` : ""}${meta ? ` {${meta}}` : ""}\n${e.content}`;
      }).join("\n\n");
      return text(out);
    }

    case "pane_recall_all": {
      const query = (args?.query || "").toLowerCase().trim();
      if (!query) return text("Query is required for cross-project search.");

      const memoryRoot = path.join(PANE_DIR, "memory");
      let projectDirs;
      try { projectDirs = await fs.promises.readdir(memoryRoot); }
      catch { return text("No project memory found."); }

      const allResults = [];
      for (const projectDir of projectDirs) {
        const eventsPath = path.join(memoryRoot, projectDir, "events.jsonl");
        const raw = await readText(eventsPath);
        if (!raw) continue;

        const events = raw.trim().split("\n").map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        for (const e of events) {
          const content = (e.content || "").toLowerCase();
          const score = fuzzyScore(query, content);
          if (score > 0) {
            allResults.push({ event: e, project: projectDir, score });
          }
        }
      }

      allResults.sort((a, b) => b.score - a.score);
      const top = allResults.slice(0, 20);

      if (top.length === 0) {
        return text(`No memories matching "${query}" across any project.`);
      }

      const out = top.map(r => {
        const e = r.event;
        const ago = e.timestamp ? timeSince(e.timestamp) : "";
        return `[${r.project}] [${e.type}]${ago ? ` (${ago})` : ""}\n${e.content}`;
      }).join("\n\n");
      return text(out);
    }

    case "pane_remember": {
      if (!args?.content) return text("Nothing to remember — content is required.");
      const event = {
        type: args.type || "decision",
        content: args.content,
        timestamp: Date.now(),
        source: "claude",
      };
      await fs.promises.mkdir(memoryDir, { recursive: true });
      await fs.promises.appendFile(
        path.join(memoryDir, "events.jsonl"),
        JSON.stringify(event) + "\n",
      );
      return text(`Saved to project memory: [${event.type}] ${event.content}`);
    }

    case "pane_brief": {
      const parts = [];
      const about = await readText(path.join(memoryDir, "about.md"));
      if (about) {
        parts.push("## About");
        parts.push(about.trim());
        parts.push("");
      }
      const brief = await readText(path.join(memoryDir, "brief.md"));
      if (brief) parts.push(brief);
      if (!parts.length) return text("No project brief yet — memory will accumulate as you work.");
      return text(parts.join("\n"));
    }

    case "pane_checkpoints": {
      const cpDir = path.join(PANE_DIR, "checkpoints", PROJECT_ID);
      const manifest = await readJson(path.join(cpDir, "manifest.json"));
      if (!manifest?.checkpoints?.length) return text("No checkpoints available.");

      const out = manifest.checkpoints.map(cp => {
        const ago = cp.timestamp ? timeSince(cp.timestamp) : "";
        return `${cp.id} — ${cp.fileCount} files${ago ? ` (${ago})` : ""}`;
      }).join("\n");
      return text(`${manifest.checkpoints.length} checkpoints:\n${out}`);
    }

    case "pane_change_history": {
      const db = getDb();
      if (!db) return text("Change history requires the native SQLite module, which is only available when running inside Pane. Use the Claude backend for this tool.");
      let rows = [];
      try {
        rows = db.prepare("SELECT * FROM change_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT 500").all(PROJECT_ID);
      } catch (err) {
        return text(`Error: Failed to query change history from SQLite: ${err.message}`);
      }

      if (rows.length === 0) return text("No change history yet. Changes will be recorded as you edit files.");

      const out = rows.map(c => {
        const date = new Date(c.timestamp).toLocaleString();
        const oldStr = c.old_string || "";
        const newStr = c.new_string || "";
        const shortOld = oldStr.length > 50 ? oldStr.slice(0, 50) + "..." : oldStr;
        const shortNew = newStr.length > 50 ? newStr.slice(0, 50) + "..." : newStr;
        return `${c.id} — ${c.file_path}\n  ${date}\n  "${shortOld}" → "${shortNew}"`;
      }).join("\n\n");
      return text(`${rows.length} changes:\n\n${out}`);
    }

    case "pane_search_changes": {
      const query = args?.query;
      const filePath = args?.file_path;
      const db = getDb();
      if (!db) return text("Change search requires the native SQLite module, which is only available when running inside Pane. Use the Claude backend for this tool.");
      let rows = [];

      try {
        if (filePath) {
          rows = db.prepare("SELECT * FROM change_history WHERE project_id = ? AND file_path = ? ORDER BY timestamp DESC LIMIT 200").all(PROJECT_ID, filePath);
        } else if (query) {
          const like = `%${query}%`;
          rows = db.prepare("SELECT * FROM change_history WHERE project_id = ? AND (file_path LIKE ? OR description LIKE ? OR new_string LIKE ? OR old_string LIKE ?) ORDER BY timestamp DESC LIMIT 200")
            .all(PROJECT_ID, like, like, like, like);
        } else {
          rows = db.prepare("SELECT * FROM change_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT 500").all(PROJECT_ID);
        }
      } catch (err) {
        return text(`Error: Failed to query change history from SQLite: ${err.message}`);
      }

      if (rows.length === 0) return text("No matching changes found.");

      const out = rows.map(c => {
        const date = new Date(c.timestamp).toLocaleString();
        return `${c.id} — ${c.file_path}\n  ${date}\n  "${c.old_string || ""}" → "${c.new_string || ""}"`;
      }).join("\n\n");
      return text(`${rows.length} matching changes:\n\n${out}`);
    }

    case "pane_revert_change": {
      const changeId = args?.change_id;
      const db = getDb();
      if (!db) return text("Change revert requires the native SQLite module, which is only available when running inside Pane. Use the Claude backend for this tool.");
      let change = null;
      try {
        change = db.prepare("SELECT * FROM change_history WHERE id = ?").get(changeId);
      } catch (err) {
        return text(`Error: Failed to query SQLite: ${err.message}`);
      }

      if (!change) return text(`Error: Change ${changeId} not found.`);

      const resolvedPath = path.isAbsolute(change.file_path) ? change.file_path : path.join(PROJECT_ROOT, change.file_path);

      try {
        const currentContent = await fs.promises.readFile(resolvedPath, "utf-8");
        const oldStr = change.old_string || "";
        const newStr = change.new_string || "";

        if (!currentContent.includes(newStr)) {
          return text("Error: File content doesn't match expected change. The file may have been modified since this change was made.");
        }

        const revertedContent = currentContent.replace(newStr, oldStr);
        await fs.promises.writeFile(resolvedPath, revertedContent, "utf-8");

        db.prepare("DELETE FROM change_history WHERE id = ?").run(changeId);

        return text(`Successfully reverted change in ${change.file_path}`);
      } catch (error) {
        return text(`Error: ${error.message}`);
      }
    }

    case "pane_knowledge_graph": {
      const exported = await readBrainExport(PROJECT_ID);
      if (!exported || exported.length === 0) return text("Knowledge graph is empty — it grows as you work.");

      // Group by type, exclude mind entries
      const byType = {};
      for (const node of exported) {
        if (node.type === "mind") continue;
        if (!byType[node.type]) byType[node.type] = [];
        byType[node.type].push(node);
      }

      const highConf = exported.filter(n => n.confidence > 0.7).length;
      const parts = [`Knowledge graph: ${exported.length} nodes (${highConf} high-confidence)\n`];
      for (const [type, nodes] of Object.entries(byType)) {
        parts.push(`### ${type} (${nodes.length})`);
        // Show top by confidence
        const sorted = nodes.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
        for (const n of sorted) {
          parts.push(`  [${n.confidence.toFixed(2)}] ${n.content.slice(0, 120)}`);
        }
      }
      return text(parts.join("\n"));
    }

    case "pane_cross_project": {
      const query = (args?.query || "").trim();
      if (!query) return text("Query is required for cross-project search.");

      // Search across all project exports (excluding current)
      const exportsDir = path.join(PANE_DIR, "brain", "exports");
      let files;
      try { files = await fs.promises.readdir(exportsDir); }
      catch { return text("No brain exports found — intelligence hasn't indexed any projects yet."); }

      const queryEmbedding = await embedText(query);
      const allResults = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const otherProjectId = file.replace(".json", "");
        if (otherProjectId === PROJECT_ID) continue;

        const exported = await readJson(path.join(exportsDir, file));
        if (!exported || exported.length === 0) continue;

        for (const node of exported) {
          if (!["decision", "lesson", "pattern", "error_fix"].includes(node.type)) continue;
          if (node.confidence < 0.4) continue;

          let score = 0;
          if (queryEmbedding && node.embedding) {
            score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
          }
          score += 0.4 * fuzzyScore(query.toLowerCase(), (node.content || "").toLowerCase());

          if (score > 0.3) {
            allResults.push({ ...node, project: otherProjectId, score });
          }
        }
      }

      allResults.sort((a, b) => b.score - a.score);
      const top = allResults.slice(0, 15);

      if (top.length === 0) return text(`No cross-project insights found for "${query}".`);

      const out = top.map(r =>
        `[${r.project}] [${r.type}] (confidence: ${r.confidence.toFixed(2)}, match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`
      ).join("\n\n");
      return text(out);
    }

    case "pane_profile": {
      const profileDir = path.join(PANE_DIR, "profile");
      const parts = [];

      // Read profile export (combined narrative view)
      try {
        const exported = await fs.promises.readFile(path.join(profileDir, "profile-export.md"), "utf-8");
        if (exported.trim().length > 10) {
          parts.push(exported.trim());
        }
      } catch {}

      // Rules — the actual rules, not just a count
      try {
        const rules = await fs.promises.readFile(path.join(profileDir, "rules.md"), "utf-8");
        if (rules.trim().length > 5) {
          parts.push("\n## Rules");
          parts.push(rules.trim());
        }
      } catch {}

      // Philosophy
      try {
        const phil = await fs.promises.readFile(path.join(profileDir, "philosophy.md"), "utf-8");
        if (phil.trim().length > 5) {
          parts.push("\n## Design Philosophy");
          parts.push(phil.trim());
        }
      } catch {}

      // Preferences — actual content, not just counts
      try {
        const prefs = JSON.parse(await fs.promises.readFile(path.join(profileDir, "preferences.json"), "utf-8"));
        const tools = prefs.tools || {};
        const coding = prefs.coding || {};

        if (Object.keys(tools).length > 0) {
          parts.push("\n## Tool Preferences");
          for (const [key, val] of Object.entries(tools)) {
            const content = typeof val === "object" ? val.content || key : val;
            parts.push(`- ${content}`);
          }
        }

        if (Object.keys(coding).length > 0) {
          parts.push("\n## Coding Patterns");
          for (const [key, val] of Object.entries(coding)) {
            const content = typeof val === "object" ? val.content || key : val;
            parts.push(`- ${content}`);
          }
        }
      } catch {}

      // Anti-patterns
      try {
        const ap = JSON.parse(await fs.promises.readFile(path.join(profileDir, "anti-patterns.json"), "utf-8"));
        if (ap.patterns && ap.patterns.length > 0) {
          parts.push("\n## Anti-Patterns (things to avoid)");
          for (const p of ap.patterns) {
            parts.push(`- ${p.error || p.pattern || JSON.stringify(p)}`);
          }
        }
      } catch {}

      // Digest (graduated behavioral wiring)
      try {
        const digest = await fs.promises.readFile(path.join(profileDir, "digest.txt"), "utf-8");
        if (digest.trim().length > 5) {
          parts.push("\n## Behavioral Wiring (graduated from experience)");
          parts.push(digest.trim());
        }
      } catch {}

      if (parts.length === 0) return text("Profile is empty — it will grow as Pane observes your work patterns.");
      return text(parts.join("\n"));
    }

    case "pane_set_rule": {
      const rule = (args?.rule || "").trim();
      if (!rule) return text("Rule text is required.");

      const rulesPath = path.join(PANE_DIR, "profile", "rules.md");
      let content = "";
      try { content = await fs.promises.readFile(rulesPath, "utf-8"); }
      catch { content = "# Explicit Rules\n"; }

      if (content.includes(rule)) return text(`Rule already exists: "${rule}"`);

      content += `\n- ${rule}`;
      await fs.promises.writeFile(rulesPath, content);
      // Profile export will be rebuilt next time brain runs extractPreferences

      return text(`Rule added: "${rule}"`);
    }

    case "pane_set_philosophy": {
      const philosophy = (args?.philosophy || "").trim();
      if (!philosophy) return text("Philosophy text is required.");

      const philPath = path.join(PANE_DIR, "profile", "philosophy.md");
      await fs.promises.writeFile(philPath, philosophy);

      return text("Design philosophy updated.");
    }

    case "pane_set_about": {
      const about = (args?.about || "").trim();
      if (!about) return text("About text is required.");

      const aboutDir = path.join(PANE_DIR, "memory", PROJECT_ID);
      await fs.promises.mkdir(aboutDir, { recursive: true });
      await fs.promises.writeFile(path.join(aboutDir, "about.md"), about);

      return text("Project context recorded. Every future session on this project will carry this information.");
    }

    case "pane_find_symbol": {
      const query = (args?.query || "").trim();
      if (!query) return text("Query is required.");

      const symbolsPath = path.join(PANE_DIR, "brain", "symbols", `${PROJECT_ID}.json`);
      const exported = await readJson(symbolsPath);
      if (!exported?.symbols?.length) {
        return text("Symbol index not available yet — it builds automatically when you open a project in Pane.");
      }

      const q = query.toLowerCase();
      const kindFilter = args?.kind;
      const fileFilter = args?.file?.toLowerCase();

      // Fuzzy score: exact > prefix > contains > file/doc
      const scored = exported.symbols
        .filter(s => !kindFilter || s.kind === kindFilter)
        .filter(s => !fileFilter || s.file.toLowerCase().includes(fileFilter))
        .map(s => {
          const n = s.name.toLowerCase();
          let score = 0;
          if (n === q)              score = 1.0;
          else if (n.startsWith(q)) score = 0.8;
          else if (n.includes(q))   score = 0.6;
          else if (s.file.toLowerCase().includes(q)) score = 0.3;
          else if (s.doc?.toLowerCase().includes(q)) score = 0.2;
          return score > 0 ? { ...s, score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      if (scored.length === 0) {
        return text(`No symbols matching "${query}" found.${kindFilter ? ` (kind: ${kindFilter})` : ""}`);
      }

      const out = scored.map(s => {
        const doc = s.doc ? `\n    ${s.doc}` : "";
        return `${s.name} (${s.kind}) → ${s.file}:${s.line}${doc}`;
      }).join("\n");

      return text(`${scored.length} symbol${scored.length > 1 ? "s" : ""} matching "${query}":\n\n${out}`);
    }

    case "pane_find_references": {
      const symbol = (args?.symbol || "").trim();
      if (!symbol) return text("Symbol is required.");
      const projectRoot = args?.projectRoot || PROJECT_ROOT;
      const projectId = args?.projectId || PROJECT_ID;
      const { byFile, totalMatches, filesSearched } = await findReferences(symbol, projectRoot, { projectId });
      return text(formatReferencesOutput(symbol, byFile, totalMatches, filesSearched));
    }

    case "pane_read_files": {
      const paths = args?.paths || [];
      if (paths.length === 0) return text("No paths provided.");
      if (paths.length > 15) return text("Maximum 15 files per batch read.");

      const results = [];
      for (const p of paths) {
        try {
          const resolved = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
          const content = await fs.promises.readFile(resolved, "utf-8");
          const lines = content.split("\n").length;
          results.push(`### ${p} (${lines} lines)\n\`\`\`\n${content}\n\`\`\``);
        } catch (err) {
          results.push(`### ${p}\n[Error: ${err.message}]`);
        }
      }
      return text(`Read ${paths.length} files:\n\n${results.join("\n\n")}`);
    }

    case "pane_ui_constraints": {
      const projectId = args?.projectId || PROJECT_ID;
      const componentKey = (args?.component || "").toLowerCase();
      const constraintsPath = path.join(PANE_DIR, "memory", projectId, "ui-constraints.json");
      const data = await readJson(constraintsPath);
      if (!data) {
        return text("No UI constraints registered yet for this project. Use pane_record_ui_decision to add them.");
      }

      // Infer categories from component string
      const inferredCategories = new Set();
      if (componentKey.includes("input") || componentKey.includes("textarea")) inferredCategories.add("input");
      if (componentKey.includes("search")) inferredCategories.add("search");
      if (componentKey.includes("float") || componentKey.includes("panel") || componentKey.includes("picker")) inferredCategories.add("floating");
      if (componentKey.includes("terminal")) inferredCategories.add("terminal");

      const constraints = Array.isArray(data.constraints) ? data.constraints : [];
      const filtered = inferredCategories.size > 0
        ? constraints.filter(c => Array.isArray(c.categories) && c.categories.some(cat => inferredCategories.has(cat)))
        : constraints;

      const parts = [`UI Constraints for: ${args.component}\n`];

      parts.push(`HARD CONSTRAINTS (${filtered.length}):`);
      for (const c of filtered) {
        parts.push(`• ${c.rule}`);
        if (c.forbiddenPatterns?.length) parts.push(`  ✗ Forbidden: ${c.forbiddenPatterns.join(", ")}`);
        if (c.positiveExample) parts.push(`  ✓ Do: ${c.positiveExample}`);
        if (c.negativeExample) parts.push(`  ✗ Don't: ${c.negativeExample}`);
        if (c.referenceComponents?.[0]) parts.push(`  → Reference: ${c.referenceComponents[0]}`);
        if (c.establishedReason) parts.push(`  Reason: ${c.establishedReason}`);
        parts.push("");
      }

      const tokens = Array.isArray(data.designTokens) ? data.designTokens : [];
      if (tokens.length > 0) {
        parts.push("DESIGN TOKENS:");
        for (const t of tokens) {
          parts.push(`• ${t.token} = ${t.value}`);
          if (t.semanticMeaning) parts.push(`  Use for: ${t.semanticMeaning}`);
          if (t.neverUseFor?.length) parts.push(`  Never use for: ${Array.isArray(t.neverUseFor) ? t.neverUseFor.join(", ") : t.neverUseFor}`);
          parts.push("");
        }
      }

      const antiPatterns = Array.isArray(data.antiPatterns) ? data.antiPatterns : [];
      if (antiPatterns.length > 0) {
        parts.push("ANTI-PATTERNS TO AVOID:");
        for (const ap of antiPatterns) {
          parts.push(`• ${ap.name}: ${ap.description} — rejected because: ${ap.rejectedBecause}`);
        }
        parts.push("");
      }

      // ── Reference components — find real code that follows these rules ──
      // The model gets "no borders on inputs" as a rule AND a working example
      // to copy from. This is the difference between knowing the rule and
      // knowing how to apply it.
      try {
        const componentsDir = path.join(PROJECT_ROOT, "src", "renderer", "components");
        const componentFiles = [];
        async function walkComponents(dir, depth = 0) {
          if (depth > 4) return;
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              await walkComponents(path.join(dir, entry.name), depth + 1);
            } else if (entry.name.endsWith(".tsx")) {
              componentFiles.push(path.join(dir, entry.name));
            }
          }
        }
        await walkComponents(componentsDir);

        // Find components matching the query by filename or content keywords
        const queryWords = componentKey.split(/[\s-_]+/).filter(w => w.length >= 3);
        const matches = [];
        for (const file of componentFiles.slice(0, 50)) {
          const baseName = path.basename(file, ".tsx").toLowerCase();
          const nameMatch = queryWords.some(w => baseName.includes(w));
          if (nameMatch || (componentKey === "general" && matches.length < 2)) {
            try {
              const content = await fs.promises.readFile(file, "utf-8");
              const lines = content.split("\n");
              // Find the main component function/export
              let startLine = 0;
              for (let i = 0; i < lines.length; i++) {
                if (/^export\s+(default\s+)?function\s|^(const|function)\s+\w+.*=.*=>|^export\s+const\s+\w+.*memo\(/.test(lines[i])) {
                  startLine = i;
                  break;
                }
              }
              const excerpt = lines.slice(startLine, startLine + 30).join("\n");
              const relPath = path.relative(PROJECT_ROOT, file);
              matches.push({ file: relPath, excerpt });
            } catch {}
          }
          if (matches.length >= 2) break;
        }

        if (matches.length > 0) {
          parts.push("REFERENCE COMPONENTS (real code that follows these rules):");
          for (const m of matches) {
            parts.push(`\n### ${m.file}`);
            parts.push("```tsx");
            parts.push(m.excerpt);
            parts.push("```");
          }
        }
      } catch {}

      return text(parts.join("\n"));
    }

    case "pane_record_ui_decision": {
      const projectId = args?.projectId || PROJECT_ID;
      const rule = (args?.rule || "").trim();
      if (!rule) return text("Rule text is required.");
      const categories = (args?.categories || "").trim();
      if (!categories) return text("Categories are required.");

      const constraintsPath = path.join(PANE_DIR, "memory", projectId, "ui-constraints.json");
      let data = await readJson(constraintsPath);
      if (!data) {
        data = { version: 1, projectId, constraints: [], designTokens: [], antiPatterns: [] };
      }
      if (!Array.isArray(data.constraints)) data.constraints = [];

      const id = rule.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const newConstraint = {
        id,
        categories: categories.split(",").map(s => s.trim()).filter(Boolean),
        rule,
        forbiddenPatterns: args?.forbiddenPatterns ? args.forbiddenPatterns.split(",").map(s => s.trim()).filter(Boolean) : [],
        positiveExample: args?.positiveExample || "",
        negativeExample: args?.negativeExample || "",
        referenceComponents: [],
        establishedReason: "user-recorded",
        hardness: args?.hardness || "firm",
      };

      data.constraints.push(newConstraint);
      await writeJson(constraintsPath, data);
      return text(`Recorded UI decision: "${rule}"`);
    }

    case "pane_codebase_navigator": {
      const rootDir = args?.projectRoot || PROJECT_ROOT;
      const target = (args?.target || "").trim();
      const depth = Math.min(Math.max(Number(args?.depth) || 1, 1), 2);
      if (!target) return text("Target is required.");

      // Resolve target to a file path
      let primaryFile = null;
      if (target.includes("/") || target.endsWith(".tsx") || target.endsWith(".ts") || target.endsWith(".mjs") || target.endsWith(".js")) {
        // Looks like a path — resolve it
        const resolved = path.isAbsolute(target) ? target : path.join(rootDir, target);
        try { await fs.promises.access(resolved); primaryFile = resolved; } catch {}
        // Try with extensions if no extension given
        if (!primaryFile) {
          for (const ext of [".tsx", ".ts", ".js", ".mjs"]) {
            try { await fs.promises.access(resolved + ext); primaryFile = resolved + ext; break; } catch {}
          }
        }
      } else {
        // Search src/ for a file matching the name
        const srcDir = path.join(rootDir, "src");
        const searchName = target;
        async function walkForFile(dir, name, exclude = null) {
          let found = null;
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (entry.name === "node_modules" || entry.name === ".git") continue;
              const subDir = path.join(dir, entry.name);
              if (exclude?.has(subDir)) continue;
              found = await walkForFile(subDir, name, exclude);
              if (found) return found;
            } else {
              const base = entry.name.replace(/\.(tsx|ts|js|mjs)$/, "");
              if (base === name) { found = path.join(dir, entry.name); return found; }
            }
          }
          return null;
        }
        primaryFile = await walkForFile(srcDir, searchName);
        if (!primaryFile) primaryFile = await walkForFile(rootDir, searchName, new Set([srcDir]));
      }

      if (!primaryFile) {
        return text(`No file found matching "${target}". Try providing a file path directly.`);
      }

      const primaryRelPath = path.relative(rootDir, primaryFile);

      // Read the primary file and extract imports
      let primaryContent = "";
      try { primaryContent = await fs.promises.readFile(primaryFile, "utf-8"); } catch {
        return text(`Could not read file: ${primaryRelPath}`);
      }

      const importRegex = /from\s+['"]([^'"]+)['"]/g;
      const relativeImports = [];
      let m;
      while ((m = importRegex.exec(primaryContent)) !== null) {
        if (m[1].startsWith(".")) relativeImports.push(m[1]);
      }

      // Resolve each relative import to an absolute path
      const resolveImport = async (imp) => {
        const base = path.resolve(path.dirname(primaryFile), imp);
        for (const ext of ["", ".tsx", ".ts", ".js", ".mjs", "/index.tsx", "/index.ts", "/index.js"]) {
          try { await fs.promises.access(base + ext); return { specifier: imp, resolved: base + ext }; } catch {}
        }
        return null;
      };
      const resolvedImports = (await Promise.all(relativeImports.map(resolveImport))).filter(Boolean);

      // Extract named imports for each resolved import
      const namedImportRegex = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"](\.\.?\/[^'"]+)['"]/g;
      const importDetails = new Map();
      let nm;
      while ((nm = namedImportRegex.exec(primaryContent)) !== null) {
        const specifier = nm[4];
        const namedGroup = nm[1];
        const defaultImport = nm[2];
        const namespaceImport = nm[3];
        const label = namedGroup
          ? namedGroup.split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean).join(", ")
          : defaultImport || (namespaceImport ? `* as ${namespaceImport}` : "");
        importDetails.set(specifier, label || "default");
      }

      // Reverse lookup: find files in src/ that import the primary file
      const primaryFileName = path.basename(primaryFile).replace(/\.(tsx|ts|js|mjs)$/, "");
      const importedBy = [];
      const MAX_REVERSE_FILES = 30;
      let filesRead = 0;
      async function searchForImporters(dir) {
        if (filesRead >= MAX_REVERSE_FILES) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (filesRead >= MAX_REVERSE_FILES) return;
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            await searchForImporters(path.join(dir, entry.name));
          } else if (/\.(tsx|ts|js|mjs)$/.test(entry.name)) {
            const filePath = path.join(dir, entry.name);
            if (filePath === primaryFile) continue;
            filesRead++;
            try {
              const content = await fs.promises.readFile(filePath, "utf-8");
              const importRe = new RegExp(`from\\s+['"][^'"]*(?:/|^)${primaryFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
              if (importRe.test(content)) {
                importedBy.push(filePath);
              }
            } catch {}
          }
        }
      }
      await searchForImporters(path.join(rootDir, "src"));

      // Store dependencies: imports matching stores/
      const storeDeps = new Map();
      for (const { specifier, resolved } of resolvedImports) {
        if (specifier.includes("store") || specifier.includes("Store")) {
          // Extract named imports from the main import regex result
          const detail = importDetails.get(specifier) || "";
          const storeName = path.basename(resolved).replace(/\.(tsx|ts|js|mjs)$/, "");
          storeDeps.set(storeName, detail);
        }
      }

      // Type dependencies: import type lines or paths containing "types"
      const typeDeps = [];
      const typeImportRegex = /import\s+type\s+[^;]+from\s+['"]([^'"]+)['"]/g;
      let tm;
      while ((tm = typeImportRegex.exec(primaryContent)) !== null) {
        if (tm[1].startsWith(".")) {
          const resolved = path.resolve(path.dirname(primaryFile), tm[1]);
          typeDeps.push(path.relative(rootDir, resolved));
        }
      }
      for (const { specifier, resolved } of resolvedImports) {
        if (specifier.includes("type") || specifier.includes("types")) {
          const rel = path.relative(rootDir, resolved);
          if (!typeDeps.includes(rel)) typeDeps.push(rel);
        }
      }

      // Depth 2: trace imports of imports
      const depth2Imports = [];
      if (depth >= 2) {
        await Promise.all(resolvedImports.slice(0, 5).map(async ({ resolved }) => {
          try {
            const content = await fs.promises.readFile(resolved, "utf-8");
            const d2regex = /from\s+['"]([^'"]+)['"]/g;
            let d2m;
            while ((d2m = d2regex.exec(content)) !== null) {
              if (d2m[1].startsWith(".")) {
                const d2base = path.resolve(path.dirname(resolved), d2m[1]);
                for (const ext of ["", ".tsx", ".ts", ".js", ".mjs"]) {
                  try {
                    await fs.promises.access(d2base + ext);
                    const rel = path.relative(rootDir, d2base + ext);
                    if (!depth2Imports.includes(rel)) depth2Imports.push(rel);
                    break;
                  } catch {}
                }
              }
            }
          } catch {}
        }));
      }

      // Suggest read order: types → stores → primary → importedBy
      const readOrder = [];
      for (const t of typeDeps.slice(0, 3)) readOrder.push({ file: t, reason: "type contracts first" });
      for (const [storeName] of storeDeps) readOrder.push({ file: `(store) ${storeName}`, reason: "state shape" });
      readOrder.push({ file: primaryRelPath, reason: "primary target" });
      for (const f of importedBy.slice(0, 3)) readOrder.push({ file: path.relative(rootDir, f), reason: "consumers — understand blast radius" });

      // Format output
      const out = [];
      out.push(`Task Map: ${target}\n`);
      out.push(`Primary file:\n  ${primaryRelPath}\n`);

      if (resolvedImports.length > 0) {
        out.push("Imports (reads from):");
        for (const { specifier, resolved } of resolvedImports) {
          const rel = path.relative(rootDir, resolved);
          const detail = importDetails.get(specifier) || "default";
          out.push(`  ${rel} — ${detail}`);
        }
        out.push("");
      } else {
        out.push("Imports (reads from):\n  (none — no relative imports)\n");
      }

      if (importedBy.length > 0) {
        out.push("Imported by (changes here affect):");
        for (const f of importedBy) out.push(`  ${path.relative(rootDir, f)}`);
        out.push("");
      } else {
        out.push("Imported by (changes here affect):\n  (none found in src/)\n");
      }

      if (storeDeps.size > 0) {
        out.push("Store dependencies:");
        for (const [storeName, slices] of storeDeps) {
          out.push(`  ${storeName}: ${slices || "(default import)"}`);
        }
        out.push("");
      }

      if (typeDeps.length > 0) {
        out.push("Type dependencies:");
        for (const t of typeDeps) out.push(`  ${t}`);
        out.push("");
      }

      if (readOrder.length > 0) {
        out.push("Suggested read order:");
        readOrder.forEach((r, i) => out.push(`  ${i + 1}. ${r.file} — ${r.reason}`));
        out.push("");
      }

      if (depth >= 2 && depth2Imports.length > 0) {
        out.push(`Depth 2: also traced imports of imports (${depth2Imports.length} additional):`);
        for (const d of depth2Imports.slice(0, 10)) out.push(`  ${d}`);
      }

      return text(out.join("\n"));
    }

    case "pane_architecture_brief": {
      const projectId = args?.projectId || PROJECT_ID;
      const subsystemArg = (args?.subsystem || "").trim();
      if (!subsystemArg) return text("Subsystem is required.");

      const subsystemsPath = path.join(PANE_DIR, "memory", projectId, "subsystems.json");
      const data = await readJson(subsystemsPath);
      if (!data) {
        return text("No subsystem registry found. Create one at ~/.pane/memory/{projectId}/subsystems.json or use pane_record_architecture_decision to start one.");
      }

      const subsystems = Array.isArray(data.subsystems) ? data.subsystems : [];
      const subsystemArgLower = subsystemArg.toLowerCase();

      const matched = subsystems.find(s => {
        if ((s.id || "").toLowerCase() === subsystemArgLower) return true;
        if ((s.name || "").toLowerCase() === subsystemArgLower) return true;
        if (Array.isArray(s.filePatterns) && s.filePatterns.some(p => subsystemArgLower.includes(p.toLowerCase()) || p.toLowerCase().includes(subsystemArgLower))) return true;
        return false;
      });

      if (!matched) {
        const available = subsystems.map(s => `  • ${s.id} — ${s.name}`).join("\n");
        return text(`No subsystem matched "${subsystemArg}".\n\nAvailable subsystems:\n${available}`);
      }

      const out = [];
      out.push(`Architecture Brief: ${matched.name}\n`);

      if (matched.patternInEffect) {
        out.push("Pattern in effect:");
        out.push(`  ${matched.patternInEffect}`);
        out.push("");
      }

      const locked = Array.isArray(matched.lockedDecisions) ? matched.lockedDecisions : [];
      out.push(`Locked decisions (${locked.length} — not open for reconsideration):`);
      for (const d of locked) {
        out.push(`  • ${d.decision}`);
        if (d.rationale) out.push(`    Rationale: ${d.rationale}`);
        if (d.date) out.push(`    Date: ${d.date}`);
      }
      out.push("");

      const tensions = Array.isArray(matched.tensionsResolved) ? matched.tensionsResolved : [];
      if (tensions.length > 0) {
        out.push("Tensions resolved:");
        for (const t of tensions) {
          out.push(`  • ${t.tension}`);
          if (t.resolution) out.push(`    → ${t.resolution}`);
        }
        out.push("");
      }

      const scopeFiles = Array.isArray(matched.scopeFiles) ? matched.scopeFiles : [];
      if (scopeFiles.length > 0) {
        out.push("Scope files:");
        for (const f of scopeFiles) out.push(`  ${f}`);
        out.push("");
      }

      const gotchas = Array.isArray(matched.gotchas) ? matched.gotchas : [];
      if (gotchas.length > 0) {
        out.push("Gotchas:");
        for (const g of gotchas) out.push(`  ⚠ ${g}`);
      }

      return text(out.join("\n"));
    }

    case "pane_record_architecture_decision": {
      const projectId = args?.projectId || PROJECT_ID;
      const subsystemArg = (args?.subsystem || "").trim();
      const decision = (args?.decision || "").trim();
      const rationale = (args?.rationale || "").trim();
      if (!subsystemArg) return text("Subsystem is required.");
      if (!decision) return text("Decision is required.");
      if (!rationale) return text("Rationale is required.");

      const subsystemsPath = path.join(PANE_DIR, "memory", projectId, "subsystems.json");
      let data = await readJson(subsystemsPath);
      if (!data) {
        data = { version: 1, projectId, subsystems: [] };
      }
      if (!Array.isArray(data.subsystems)) data.subsystems = [];

      const subsystemArgLower = subsystemArg.toLowerCase();
      let matched = data.subsystems.find(s =>
        (s.id || "").toLowerCase() === subsystemArgLower || (s.name || "").toLowerCase() === subsystemArgLower
      );

      if (!matched) {
        matched = {
          id: subsystemArg.toLowerCase().replace(/\s+/g, "-"),
          name: subsystemArg,
          filePatterns: [],
          patternInEffect: "",
          lockedDecisions: [],
          tensionsResolved: [],
          scopeFiles: [],
          gotchas: [],
        };
        data.subsystems.push(matched);
      }

      if (!Array.isArray(matched.lockedDecisions)) matched.lockedDecisions = [];
      matched.lockedDecisions.push({
        decision,
        rationale,
        date: new Date().toISOString().split("T")[0],
      });

      await writeJson(subsystemsPath, data);
      return text(`Recorded architectural decision for "${matched.name}": "${decision}"`);
    }

    case "pane_roadmap": {
      const action = args?.action;
      const pid = PROJECT_ID;

      if (action === "read") {
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found. Start a kickoff conversation and call pane_roadmap(action: 'create') when ready.");
        return text(JSON.stringify(r, null, 2));
      }

      if (action === "set_kickoff_field") {
        const { field, value } = args || {};
        if (!field || value === undefined || value === null) {
          return text("set_kickoff_field requires 'field' and 'value'.");
        }
        if (!ALL_KICKOFF_FIELD_NAMES.has(field)) {
          return text(`Unknown field "${field}". Valid: ${[...ALL_KICKOFF_FIELD_NAMES].join(", ")}`);
        }
        const def = KICKOFF_FIELDS[field];
        if (def?.validator && !def.validator(value)) {
          return text(`Invalid value for "${field}" — ${def.label}`);
        }
        setKickoffFieldValue(pid, field, value);
        const missing = getMissingKickoffFields(pid);
        if (missing.length === 0) {
          return text(`Field "${field}" saved. All 7 required fields gathered — call pane_roadmap(action: 'create') now.`);
        }
        const missingLabels = missing.map(f => KICKOFF_FIELDS[f]?.label || f);
        return text(`Field "${field}" saved. Still needed (${missing.length}): ${missingLabels.join(", ")}`);
      }

      if (action === "create") {
        // Validate kickoff completeness when in kickoff phase
        const phase = getPhase(pid);
        if (phase === "kickoff") {
          const missing = getMissingKickoffFields(pid);
          if (missing.length > 0) {
            const labels = missing.map(f => KICKOFF_FIELDS[f]?.label || f);
            return text(`Cannot create roadmap yet — missing: ${labels.join(", ")}. Use set_kickoff_field to save each.`);
          }
        }
        const discovery = getKickoffCtx(pid);
        const milestones = (args?.milestones || []).map((m, i) => ({
          id: makeId(),
          title: m.title,
          description: m.description || "",
          status: i === 0 ? "active" : "upcoming",
          order: i,
          steps: [],
          verification: { status: "pending", checks: [], completedAt: null },
          startedAt: i === 0 ? Date.now() : null,
          completedAt: null,
        }));
        const roadmap = {
          projectId: pid,
          name: args?.name || discovery.projectName || "Untitled Project",
          purpose: args?.purpose || discovery.corePurpose || "",
          stack: args?.stack || {},
          discovery,
          milestones,
          decisions: [],
          sessionLog: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        writeRoadmap(pid, roadmap);
        if (phase === "kickoff" || phase === "idle") {
          transitionPhase(pid, "planning", "roadmap created");
        }
        return text(`Roadmap created with ${milestones.length} milestones. You are now in PLANNING phase — research the codebase, break the first milestone into steps, then call populate_steps.`);
      }

      if (action === "populate_steps") {
        const active = getActiveMilestone(pid);
        if (!active) return text("No active milestone to add steps to.");
        const steps = (args?.steps || []).map(s => ({
          id: makeId(), title: s.title, status: "pending", notes: s.detail || null,
        }));
        if (!steps.some(s => s.title.toLowerCase().includes("verify"))) {
          steps.push({ id: makeId(), title: "Verify everything works end to end", status: "pending", notes: null });
        }
        updateMilestone(pid, active.id, { steps });
        const phase = getPhase(pid);
        if (phase === "planning") transitionPhase(pid, "execution", "steps populated");
        return text(`${steps.length} steps added to "${active.title}". You are now in EXECUTION phase — work through each step in order.`);
      }

      if (action === "update_step") {
        const { milestone_id, step_id, step_status } = args || {};
        if (!milestone_id || !step_id || !step_status) {
          return text("update_step requires milestone_id, step_id, and step_status.");
        }
        updateStepInMilestone(pid, milestone_id, step_id, { status: step_status });
        // Auto-transition to verification when all non-verification steps are done
        const r = readRoadmap(pid);
        const am = r?.milestones?.find(m => m.status === "active");
        if (am?.steps && getPhase(pid) === "execution") {
          const nonVerify = am.steps.filter(s => !s.title.toLowerCase().includes("verify"));
          if (nonVerify.length > 0 && nonVerify.every(s => s.status === "done")) {
            transitionPhase(pid, "verification", "all implementation steps done");
            return text(`Step updated. All implementation steps done — you are now in VERIFICATION phase. Run tsc, lint, build, then call update_verification.`);
          }
        }
        return text(`Step updated to "${step_status}".`);
      }

      if (action === "add_decision") {
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found.");
        r.decisions = r.decisions || [];
        r.decisions.push({
          id: makeId(), question: args?.question || "", answer: args?.answer || "",
          milestoneId: args?.milestone_id || null, madeAt: Date.now(),
        });
        r.updatedAt = Date.now();
        writeRoadmap(pid, r);
        return text("Decision logged.");
      }

      if (action === "update_verification") {
        const active = getActiveMilestone(pid);
        if (!active) return text("No active milestone.");
        updateMilestone(pid, active.id, {
          verification: {
            status: args?.verification_passed ? "passed" : "failed",
            checks: args?.checks || [],
            completedAt: Date.now(),
          },
        });
        if (args?.verification_passed && getPhase(pid) === "verification") {
          transitionPhase(pid, "reflection", "verification passed");
          return text("Verification passed. You are now in REFLECTION phase — summarize, log_session, then complete_milestone.");
        }
        return text("Verification failed. Fix issues and re-run.");
      }

      if (action === "complete_milestone") {
        const active = getActiveMilestone(pid);
        if (!active) return text("No active milestone.");
        updateMilestone(pid, active.id, { status: "done", completedAt: Date.now() });
        const next = advanceToNextMilestone(pid);
        if (getPhase(pid) === "reflection") {
          transitionPhase(pid, next ? "planning" : "idle", next ? "next milestone" : "project complete");
        }
        return text(next
          ? `Milestone "${active.title}" complete. Next: "${next.title}" — you are now in PLANNING phase.`
          : `Milestone "${active.title}" complete. All milestones done — project complete!`);
      }

      if (action === "log_session") {
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found.");
        const active = r.milestones.find(m => m.status === "active");
        r.sessionLog = r.sessionLog || [];
        r.sessionLog.push({
          id: makeId(), startedAt: Date.now() - 3600000, endedAt: Date.now(),
          milestoneId: active?.id || null,
          stepsCompleted: args?.steps_completed || 0,
          notes: args?.notes || "",
        });
        r.updatedAt = Date.now();
        writeRoadmap(pid, r);
        return text("Session logged.");
      }

      if (action === "skip_milestone") {
        if (!args?.milestone_id) return text("skip_milestone requires milestone_id.");
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found.");
        const i = r.milestones.findIndex(m => m.id === args.milestone_id);
        if (i === -1) return text("Milestone not found.");
        r.milestones[i] = { ...r.milestones[i], status: "done", completedAt: Date.now(), skipped: true, skipReason: args?.reason || "" };
        // Activate next upcoming milestone
        const upcoming = r.milestones.filter(m => m.status === "upcoming").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (upcoming.length > 0) {
          const ni = r.milestones.findIndex(m => m.id === upcoming[0].id);
          r.milestones[ni].status = "active"; r.milestones[ni].startedAt = Date.now();
        }
        r.updatedAt = Date.now();
        writeRoadmap(pid, r);
        const nextActive = r.milestones.find(m => m.status === "active");
        transitionPhase(pid, nextActive ? "planning" : "idle", "milestone skipped");
        return text(`Milestone skipped. ${args?.reason || ""}`.trim());
      }

      if (action === "add_milestone") {
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found. Create one first with pane_roadmap(action: 'create').");
        const m = {
          id: makeId(), title: args?.title || "Untitled Milestone",
          description: args?.description || "", status: "upcoming",
          order: args?.order ?? r.milestones.length,
          steps: [], verification: { status: "pending", checks: [], completedAt: null },
          startedAt: null, completedAt: null,
        };
        r.milestones.push(m);
        r.milestones.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        r.milestones.forEach((m, i) => { m.order = i; });
        r.updatedAt = Date.now();
        writeRoadmap(pid, r);
        return text(`Milestone "${m.title}" added.`);
      }

      if (action === "reorder_milestones") {
        if (!Array.isArray(args?.ordered_ids)) return text("reorder_milestones requires ordered_ids array.");
        const r = readRoadmap(pid);
        if (!r) return text("No roadmap found.");
        const fixed    = r.milestones.filter(m => m.status !== "upcoming");
        const moveable = r.milestones.filter(m => m.status === "upcoming");
        const reordered = args.ordered_ids.map(id => moveable.find(m => m.id === id)).filter(Boolean);
        moveable.filter(m => !reordered.includes(m)).forEach(m => reordered.push(m));
        r.milestones = [...fixed, ...reordered];
        r.milestones.forEach((m, i) => { m.order = i; });
        r.updatedAt = Date.now();
        writeRoadmap(pid, r);
        return text("Milestones reordered.");
      }

      return text(`Unknown pane_roadmap action: ${action}`);
    }

    case "explore": {
      const { explore } = await import("./tool-explore.mjs");
      const result = await explore(
        args?.query || "",
        args?.projectId || PROJECT_ID,
        PROJECT_ROOT,
        { brainRequest: null }, // MCP server reads brain exports from disk, no IPC
      );
      return text(result || "No relevant results found for this query.");
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function timeSince(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// --- JSON-RPC dispatcher ---

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }

  // Notifications have no id — no response needed
  if (req.id === undefined || req.id === null) return;

  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pane", version: "1.0.0" },
      });
      break;

    case "ping":
      respond(req.id, {});
      break;

    case "tools/list": {
      const visibleTools = process.env.PANE_NO_EXEC === "1"
        ? TOOLS.filter((t) => t.name !== "pane_run_in_terminal")
        : TOOLS;
      respond(req.id, { tools: visibleTools });
      break;
    }

    case "tools/call":
      try {
        const result = await handleToolCall(req.params?.name, req.params?.arguments);
        respond(req.id, result);
      } catch (err) {
        respond(req.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;

    default:
      respondError(req.id, -32601, `Method not found: ${req.method}`);
  }
});

// Keep process alive
process.stdin.resume();
