// Pane MCP Server — standalone stdio MCP server for Pane IDE.
// Spawned by Claude CLI via --mcp-config, NOT by Electron.
// Reads project state and memory from ~/.pane/ filesystem.
// Convention over coupling: no direct IPC with Pane main process.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const PANE_DIR = process.env.PANE_DATA_DIR || path.join(os.homedir(), ".pane");
const PROJECT_ID = process.env.PANE_PROJECT_ID || "";
const PROJECT_ROOT = process.env.PANE_PROJECT_ROOT || "";

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
    description: "Get project name, root path, git branch, and top-level file list. Use this to orient yourself in the project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_open_files",
    description: "Get the file currently open in Pane's editor, including its full content and recent file history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_recent_terminal",
    description: "Get recent terminal commands and their outputs from Pane's terminal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_recall",
    description: "Search project memory for past decisions, lessons, patterns, errors, and file edits from previous sessions. Uses fuzzy multi-word matching — 'auth bug' will match 'authentication error'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms to filter memories. Leave empty for recent history." },
      },
    },
  },
  {
    name: "pane_recall_all",
    description: "Search memory across ALL projects — find patterns, decisions, and lessons from other projects that may be relevant here.",
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
    description: "Save something to project memory for future sessions — a decision, lesson, pattern, or important observation.",
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
    description: "Read the project's accumulated memory brief — decisions, lessons, frequently modified files, and last session summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_checkpoints",
    description: "List available file checkpoints for this project. Each checkpoint is a snapshot of file state before a Claude edit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_knowledge_graph",
    description: "View the project's knowledge graph — nodes (decisions, patterns, lessons, errors) and their connections, including cross-project pattern links. Shows the accumulated intelligence Pane has built from observing your work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_cross_project",
    description: "Find patterns, decisions, and lessons from OTHER projects that are relevant to the current work. Useful when solving a problem that another project may have already solved.",
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
    description: "View the user's profile — learned preferences, explicit rules, design philosophy, and known anti-patterns. Pane builds this automatically by observing your work patterns. Use this to understand the user's coding style and preferences.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_set_rule",
    description: "Add an explicit rule to the user's profile. Rules override observed preferences. Use when the user says things like 'always use X', 'never do Y', or states a firm preference.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The rule to add, e.g. 'always use bun instead of npm' or 'never auto-commit'" },
      },
      required: ["rule"],
    },
  },
  {
    name: "pane_set_philosophy",
    description: "Update the user's design philosophy. Use when the user describes their design principles or aesthetic preferences that should apply across all projects.",
    inputSchema: {
      type: "object",
      properties: {
        philosophy: { type: "string", description: "The full design philosophy text (replaces existing)" },
      },
      required: ["philosophy"],
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
      return text(out);
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
      const brief = await readText(path.join(memoryDir, "brief.md"));
      if (!brief) return text("No project brief yet — memory will accumulate as you work.");
      return text(brief);
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

    case "tools/list":
      respond(req.id, { tools: TOOLS });
      break;

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
