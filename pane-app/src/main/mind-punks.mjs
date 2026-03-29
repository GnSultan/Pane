/**
 * Pane Mind Punks — background intelligence that acts on thoughts.
 *
 * Three punks, three jobs:
 *   Bug punk      — reactive: a mind entry describes a bug → investigate, surface findings
 *   Reflection    — reactive: a mind entry is an idea → find connections, check against why/principles
 *   Sentinel      — always-on: periodic scan for drift from project purpose and principles
 *
 * All punks use quickCall (lightest model, any backend) and write results
 * as mind thread turns so the user sees them in Mind.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PANE_DIR = path.join(os.homedir(), ".pane");

const PUNK_PERSONAS = {
  bug:        { name: "maya", role: "debugger",             contributor: "bug" },
  reflection: { name: "noor", role: "constructive thinker", contributor: "reflection" },
  sentinel:   { name: "zara", role: "the auditor",          contributor: "sentinel" },
};

export class MindPunks {
  constructor({ brainRequest, quickCall, agentCall, sendToRenderer }) {
    this._brainRequest = brainRequest;
    this._quickCall = quickCall;
    this._agentCall = agentCall; // full agentic spawn — can read files, run terminal, use MCP tools
    this._sendToRenderer = sendToRenderer;
    this._lastSentinelRun = 0;
    this._sentinelInterval = null;
    this._processing = new Set(); // entry IDs currently being processed

    // Proactive activity: cooldowns and intervals
    // Key: "projectId:punkType", value: timestamp of last proactive run
    this._proactiveCooldowns = new Map();
    this._bugPunkInterval = null;
    this._reflectionPunkInterval = null;
    this._proactiveTimers = new Set(); // pending activation-trigger timeouts

    // Global concurrency cap: at most 1 proactive agentCall running at a time.
    // Without this, opening 9 projects schedules 18 concurrent Claude processes
    // (Maya + Noor × 9) each using 3-5GB → OOM in minutes.
    this._activeAgentCalls = 0;
    this._MAX_CONCURRENT_AGENTS = 1;
  }

  // ── Agent concurrency guard ────────────────────────────────────────────────

  async _runAgent(systemPrompt, prompt, workingDir) {
    if (this._activeAgentCalls >= this._MAX_CONCURRENT_AGENTS) {
      console.log(`[punks] agentCall skipped — ${this._activeAgentCalls} already running (cap=${this._MAX_CONCURRENT_AGENTS})`);
      return null;
    }
    this._activeAgentCalls++;
    try {
      return await this._agentCall(systemPrompt, prompt, workingDir);
    } finally {
      this._activeAgentCalls--;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    // Sentinel: run every 30 minutes
    this._sentinelInterval = setInterval(() => {
      this._runSentinelSafe().catch(() => {});
    }, 30 * 60 * 1000);

    // Maya (bug punk): proactive sweep every 8 hours
    this._bugPunkInterval = setInterval(() => {
      this._proactiveSweep("bug").catch(() => {});
    }, 8 * 60 * 60 * 1000);

    // Noor (reflection punk): proactive sweep every 8 hours, offset by 4h so they don't fire together
    const reflectionOffset = setTimeout(() => {
      this._reflectionPunkInterval = setInterval(() => {
        this._proactiveSweep("reflection").catch(() => {});
      }, 8 * 60 * 60 * 1000);
    }, 4 * 60 * 60 * 1000);
    this._proactiveTimers.add(reflectionOffset);

    console.log("[punks] Mind punks started");
  }

  stop() {
    if (this._sentinelInterval) {
      clearInterval(this._sentinelInterval);
      this._sentinelInterval = null;
    }
    if (this._bugPunkInterval) {
      clearInterval(this._bugPunkInterval);
      this._bugPunkInterval = null;
    }
    if (this._reflectionPunkInterval) {
      clearInterval(this._reflectionPunkInterval);
      this._reflectionPunkInterval = null;
    }
    for (const t of this._proactiveTimers) clearTimeout(t);
    this._proactiveTimers.clear();
  }

  // ── Triggers ───────────────────────────────────────────────────────────────

  /**
   * Called when a new mind entry is added. Classifies it and dispatches
   * to the appropriate punk. Fire-and-forget from the caller's perspective.
   */
  async onMindEntryAdded(entry, projectId) {
    if (!entry?.content || !entry?.id) return;
    if (entry.completed) return;
    if (this._processing.has(entry.id)) return;

    this._processing.add(entry.id);
    try {
      // Check if a punk thread already exists
      const existing = await this._brainRequest("mind_thread_get", { entry_id: entry.id });
      if (existing?.thread) return; // already has a thread — don't duplicate

      const classification = await this._classifyEntry(entry.content);
      console.log(`[punks] classified mind entry ${entry.id}: ${classification}`);

      if (classification === "bug") {
        await this._runBugPunk(entry, projectId);
      } else if (classification === "idea") {
        await this._runReflectionPunk(entry, projectId);
      }
      // "task" and "none" — skip
    } catch (err) {
      console.error("[punks] entry processing failed (non-fatal):", err.message);
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

  /**
   * Called when the user opens or switches to a project. Schedules proactive
   * punk activity — Maya digs into the codebase for bugs, Noor picks something
   * to reflect on. Both post their findings to Lens when done.
   * Respects a per-punk 6-hour cooldown so they don't spam on every switch.
   */
  onProjectActive(projectId, projectRoot = null) {
    if (!projectId) return;

    const ACTIVATION_COOLDOWN = 6 * 60 * 60 * 1000; // 6 hours

    // Schedule Maya (bug) — fires after 4 minutes
    if (this._isCooledDown(projectId, "bug", ACTIVATION_COOLDOWN)) {
      const t1 = setTimeout(() => {
        this._proactiveTimers.delete(t1);
        this._runProactiveBugPunk(projectId, projectRoot).catch(() => {});
      }, 4 * 60 * 1000);
      this._proactiveTimers.add(t1);
      console.log(`[punks] maya scheduled proactive run for ${projectId} in 4 min`);
    }

    // Schedule Noor (reflection) — fires after 9 minutes
    if (this._isCooledDown(projectId, "reflection", ACTIVATION_COOLDOWN)) {
      const t2 = setTimeout(() => {
        this._proactiveTimers.delete(t2);
        this._runProactiveReflectionPunk(projectId, projectRoot).catch(() => {});
      }, 9 * 60 * 1000);
      this._proactiveTimers.add(t2);
      console.log(`[punks] noor scheduled proactive run for ${projectId} in 9 min`);
    }
  }

  /**
   * Called when the user adds a post to Lens. Classifies and dispatches
   * to the relevant punk, who responds in the post's comment thread.
   */
  async onLensPostAdded(post, projectId) {
    if (!post?.content || !post?.id) return;
    if (post.contributor !== "user") return; // never react to punk posts
    if (this._processing.has(post.id)) return;

    this._processing.add(post.id);
    try {
      const classification = await this._classifyEntry(post.content);
      console.log(`[punks] lens post ${post.id} classified: ${classification}`);

      const entry = { id: post.id, content: post.content };
      if (classification === "bug") {
        await this._runBugPunk(entry, projectId, { source: "lens", replyToPostId: post.id });
      } else if (classification === "idea") {
        await this._runReflectionPunk(entry, projectId, { source: "lens", replyToPostId: post.id });
      }
      // task / none — skip
    } catch (err) {
      console.error("[punks] lens post reaction failed (non-fatal):", err.message);
    } finally {
      this._processing.delete(post.id);
    }
  }

  /**
   * Called when the user comments on a punk's Lens post. The owning punk
   * replies directly in the comment thread using a lightweight quickCall.
   */
  async onLensCommentAdded(comment, post, projectId) {
    if (!comment?.id || !post?.id) return;
    if (comment.role !== "user") return; // only react to user comments
    if (post.contributor === "user") return; // only reply on punk posts
    if (this._processing.has(comment.id)) return;

    const persona = PUNK_PERSONAS[post.contributor];
    if (!persona) return;

    this._processing.add(comment.id);
    try {
      // Parse the user's comment text
      let userText = "";
      try {
        const parsed = JSON.parse(comment.content);
        userText = (parsed.content || [])
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("") || comment.content;
      } catch {
        userText = comment.content;
      }

      const systemPrompt = `You are ${persona.name}, a ${persona.role} for this codebase. You posted the following observation to the project's shared feed:\n\n"${post.content}"\n\nThe developer is now replying to your post. Respond directly and concisely in character — stay grounded in the codebase context. Be a thoughtful collaborator, not a generic AI assistant. No emojis.`;

      const reply = await this._quickCall(systemPrompt, userText);
      if (!reply || !reply.trim()) return;

      const replyMsg = {
        id: `lc-punk-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        type: "assistant",
        content: [{ type: "text", text: reply.trim() }],
        timestamp: Date.now(),
        isStreaming: false,
      };

      const saved = await this._brainRequest("lens_comment_add", {
        postId: post.id,
        role: "assistant",
        content: JSON.stringify(replyMsg),
      });

      if (saved?.comment) {
        this._sendToRenderer("pane://lens-comment", { postId: post.id, comment: saved.comment });
      }
    } catch (err) {
      console.error("[punks] lens comment reply failed (non-fatal):", err.message);
    } finally {
      this._processing.delete(comment.id);
    }
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

  // ── Bug Punk ───────────────────────────────────────────────────────────────

  async _runBugPunk(entry, projectId, { source = "mind", replyToPostId = null } = {}) {
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

Format your response as: [file:line] — [what's wrong and what it could cause]. Keep it under 50 words. No speculation. No emojis.`;

    const result = await this._runAgent(systemPrompt, `Investigate this bug:\n\n${entry.content}`, workingDir);
    if (result && result.trim()) {
      if (source === "mind") await this._writePunkThread(entry.id, result.trim(), "bug");
      if (replyToPostId) {
        await this._writeLensComment(replyToPostId, result.trim());
      } else {
        await this._writeLensPost("bug", result.trim(), projectId, entry.id);
      }
    }
  }

  // ── Reflection Punk ────────────────────────────────────────────────────────

  async _runReflectionPunk(entry, projectId, { source = "mind", replyToPostId = null } = {}) {
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

Format your response as: [area/pattern] — [one-line observation tied to project intent]. Keep it under 50 words. No speculation. No emojis.`;

    const result = await this._runAgent(systemPrompt, `Reflect on this idea:\n\n${entry.content}`, workingDir);
    if (result && result.trim()) {
      if (source === "mind") await this._writePunkThread(entry.id, result.trim(), "reflection");
      if (replyToPostId) {
        await this._writeLensComment(replyToPostId, result.trim());
      } else {
        await this._writeLensPost("reflection", result.trim(), projectId, entry.id);
      }
    }
  }

  // ── Sentinel ───────────────────────────────────────────────────────────────

  async _runSentinelSafe() {
    const now = Date.now();
    if (now - this._lastSentinelRun < 30 * 60 * 1000) return;
    this._lastSentinelRun = now;

    try {
      await this._runSentinel();
    } catch (err) {
      console.error("[punks] sentinel failed (non-fatal):", err.message);
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
Otherwise, format each finding as [area]: [one sentence]. Keep it under 50 words. No emojis.`;

      const result = await this._quickCall(systemPrompt, "Run health check.");
      scanned++;

      if (!result) continue;
      const trimmed = result.trim().toLowerCase();
      if (trimmed === "healthy" || trimmed === '"healthy"') {
        console.log(`[punks] sentinel: ${projectId} is healthy`);
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
          await this._writeLensPost("sentinel", clean, projectId, null);
        } catch {}
      }

      if (findings.length > 0) {
        this._sendToRenderer("pane://punk-finding", {
          punkType: "sentinel",
          projectId,
          count: findings.length,
          preview: findings[0].slice(0, 100),
        });
        console.log(`[punks] sentinel: ${projectId} — ${findings.length} finding(s)`);
      }
    }
  }

  // ── Proactive Activity ─────────────────────────────────────────────────────

  _isCooledDown(projectId, punkType, cooldownMs) {
    const key = `${projectId}:${punkType}`;
    const last = this._proactiveCooldowns.get(key) ?? 0;
    return Date.now() - last >= cooldownMs;
  }

  _markProactiveRun(projectId, punkType) {
    this._proactiveCooldowns.set(`${projectId}:${punkType}`, Date.now());
  }

  /**
   * Periodic sweep: iterates explored projects and runs a proactive punk
   * for each one (max 2 per sweep). Called by the interval timers.
   */
  async _proactiveSweep(punkType) {
    const memoryDir = path.join(PANE_DIR, "memory");
    let projectDirs = [];
    try { projectDirs = await fs.readdir(memoryDir); } catch { return; }

    let processed = 0;
    for (const projectId of projectDirs) {
      if (processed >= 2) break;
      if (!this._isCooledDown(projectId, punkType, 8 * 60 * 60 * 1000)) continue;

      // Only process projects that have been explored (have why.md)
      try { await fs.access(path.join(memoryDir, projectId, "why.md")); } catch { continue; }

      try {
        if (punkType === "bug") {
          await this._runProactiveBugPunk(projectId, null);
        } else {
          await this._runProactiveReflectionPunk(projectId, null);
        }
        processed++;
      } catch (err) {
        console.error(`[punks] proactive sweep failed for ${projectId}:`, err.message);
      }
    }
  }

  /**
   * Maya independently picks a flow or component to investigate,
   * digs into it using agent tools, and posts her finding to Lens.
   */
  async _runProactiveBugPunk(projectId, workingDir = null) {
    if (!this._isCooledDown(projectId, "bug", 6 * 60 * 60 * 1000)) return;
    this._markProactiveRun(projectId, "bug");

    const ctx = await this._loadProjectContext(projectId, "");
    const resolvedDir = workingDir || await this._resolveWorkingDir(projectId);

    const systemPrompt = `You are maya, a bug investigator for ${ctx.projectName || "this project"}. Today you're doing your own independent investigation — no one asked you to look at anything specific. You're choosing what to dig into yourself.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Recent context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Start by getting oriented — use pane_knowledge_graph, pane_recall, or pane_open_files to understand what's going on in this project right now. Then pick ONE specific thing — a flow, function, component, integration point, or code path — that looks worth a close look.

Investigate it thoroughly:
- Trace the actual code path end to end
- Read the relevant files
- Look for edge cases, missing error handling, race conditions, or brittle assumptions
- Run tests if they exist (pane_run_in_terminal)

Format your response as: [file:line] — [what's wrong and what it could cause]. Keep it under 50 words. No speculation. No emojis.`;

    console.log(`[punks] maya starting proactive investigation for ${projectId}`);
    const result = await this._runAgent(
      systemPrompt,
      "You're on the clock. Choose something to investigate and dig in.",
      resolvedDir
    );
    if (result && result.trim()) {
      await this._writeLensPost("bug", result.trim(), projectId, null);
      console.log(`[punks] maya posted proactive finding for ${projectId}`);
    }
  }

  /**
   * Noor independently picks a pattern or architectural decision to explore,
   * digs into it, and posts her reflection to Lens.
   */
  async _runProactiveReflectionPunk(projectId, workingDir = null) {
    if (!this._isCooledDown(projectId, "reflection", 6 * 60 * 60 * 1000)) return;
    this._markProactiveRun(projectId, "reflection");

    const ctx = await this._loadProjectContext(projectId, "");
    const resolvedDir = workingDir || await this._resolveWorkingDir(projectId);

    const systemPrompt = `You are noor, a constructive thinker for ${ctx.projectName || "this project"}. Today you're exploring on your own initiative — no prompt, no specific question. You're choosing what to think about.

${ctx.why ? `Project purpose: ${ctx.why}\n` : ""}${ctx.principles.length > 0 ? `Established principles:\n${ctx.principles.map(p => `- ${p}`).join("\n")}\n` : ""}${ctx.memories.length > 0 ? `Recent context:\n${ctx.memories.map(m => `- ${m}`).join("\n")}\n` : ""}
Start by getting oriented — use pane_knowledge_graph, pane_recall, or pane_open_files to understand the project's shape right now. Then pick ONE specific thing — an architectural decision, a pattern you notice, a tradeoff the code reveals, a constraint it's working around, a design choice that's doing more than it looks like — and dig into it.

Go to the actual code:
- Use pane_find_symbol and Read to understand how it really works
- Don't just describe — trace through what it does
- Connect what you find to the project's purpose or principles if it's relevant

Format your response as: [area/pattern] — [one-line observation tied to project intent]. Keep it under 50 words. No speculation. No emojis.`;

    console.log(`[punks] noor starting proactive reflection for ${projectId}`);
    const result = await this._runAgent(
      systemPrompt,
      "You're on the clock. Choose something interesting to explore and dig in.",
      resolvedDir
    );
    if (result && result.trim()) {
      await this._writeLensPost("reflection", result.trim(), projectId, null);
      console.log(`[punks] noor posted proactive reflection for ${projectId}`);
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

  async _writeLensComment(postId, content) {
    try {
      const replyMsg = {
        id: `lc-punk-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        type: "assistant",
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
        isStreaming: false,
      };
      const result = await this._brainRequest("lens_comment_add", {
        postId,
        role: "assistant",
        content: JSON.stringify(replyMsg),
      });
      if (result?.comment) {
        this._sendToRenderer("pane://lens-comment", { postId, comment: result.comment });
      }
      return result?.comment;
    } catch (err) {
      console.error("[mind-punks] _writeLensComment failed:", err.message);
    }
  }

  async _writeLensPost(contributor, content, projectId = null, entryId = null) {
    try {
      const result = await this._brainRequest("lens_post_add", { contributor, content, projectId, entryId });
      const lensPost = result?.post;
      if (lensPost) {
        this._sendToRenderer("pane://lens-post", lensPost);
      }
      return lensPost;
    } catch (err) {
      console.error("[mind-punks] _writeLensPost failed:", err.message);
    }
  }

  async _writePunkThread(entryId, content, punkType) {
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
      console.error("[punks] thread creation failed:", err.message);
      return;
    }

    if (!threadId) return;

    // Build the turn content matching the ConversationMessage shape
    const turnContent = {
      id: `punk-${crypto.randomUUID()}`,
      type: "assistant",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
      isStreaming: false,
      punkType,
    };

    try {
      await this._brainRequest("mind_thread_add_turn", {
        thread_id: threadId,
        role: "worker",
        content_json: JSON.stringify(turnContent),
      });
    } catch (err) {
      console.error("[punks] thread turn write failed:", err.message);
      return;
    }

    // Notify renderer
    this._sendToRenderer("pane://punk-finding", {
      entryId,
      punkType,
      preview: content.slice(0, 120),
    });
  }
}
