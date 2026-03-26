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
  constructor({ brainRequest, quickCall, sendToRenderer }) {
    this._brainRequest = brainRequest;
    this._quickCall = quickCall;
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

    const systemPrompt = `You are investigating a bug report for ${ctx.projectName || "this project"}.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}
${ctx.relevantFiles.length > 0 ? `Relevant files:\n${ctx.relevantFiles.map(f => `- ${f.path}${f.description ? ` — ${f.description}` : ""}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Related context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Analyze this bug report. Provide:
1. What area of the codebase is likely affected
2. What the probable cause is based on the context
3. Suggested investigation steps

Be concise. No speculation beyond what the context supports. No emojis.`;

    const result = await this._quickCall(systemPrompt, entry.content);
    if (result && result.trim()) {
      await this._writeWorkerThread(entry.id, result.trim(), "bug");
    }
  }

  // ── Reflection Worker ──────────────────────────────────────────────────────

  async _runReflectionWorker(entry, projectId) {
    const ctx = await this._loadProjectContext(projectId, entry.content);

    const systemPrompt = `You are a thinking partner reflecting on an idea for ${ctx.projectName || "this project"}.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}
${ctx.memories.length > 0 ? `Related context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Consider this idea against the project's purpose and principles.
- Does it align with or challenge existing direction?
- What patterns or decisions relate to this idea?
- What implications might the author not have considered?

Be concise and direct. Surface non-obvious connections. No emojis.`;

    const result = await this._quickCall(systemPrompt, entry.content);
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
