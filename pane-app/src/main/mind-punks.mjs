/**
 * Pane Punks — on-demand specialized analysts.
 *
 * Each punk is a persona file in ~/.pane/punks/{name}.md — methodology,
 * principles, patterns, and structured output format. The roster is dynamic:
 * add a .md file, get a new punk. Remove it, lose one.
 *
 * Punks fire when the user deliberately triggers a review from Lens.
 * They run in parallel with full read-only codebase access, unconstrained.
 * They produce structured JSON findings stored in SQLite.
 *
 * This module evolved from the original timer-based punk system.
 * The utilities (brain wiring, lens posting, project context) stay.
 * The execution model (on-demand, persona-driven, parallel) is new.
 */

import fs from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
const PANE_DIR = path.join(os.homedir(), ".pane");
const PUNKS_DIR = path.join(PANE_DIR, "punks");

export class MindPunks {
  constructor({ brainRequest, quickCall, agentCall, sendToRenderer }) {
    this._brainRequest = brainRequest;
    this._quickCall = quickCall;
    this._agentCall = agentCall;
    this._sendToRenderer = sendToRenderer;
  }

  // ── Review System ──────────────────────────────────────────────────────────

  /**
   * Run an on-demand review. Discovers all punk personas, runs them in parallel
   * against the changes since the last review, collects structured findings.
   *
   * @param {string} projectId
   * @param {string} workingDir
   * @returns {Promise<{ sessionId: string, findings: Array }>}
   */
  async runReview(projectId, workingDir) {
    // 1. Discover available punks
    const punkNames = this._discoverPunks();
    if (punkNames.length === 0) {
      console.warn("[punks] No persona files found in", PUNKS_DIR);
      return { sessionId: null, findings: [] };
    }

    // 2. Get last review's base_ref for diff focus
    let lastBaseRef = null;
    try {
      const latest = await this._brainRequest("review_session_latest", { projectId });
      if (latest?.session?.base_ref) lastBaseRef = latest.session.base_ref;
    } catch {}

    // 3. Compute diff focus
    const diffFocus = await this._getDiffFocus(workingDir, lastBaseRef);

    // 4. Create review session
    let sessionId;
    try {
      const result = await this._brainRequest("review_session_create", {
        projectId,
        diffSummary: diffFocus.stat?.slice(0, 500) || null,
        baseRef: lastBaseRef,
        punkCount: punkNames.length,
      });
      sessionId = result?.session?.id;
    } catch (err) {
      console.error("[punks] Failed to create review session:", err.message);
      return { sessionId: null, findings: [] };
    }

    // 5. Notify renderer: review started
    this._sendToRenderer("pane://review-progress", {
      sessionId,
      projectId,
      status: "running",
      punks: Object.fromEntries(punkNames.map(n => [n, "pending"])),
    });

    // 6. Load personas and build prompts
    const punkTasks = [];
    for (const name of punkNames) {
      const persona = await this._loadPersona(name);
      if (!persona) continue;

      const userPrompt = this._buildUserPrompt(diffFocus, name);
      punkTasks.push({ name, persona, userPrompt });
    }

    // 7. Run all punks in parallel — unconstrained
    const allFindings = [];
    const results = await Promise.allSettled(
      punkTasks.map(async ({ name, persona, userPrompt }) => {
        // Notify: punk started
        this._sendToRenderer("pane://review-progress", {
          sessionId, projectId,
          punk: name, status: "running",
        });

        try {
          const rawOutput = await this._agentCall(persona, userPrompt, workingDir);
          const findings = this._parseFindings(rawOutput, name);

          // Notify: punk done
          this._sendToRenderer("pane://review-progress", {
            sessionId, projectId,
            punk: name, status: "done", findingCount: findings.length,
          });

          return { name, findings };
        } catch (err) {
          console.error(`[punks] ${name} failed:`, err.message);
          this._sendToRenderer("pane://review-progress", {
            sessionId, projectId,
            punk: name, status: "failed", error: err.message,
          });
          return { name, findings: [] };
        }
      }),
    );

    // 8. Collect and store findings
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { name, findings } = result.value;

      for (const f of findings) {
        try {
          const stored = await this._brainRequest("review_finding_add", {
            sessionId,
            projectId,
            punk: name,
            severity: f.severity,
            finding: f.finding,
            structured: JSON.stringify(f),
            location: f.location || null,
          });
          if (stored?.finding) allFindings.push(stored.finding);
        } catch {}
      }
    }

    // 9. Get current HEAD for next review's base_ref
    let currentHead = null;
    try {
      currentHead = execSync("git rev-parse HEAD 2>/dev/null", { cwd: workingDir, encoding: "utf-8", timeout: 5000 }).trim() || null;
    } catch {}

    // 10. Complete session
    try {
      await this._brainRequest("review_session_complete", {
        sessionId,
        status: "completed",
        baseRef: currentHead,
        findingCount: allFindings.length,
      });
    } catch {}

    // 11. Notify renderer: review complete
    this._sendToRenderer("pane://review-complete", {
      sessionId,
      projectId,
      findings: allFindings,
    });

    console.log(`[punks] Review complete: ${allFindings.length} findings from ${punkNames.length} punks`);
    return { sessionId, findings: allFindings };
  }

  // ── Single Punk Run ────────────────────────────────────────────────────────

  /**
   * Run a single punk on demand. Supports an optional scope prompt that lets
   * the user specify what to analyze. When scope is given, it replaces the
   * standard diff focus — the punk plans its own investigation.
   *
   * @param {string} punkName - e.g. "ash", "ghost", "sage"
   * @param {string} projectId
   * @param {string} workingDir
   * @param {string|null} scope - optional user-provided focus, e.g. "trace the payment flow"
   * @returns {Promise<{ findings: Array }>}
   */
  async runSinglePunk(punkName, projectId, workingDir, scope = null) {
    const persona = await this._loadPersona(punkName);
    if (!persona) {
      this._sendToRenderer("pane://punk-progress", {
        punk: punkName, status: "failed", error: "Persona not found",
      });
      return { findings: [] };
    }

    // Notify: punk started
    this._sendToRenderer("pane://punk-progress", {
      projectId, punk: punkName, status: "running",
    });

    let userPrompt;
    if (scope && scope.trim().length > 0) {
      // Scope-driven: the user said "trace the payment flow" or "check auth on the API"
      // The punk plans its own investigation — scope replaces diff context.
      userPrompt = scope.trim();
    } else {
      // Diff-driven: same as runReview but for a single punk
      let lastBaseRef = null;
      try {
        const latest = await this._brainRequest("review_session_latest", { projectId });
        if (latest?.session?.base_ref) lastBaseRef = latest.session.base_ref;
      } catch {}
      const diffFocus = await this._getDiffFocus(workingDir, lastBaseRef);
      userPrompt = this._buildUserPrompt(diffFocus, punkName);
    }

    try {
      const rawOutput = await this._agentCall(persona, userPrompt, workingDir);
      const findings = this._parseFindings(rawOutput, punkName);

      // Store findings directly (no review session — single punk runs are standalone)
      const storedFindings = [];
      for (const f of findings) {
        try {
          const result = await this._brainRequest("review_finding_add", {
            sessionId: null, // standalone — not part of a review session
            projectId,
            punk: punkName,
            severity: f.severity,
            finding: f.finding,
            structured: JSON.stringify(f),
            location: f.location || null,
          });
          if (result?.finding) storedFindings.push(result.finding);
        } catch {}
      }

      // Notify: punk complete
      this._sendToRenderer("pane://punk-complete", {
        punk: punkName,
        findings: storedFindings,
      });

      console.log(`[punks] ${punkName} complete: ${storedFindings.length} findings`);
      return { findings: storedFindings };
    } catch (err) {
      console.error(`[punks] ${punkName} failed:`, err.message);
      this._sendToRenderer("pane://punk-progress", {
        punk: punkName, status: "failed", error: err.message,
      });
      return { findings: [] };
    }
  }

  // ── Previous Finding Check ─────────────────────────────────────────────────

  /**
   * Re-check past findings for a specific punk. Loads undismissed findings,
   * feeds them to the punk with the current codebase state, and asks it to
   * determine if each is still present, resolved, or partially addressed.
   *
   * @param {string} punkName
   * @param {string} projectId
   * @param {string} workingDir
   * @returns {Promise<{ findings: Array }>}
   */
  async checkPrevious(punkName, projectId, workingDir) {
    // Load past undismissed findings for this punk
    const result = await this._brainRequest("findings_by_punk", {
      projectId, punk: punkName,
    });
    const previousFindings = result?.findings || [];
    if (previousFindings.length === 0) {
      this._sendToRenderer("pane://punk-complete", {
        punk: punkName, findings: [], checkPrevious: true,
      });
      return { findings: [] };
    }

    const persona = await this._loadPersona(punkName);
    if (!persona) {
      this._sendToRenderer("pane://punk-progress", {
        punk: punkName, status: "failed", error: "Persona not found",
      });
      return { findings: [] };
    }

    // Notify: check started
    this._sendToRenderer("pane://punk-progress", {
      projectId, punk: punkName, status: "checking previous",
    });

    const previousSummary = previousFindings.map((f, i) => {
      let structured = {};
      try { structured = JSON.parse(f.structured || "{}"); } catch {}
      return `${i + 1}. [${f.severity}] ${f.finding}\n   Location: ${f.location || "N/A"}\n   Remediation: ${structured.remediation || "none"}`;
    }).join("\n\n");

    // Get current diff for context
    let diffContext = "";
    try {
      const diffFocus = await this._getDiffFocus(workingDir, null);
      if (diffFocus.stat) diffContext = `\nRecent changes:\n${diffFocus.stat}`;
    } catch {}

    const userPrompt = `You previously found these issues in this codebase. Check if they have been resolved by examining the current code.\n\nPrevious findings:\n${previousSummary}${diffContext}\n\nFor each finding, determine its current status: "resolved" (fixed/changed), "still_present" (same issue exists), or "partial" (partially addressed).\n\nReturn your assessment as a JSON array with the same structure as your normal findings, with an additional "status" field: "resolved" | "still_present" | "partial".`;

    try {
      const rawOutput = await this._agentCall(persona, userPrompt, workingDir);
      const findings = this._parseCheckResults(rawOutput, punkName);

      // Store each checked finding
      const storedFindings = [];
      for (const f of findings) {
        try {
          const stored = await this._brainRequest("review_finding_add", {
            sessionId: null,
            projectId,
            punk: punkName,
            severity: "note",
            finding: f.finding,
            structured: JSON.stringify(f),
            location: f.location || null,
          });
          if (stored?.finding) storedFindings.push(stored.finding);
        } catch {}
      }

      this._sendToRenderer("pane://punk-complete", {
        punk: punkName, findings: storedFindings, checkPrevious: true,
      });

      console.log(`[punks] ${punkName} check complete: ${storedFindings.length} statuses`);
      return { findings: storedFindings };
    } catch (err) {
      console.error(`[punks] ${punkName} check failed:`, err.message);
      this._sendToRenderer("pane://punk-progress", {
        punk: punkName, status: "failed", error: err.message,
      });
      return { findings: [] };
    }
  }

  /**
   * Parse check results — like _parseFindings but tolerant of the "status" field.
   */
  _parseCheckResults(rawOutput, punkName) {
    if (!rawOutput) return [];

    let arr;
    const fenced = rawOutput.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (fenced) {
      try { arr = JSON.parse(fenced[1]); } catch {}
    }
    if (!arr) {
      const bracketMatch = rawOutput.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try { arr = JSON.parse(bracketMatch[0]); } catch {}
      }
    }

    if (!Array.isArray(arr)) return [];

    return arr
      .filter(f => f && typeof f.finding === "string" && f.finding.length > 10)
      .map(f => ({
        punk: punkName,
        severity: "note",
        finding: `[${f.status || "still_present"}] ${f.finding}`,
        location: f.location || null,
        remediation: f.remediation || null,
        status: f.status || "still_present",
        flow: f.flow || null,
        boundary: f.boundary || null,
        journey: f.journey || null,
      }));
  }

  // ── Punk Discovery ─────────────────────────────────────────────────────────

  /**
   * Scan ~/.pane/punks/ for persona files. Each .md file is a punk.
   * @returns {string[]} Punk names (filename without extension)
   */
  _discoverPunks() {
    try {
      return readdirSync(PUNKS_DIR)
        .filter(f => f.endsWith(".md"))
        .map(f => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  // ── Persona Loading ────────────────────────────────────────────────────────

  /**
   * Load a punk's persona from disk.
   * @param {string} name - Punk name (matches filename without .md)
   * @returns {Promise<string|null>} Full persona content, or null
   */
  async _loadPersona(name) {
    try {
      return await fs.readFile(path.join(PUNKS_DIR, `${name}.md`), "utf-8");
    } catch {
      console.warn(`[punks] Failed to load persona: ${name}`);
      return null;
    }
  }

  // ── Diff Focus ─────────────────────────────────────────────────────────────

  /**
   * Compute what changed since the last review.
   * @param {string} workingDir
   * @param {string|null} lastRef - Git ref from previous review
   * @returns {Promise<{stat: string, files: string[], log: string, diff: string}>}
   */
  async _getDiffFocus(workingDir, lastRef) {
    const result = { stat: "", files: [], log: "", diff: "" };
    const ref = lastRef || "HEAD~20";

    try {
      const statOut = execSync(`git diff --stat ${ref}..HEAD 2>/dev/null`, { cwd: workingDir, encoding: "utf-8", timeout: 5000 });
      result.stat = statOut.trim();
    } catch {}
    try {
      const filesOut = execSync(`git diff --name-only ${ref}..HEAD 2>/dev/null`, { cwd: workingDir, encoding: "utf-8", timeout: 5000 });
      result.files = filesOut.trim().split("\n").filter(Boolean);
    } catch {}
    try {
      const logOut = execSync(`git log --oneline ${ref}..HEAD 2>/dev/null`, { cwd: workingDir, encoding: "utf-8", timeout: 5000 });
      result.log = logOut.trim();
    } catch {}
    try {
      // Cap diff to avoid blowing context
      const raw = execSync(`git diff ${ref}..HEAD 2>/dev/null`, { cwd: workingDir, encoding: "utf-8", timeout: 10000 });
      result.diff = raw.length > 15000
        ? raw.slice(0, 15000) + `\n\n... [diff truncated, ${raw.length - 15000} chars omitted]`
        : raw;
    } catch {}

    // Fallback: if no git history, include uncommitted changes
    if (result.files.length === 0) {
      try {
        const filesOut = execSync("git diff --name-only 2>/dev/null", { cwd: workingDir, encoding: "utf-8", timeout: 5000 });
        result.files = filesOut.trim().split("\n").filter(Boolean);
      } catch {}
    }

    return result;
  }

  // ── Prompt Building ────────────────────────────────────────────────────────

  /**
   * Build the user prompt that gives each punk their focused objective.
   * The system prompt is the persona file itself.
   */
  _buildUserPrompt(diffFocus) {
    const parts = [];

    if (diffFocus.files.length > 0) {
      parts.push(`## Changes since last review\n`);
      parts.push(`Files changed: ${diffFocus.files.length}`);
      if (diffFocus.stat) parts.push(`\n${diffFocus.stat}`);
      if (diffFocus.log) parts.push(`\nCommits:\n${diffFocus.log}`);
      if (diffFocus.diff) parts.push(`\nDiff:\n\`\`\`\n${diffFocus.diff}\n\`\`\``);
      parts.push(`\nAnalyze these changes. You have full read access to trace anything deeper — use Read, Glob, Grep, pane_find_symbol, pane_find_references to follow any thread.`);
    } else {
      parts.push(`No changes detected since the last review. Perform a general review of the codebase — use Read, Glob, Grep, pane_find_symbol to explore and find issues in your domain of expertise.`);
    }

    return parts.join("\n");
  }

  // ── Finding Parser ─────────────────────────────────────────────────────────

  /**
   * Parse structured JSON findings from a punk's raw LLM output.
   * Handles both fenced JSON and raw JSON arrays.
   */
  _parseFindings(rawOutput, punkName) {
    if (!rawOutput) return [];

    let arr;

    // Try fenced JSON first: ```json ... ```
    const fenced = rawOutput.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (fenced) {
      try { arr = JSON.parse(fenced[1]); } catch {}
    }

    // Fallback: raw JSON array anywhere in the output
    if (!arr) {
      const bracketMatch = rawOutput.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try { arr = JSON.parse(bracketMatch[0]); } catch {}
      }
    }

    if (!Array.isArray(arr)) return [];

    // Validate and normalize
    return arr
      .filter(f => f && typeof f.finding === "string" && f.finding.length > 10)
      .map(f => ({
        punk: punkName,
        severity: ["critical", "warning", "note"].includes(f.severity) ? f.severity : "note",
        finding: f.finding,
        location: f.location || null,
        remediation: f.remediation || null,
        // Preserve punk-specific fields
        flow: f.flow || null,
        boundary: f.boundary || null,
        journey: f.journey || null,
      }));
  }

  // ── Shared Helpers (kept from original) ────────────────────────────────────

  /**
   * Resolve the actual filesystem root for a projectId.
   */
  async _resolveWorkingDir(projectId) {
    if (!projectId) return os.homedir();
    try {
      const rootFile = path.join(PANE_DIR, "memory", projectId, "root.txt");
      const root = (await fs.readFile(rootFile, "utf-8")).trim();
      if (root) return root;
    } catch {}
    if (projectId.startsWith("/")) return projectId;
    return os.homedir();
  }

  /**
   * Load project context (brief, principles, memories).
   */
  async _loadProjectContext(projectId, query) {
    const result = {
      projectName: projectId || "unknown",
      why: "",
      principles: [],
      memories: [],
      relevantFiles: [],
    };

    if (!projectId) return result;

    try {
      result.about = (await fs.readFile(path.join(PANE_DIR, "memory", projectId, "about.md"), "utf-8")).trim();
    } catch {}

    try {
      const eventsPath = path.join(PANE_DIR, "memory", projectId, "events.jsonl");
      const raw = await fs.readFile(eventsPath, "utf-8");
      result.principles = raw.split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(e => e?.type === "principle")
        .map(e => e.content);
    } catch {}

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

  /**
   * Write a finding to the Lens posts table (backward compat).
   */
  async _writeLensPost(contributor, content, projectId = null, entryId = null) {
    try {
      const result = await this._brainRequest("lens_post_add", { contributor, content, projectId, entryId });
      const lensPost = result?.post;
      if (lensPost) {
        this._sendToRenderer("pane://lens-post", lensPost);
      }
      return lensPost;
    } catch (err) {
      console.error("[punks] _writeLensPost failed:", err.message);
    }
  }

  // ── Punk Management ────────────────────────────────────────────────────────

  /**
   * List all available punks from disk, with metadata extracted from the markdown.
   * @returns {Promise<Array<{name: string, displayName: string, role: string, color?: string}>>}
   */
  async listPunks() {
    const names = this._discoverPunks();
    const punks = [];
    for (const name of names) {
      const persona = await this._loadPersona(name);
      const displayName = persona?.match(/^#\s+(.+)/m)?.[1]?.trim() || name;
      const role = persona?.match(/^## Identity\s*\n\n(.+?)(?:\n\n|$)/ms)?.slice(1)?.[0]?.trim() || "";
      punks.push({ name, displayName, role });
    }
    return punks;
  }

  /**
   * Create a new punk persona file on disk.
   * @param {string} name - kebab-case identifier (becomes filename)
   * @param {string} personaContent - Full markdown content (# Name, ## Identity, ## Methodology, ## Principles)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createPunk(name, personaContent) {
    // Validate: alphanumeric + hyphens only, no path traversal
    if (!name || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name)) {
      return { success: false, error: "Name must be alphanumeric with optional hyphens" };
    }
    if (!personaContent || personaContent.trim().length < 10) {
      return { success: false, error: "Persona content is too short" };
    }
    const filePath = path.join(PUNKS_DIR, `${name}.md`);
    try {
      await fs.writeFile(filePath, personaContent.trim(), "utf-8");
      console.log(`[punks] Created new punk: ${name}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}
