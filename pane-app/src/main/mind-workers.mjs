/**
 * Pane Mind Workers — background intelligence that acts on thoughts.
 *
 * Three workers, three jobs:
 *   Bug worker     — reactive: a mind entry describes a bug → investigate, surface findings
 *   Reflection     — reactive: a mind entry is an idea → find connections, check against why/principles
 *   Sentinel       — always-on: periodic scan for drift from project purpose and principles
 *
 * All workers use quickCall (lightest model, any backend) and write results
 * as mind thread turns so the user sees them in Mind.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PANE_DIR = path.join(os.homedir(), ".pane");

export class MindWorkers {
  constructor({ brainRequest, quickCall, agentCall, sendToRenderer }) {
    this._brainRequest = brainRequest;
    this._quickCall = quickCall;
    this._agentCall = agentCall; // full agentic spawn — can read files, run terminal, use MCP tools
    this._sendToRenderer = sendToRenderer;
    this._lastSentinelRun = 0;
    this._sentinelInterval = null;
    this._processing = new Set(); // entry IDs currently being processed
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    // Sentinel: run every 30 minutes
    this._sentinelInterval = setInterval(() => {
      this._runSentinelSafe().catch(() => {});
    }, 30 * 60 * 1000);

    console.log("[workers] Mind workers started");
  }

  stop() {
    if (this._sentinelInterval) {
      clearInterval(this._sentinelInterval);
      this._sentinelInterval = null;
    }
  }

  // ── Triggers ───────────────────────────────────────────────────────────────

  /**
   * Called when a new mind entry is added. Classifies it and dispatches
   * to the appropriate worker. Fire-and-forget from the caller's perspective.
   */
  async onMindEntryAdded(entry, projectId) {
    if (!entry?.content || !entry?.id) return;
    if (entry.completed) return;
    if (this._processing.has(entry.id)) return;

    this._processing.add(entry.id);
    try {
      // Check if a worker thread already exists
      const existing = await this._brainRequest("mind_thread_get", { entry_id: entry.id });
      if (existing?.thread) return; // already has a thread — don't duplicate

      const classification = await this._classifyEntry(entry.content);
      console.log(`[workers] classified mind entry ${entry.id}: ${classification}`);

      if (classification === "bug") {
        await this._runBugWorker(entry, projectId);
      } else if (classification === "idea") {
        await this._runReflectionWorker(entry, projectId);
      }
      // "task" and "none" — skip
    } catch (err) {
      console.error("[workers] entry processing failed (non-fatal):", err.message);
    } finally {
      this._processing.delete(entry.id);
    }
  }

  /**
   * Called when file changes settle. Triggers sentinel if enough time has passed.
   */
  onFilesChanged(paths) {
    const now = Date.now();
    // Only run sentinel if 30+ minutes since last run
    if (now - this._lastSentinelRun < 30 * 60 * 1000) return;
    // Debounce: wait 10s after file changes settle before scanning
    setTimeout(() => {
      this._runSentinelSafe().catch(() => {});
    }, 10000);
  }

  // ── Classification ─────────────────────────────────────────────────────────

  async _classifyEntry(content) {
    const systemPrompt = `Classify this mind entry into exactly one category. Respond with a single word only.

Categories:
- bug: describes a crash, error, broken behavior, visual glitch, unexpected output
- idea: observation, design thought, architectural question, improvement idea, exploration
- task: a concrete to-do item or action ("deploy X", "update Y", "add Z")
- none: too vague, a note, or not actionable

Respond with one word: bug, idea, task, or none.`;

    try {
      const result = await this._quickCall(systemPrompt, content);
      const word = (result || "").trim().toLowerCase().replace(/[^a-z]/g, "");
      if (["bug", "idea", "task", "none"].includes(word)) return word;
      return "none";
    } catch {
      return "none";
    }
  }

  // ── Bug Worker ─────────────────────────────────────────────────────────────

  async _runBugWorker(entry, projectId) {
    const ctx = await this._loadProjectContext(projectId, entry.content);
    const workingDir = await this._resolveWorkingDir(projectId);

    const systemPrompt = `You are a bug investigator for ${ctx.projectName || "this project"}. You have full access to the codebase, Pane's indexed knowledge, and terminal.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}${ctx.relevantFiles.length > 0 ? `Likely relevant files:\n${ctx.relevantFiles.map(f => `- ${f.path}${f.description ? ` — ${f.description}` : ""}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Related context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Use Pane's tools to investigate efficiently — prefer them over raw search:
- pane_find_symbol: locate functions, types, components by name without scanning
- pane_recall: surface past decisions, lessons, or patterns related to this bug
- pane_knowledge_graph: understand architectural relationships and constraints
- Read: read specific files once you know where to look
- pane_run_in_terminal: run tests or build checks to confirm or deny the bug

Investigate thoroughly:
- Locate the relevant code using pane_find_symbol or pane_recall first
- Trace the actual code path
- Verify with terminal if tests exist

Deliver a concise finding:
1. Root cause (name files, functions, line ranges)
2. How to verify (specific test, command, or reproduction steps)
3. Suggested fix direction

No speculation. No emojis.`;

    const result = await this._agentCall(systemPrompt, `Investigate this bug:\n\n${entry.content}`, workingDir);
    if (result && result.trim()) {
      await this._writeWorkerThread(entry.id, result.trim(), "bug");
    }
  }

  // ── Reflection Worker ──────────────────────────────────────────────────────

  async _runReflectionWorker(entry, projectId) {
    const ctx = await this._loadProjectContext(projectId, entry.content);
    const workingDir = await this._resolveWorkingDir(projectId);

    const systemPrompt = `You are a codebase analyst reflecting on an idea for ${ctx.projectName || "this project"}. You have full access to the codebase, Pane's indexed knowledge, and terminal.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Related context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Use Pane's tools to explore efficiently — prefer them over raw search:
- pane_recall: search project memory for past decisions, lessons, or patterns related to this idea
- pane_knowledge_graph: understand architectural decisions and their rationale
- pane_find_symbol: locate specific implementations relevant to this idea
- pane_cross_project: check if similar patterns exist in other projects
- Read: read specific files once you know where to look
- Glob/Grep: only for searches the above tools can't answer

Ground the reflection in what you actually find:
- Does the codebase already have something related? Where?
- Do prior decisions support or constrain this idea?
- What would the author not have seen without digging in?

Deliver a concise, evidence-based reflection. No speculation. No emojis.`;

    const result = await this._agentCall(systemPrompt, `Reflect on this idea:\n\n${entry.content}`, workingDir);
    if (result && result.trim()) {
      await this._writeWorkerThread(entry.id, result.trim(), "reflection");
    }
  }

  // ── Sentinel Worker ────────────────────────────────────────────────────────

  async _runSentinelSafe() {
    const now = Date.now();
    if (now - this._lastSentinelRun < 30 * 60 * 1000) return;
    this._lastSentinelRun = now;

    try {
      await this._runSentinel();
    } catch (err) {
      console.error("[workers] sentinel failed (non-fatal):", err.message);
    }
  }

  async _runSentinel() {
    // Find active projects — those with a why.md (we only scan projects that have been explored)
    const memoryDir = path.join(PANE_DIR, "memory");
    let projectDirs = [];
    try {
      projectDirs = await fs.readdir(memoryDir);
    } catch { return; }

    let scanned = 0;
    for (const projectId of projectDirs) {
      if (scanned >= 2) break; // max 2 projects per sentinel run

      let why = "";
      try {
        why = (await fs.readFile(path.join(memoryDir, projectId, "why.md"), "utf-8")).trim();
      } catch { continue; } // skip projects with no why — not yet explored

      const ctx = await this._loadProjectContext(projectId, "codebase health check");
      if (ctx.principles.length === 0 && ctx.memories.length === 0) continue; // nothing to check against

      const systemPrompt = `You are a codebase health sentinel for ${ctx.projectName || projectId}.

Project purpose: ${why}

${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Recent context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Scan for:
1. Drift from the project's stated purpose
2. Violations of established principles
3. Patterns growing in a concerning direction

If everything looks healthy, respond with exactly "healthy".
Otherwise, list specific findings (max 3), each as a single concise sentence. No emojis.`;

      const result = await this._quickCall(systemPrompt, "Run health check.");
      scanned++;

      if (!result) continue;
      const trimmed = result.trim().toLowerCase();
      if (trimmed === "healthy" || trimmed === '"healthy"') {
        console.log(`[workers] sentinel: ${projectId} is healthy`);
        continue;
      }

      // Findings detected — create mind entries for each
      const findings = result.trim().split("\n").filter(l => l.trim().length > 10).slice(0, 3);
      for (const finding of findings) {
        const clean = finding.replace(/^\d+\.\s*/, "").replace(/^[-•]\s*/, "").trim();
        if (clean.length < 10) continue;

        try {
          await this._brainRequest("mind_add", {
            content: `[sentinel] ${clean}`,
            projectId,
          });
        } catch {}
      }

      if (findings.length > 0) {
        this._sendToRenderer("pane://worker-finding", {
          workerType: "sentinel",
          projectId,
          count: findings.length,
          preview: findings[0].slice(0, 100),
        });
        console.log(`[workers] sentinel: ${projectId} — ${findings.length} finding(s)`);
      }
    }
  }

  // ── Shared Helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve the actual filesystem root for a projectId.
   * projectId is typically the folder name; we read the stored project root
   * from ~/.pane/memory/{projectId}/root.txt if it exists, otherwise fall back
   * to the home directory (agent can still navigate from there).
   */
  async _resolveWorkingDir(projectId) {
    if (!projectId) return os.homedir();
    try {
      const rootFile = path.join(PANE_DIR, "memory", projectId, "root.txt");
      const root = (await fs.readFile(rootFile, "utf-8")).trim();
      if (root) return root;
    } catch {}
    // Fallback: projectId may itself be an absolute path (some older setups)
    if (projectId.startsWith("/")) return projectId;
    return os.homedir();
  }

  async _loadProjectContext(projectId, query) {
    const result = {
      projectName: projectId || "unknown",
      why: "",
      principles: [],
      memories: [],
      relevantFiles: [],
    };

    if (!projectId) return result;

    // Read project why
    try {
      result.why = (await fs.readFile(path.join(PANE_DIR, "memory", projectId, "why.md"), "utf-8")).trim();
    } catch {}

    // Read principles from events.jsonl
    try {
      const eventsPath = path.join(PANE_DIR, "memory", projectId, "events.jsonl");
      const raw = await fs.readFile(eventsPath, "utf-8");
      result.principles = raw.split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(e => e?.type === "principle")
        .map(e => e.content);
    } catch {}

    // Brain contextual search for relevant memories and files
    try {
      const brainCtx = await this._brainRequest("contextual_search", {
        projectId,
        query: query || "",
        fileContext: null,
        intent: "other",
        projectRoot: null,
        taskType: null,
        atomHints: [],
        projectWhy: result.why,
      });

      if (brainCtx?.memories) {
        result.memories = brainCtx.memories
          .filter(m => (m.confidence || 0) >= 0.75)
          .slice(0, 5)
          .map(m => m.content);
      }
      if (brainCtx?.relevantFiles) {
        result.relevantFiles = brainCtx.relevantFiles.slice(0, 5);
      }
    } catch {}

    return result;
  }

  async _writeWorkerThread(entryId, content, workerType) {
    // Get or create thread
    let threadId;
    try {
      const existing = await this._brainRequest("mind_thread_get", { entry_id: entryId });
      if (existing?.thread) {
        threadId = existing.thread.id;
      } else {
        const created = await this._brainRequest("mind_thread_create", { entry_id: entryId });
        threadId = created?.thread?.id;
      }
    } catch (err) {
      console.error("[workers] thread creation failed:", err.message);
      return;
    }

    if (!threadId) return;

    // Build the turn content matching the ConversationMessage shape
    const turnContent = {
      id: `worker-${crypto.randomUUID()}`,
      type: "assistant",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
      isStreaming: false,
      workerType,
    };

    try {
      await this._brainRequest("mind_thread_add_turn", {
        thread_id: threadId,
        role: "worker",
        content_json: JSON.stringify(turnContent),
      });
    } catch (err) {
      console.error("[workers] thread turn write failed:", err.message);
      return;
    }

    // Notify renderer
    this._sendToRenderer("pane://worker-finding", {
      entryId,
      workerType,
      preview: content.slice(0, 120),
    });
  }
}
