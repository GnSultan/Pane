// Pane MCP Server — standalone stdio MCP server for Pane IDE.
// Spawned by Claude CLI via --mcp-config, NOT by Electron.
// Reads project state and memory from ~/.pane/ filesystem.
// Convention over coupling: no direct IPC with Pane main process.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const execAsync = promisify(exec);

const PANE_DIR = process.env.PANE_DATA_DIR || path.join(os.homedir(), ".pane");
const PROJECT_ID = process.env.PANE_PROJECT_ID || "";
const PROJECT_ROOT = process.env.PANE_PROJECT_ROOT || "";
const DB_PATH = path.join(PANE_DIR, "pane.db");

// Database instance — opened lazily
let _db = null;
function getDb() {
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
  }).filter(s => s.score > 0.15).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "pane_project_context",
    description: "Get project name, root path, git branch, and top-level file list. Use when you need the physical layout or git state. For deeper orientation, prefer pane_synthesize or pane_brief first.",
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
    description: "Read the project's accumulated memory brief — top decisions, lessons, frequently modified files, and the last session summary. Good starting point when resuming work or when you need a quick read on project history without the full architecture narrative. For deeper causal understanding, use pane_synthesize.",
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
    description: "View the project's knowledge graph — how decisions, patterns, lessons, and errors connect to each other, including cross-project links. Use when you need to understand the relationships between architectural choices, or when pane_synthesize gives you the narrative but you want to see the structure. Complements pane_synthesize: synthesize for the story, graph for the connections.",
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
    name: "pane_set_why",
    description: "Set this project's foundational purpose — what it is, who it serves, what problem it solves, where it is headed. Call this once you have understood the project deeply enough to articulate it clearly. This grounds every future suggestion in the project's actual purpose. Per-project, not global.",
    inputSchema: {
      type: "object",
      properties: {
        why: { type: "string", description: "The project's foundational purpose — concise narrative covering what it is, who it's for, the problem it solves, and its direction" },
      },
      required: ["why"],
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
    name: "pane_synthesize",
    description: "Get the project's architectural DNA — a compact narrative of why things are the way they are: key decisions, established patterns, lessons learned, known anti-patterns. This is causal memory, not just facts. Use at the start of a session or whenever you need deep architectural context before making structural changes. Pair with pane_knowledge_graph when you want the connections, not just the narrative.",
    inputSchema: { type: "object", properties: {} },
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
];

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
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          env: getEnvWithPath(),
          timeout: timeoutSecs * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        output = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
      } catch (err) {
        exitCode = err.code ?? 1;
        const partial = [err.stdout, err.stderr].filter(Boolean).join("\n").trimEnd();
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
      const why = await readText(path.join(memoryDir, "why.md"));
      if (why) {
        parts.push("## Project Purpose");
        parts.push(why.trim());
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

      // Group by type
      const byType = {};
      for (const node of exported) {
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

      // Read profile export (combined view)
      try {
        const exported = await fs.promises.readFile(path.join(profileDir, "profile-export.md"), "utf-8");
        if (exported.trim().length > 10) {
          parts.push(exported.trim());
        }
      } catch {}

      // Also show raw stats
      try {
        const prefs = JSON.parse(await fs.promises.readFile(path.join(profileDir, "preferences.json"), "utf-8"));
        const toolCount = Object.keys(prefs.tools || {}).length;
        const codingCount = Object.keys(prefs.coding || {}).length;
        parts.push(`\n---\nProfile stats: ${toolCount} tool preferences, ${codingCount} coding patterns observed`);
        if (prefs._meta?.lastUpdated) {
          parts.push(`Last updated: ${prefs._meta.lastUpdated}`);
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

    case "pane_set_why": {
      const why = (args?.why || "").trim();
      if (!why) return text("Why text is required.");

      const whyDir = path.join(PANE_DIR, "memory", PROJECT_ID);
      await fs.promises.mkdir(whyDir, { recursive: true });
      await fs.promises.writeFile(path.join(whyDir, "why.md"), why);

      return text("Project purpose recorded. Every future session on this project will carry this context.");
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

    case "pane_synthesize": {
      // Read synthesis from contextual export (written by brain-engine)
      const contextPath = path.join(PANE_DIR, "brain", "context", `${PROJECT_ID}.json`);
      const ctx = await readJson(contextPath);

      if (ctx?.synthesis) {
        return text(`## Project DNA\n\n${ctx.synthesis}`);
      }

      // Fallback: check if brain export has enough nodes to build one
      const exported = await readBrainExport(PROJECT_ID);
      if (!exported || exported.length === 0) {
        return text("Project DNA not available yet — it builds as decisions and lessons accumulate through your work.");
      }

      const decisions = exported.filter(n => n.type === "decision" && n.confidence >= 0.70).slice(0, 12);
      const patterns  = exported.filter(n => n.type === "pattern"  && n.confidence >= 0.70).slice(0, 8);
      const lessons   = exported.filter(n => n.type === "lesson"   && n.confidence >= 0.72).slice(0, 8);
      const fixes     = exported.filter(n => n.type === "error_fix"&& n.confidence >= 0.70).slice(0, 6);

      if (decisions.length + patterns.length + lessons.length + fixes.length === 0) {
        return text("Project DNA not available yet — memory confidence is still building.");
      }

      const parts = ["## Project DNA\n"];
      if (decisions.length > 0) {
        parts.push("Architectural decisions:");
        for (const d of decisions) parts.push(`- ${d.content}`);
      }
      if (patterns.length > 0) {
        parts.push("\nEstablished patterns:");
        for (const p of patterns) parts.push(`- ${p.content}`);
      }
      if (lessons.length > 0) {
        parts.push("\nLessons learned:");
        for (const l of lessons) parts.push(`- ${l.content}`);
      }
      if (fixes.length > 0) {
        parts.push("\nKnown anti-patterns:");
        for (const f of fixes) parts.push(`- ${f.content}`);
      }

      return text(parts.join("\n"));
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
