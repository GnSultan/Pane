/**
 * Doc Punk — automated documentation drafter.
 *
 * Runs on a schedule (nightly at 10pm) or on manual trigger. Reads the
 * session journal and git diff to understand what changed and what was
 * discussed, then proposes documentation updates via Lens posts.
 *
 * Three phases:
 *   1. Gather — read journal, git diff, and docs/ tree (no LLM)
 *   2. Draft — call the user's configured execution model to produce a doc patch
 *   3. Surface — post the proposed changes to Lens as contributor "scribe"
 *
 * The user reviews and approves in Lens. They can apply changes manually
 * or ask the model in a conversation thread to apply them.
 *
 * Architecture: follows the same dependency-injection pattern as MindPunks —
 * receives quickCall, brainRequest, and sendToRenderer from main.mjs.
 *
 * State tracked in ~/.pane/doc-punk-state.json — { lastRunAt, lastGitHash }.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execThroughWorker } from "./tool-executor.mjs";

const PANE_DIR = path.join(os.homedir(), ".pane");
const STATE_PATH = path.join(PANE_DIR, "doc-punk-state.json");

// ── State persistence ───────────────────────────────────────────────────

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { lastRunAt: 0, lastGitHash: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(PANE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best-effort persistence — state loss is non-critical (just re-runs)
  }
}

// ── Doc Punk ─────────────────────────────────────────────────────────────

export class DocPunk {
  constructor({ quickCall, brainRequest, sendToRenderer }) {
    this._quickCall = quickCall;
    this._brainRequest = brainRequest;
    this._sendToRenderer = sendToRenderer;
  }

  /**
   * Run the doc punk against a project. Gathers journal + diff + docs,
   * calls the LLM, and posts proposed changes to Lens.
   *
   * @param {string} projectId
   * @param {string} workingDir - absolute path to project root
   * @param {boolean} [force=false] - skip staleness check
   * @returns {Promise<{ post: object|null, skipped: string|null }>}
   */
  async run(projectId, workingDir, force = false) {
    const startTime = Date.now();
    console.log(`[doc-punk] Running for ${projectId} (${workingDir})`);

    // ── Check staleness ──────────────────────────────────────────────
    const state = readState();
    const projectKey = `${projectId}:${workingDir}`;
    const lastRun = state[projectKey]?.lastRunAt || 0;
    const lastGitHash = state[projectKey]?.lastGitHash || null;

    if (!force) {
      const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
      if (hoursSince < 20) {
        console.log(`[doc-punk] Skipping ${projectId}: ran ${hoursSince.toFixed(1)}h ago`);
        return { post: null, skipped: "too-soon" };
      }
    }

    // ── Phase 1: Gather ─────────────────────────────────────────────
    const gathered = await this._gather(projectId, workingDir, lastGitHash);
    if (!gathered) {
      console.log(`[doc-punk] Skipping ${projectId}: nothing to gather`);
      return { post: null, skipped: "no-data" };
    }

    // Check if there's actually anything new since last run
    if (!force && gathered.gitHash === lastGitHash && gathered.journalEntries.length < 3) {
      console.log(`[doc-punk] Skipping ${projectId}: no changes since last run`);
      return { post: null, skipped: "unchanged" };
    }

    // ── Phase 2: Draft ──────────────────────────────────────────────
    const draft = await this._draft(gathered, workingDir);
    if (!draft) {
      console.log(`[doc-punk] LLM returned no draft for ${projectId}`);
      return { post: null, skipped: "empty-draft" };
    }

    // ── Phase 3: Surface ─────────────────────────────────────────────
    const post = await this._surface(projectId, workingDir, draft, gathered);

    // Update state
    state[projectKey] = { lastRunAt: Date.now(), lastGitHash: gathered.gitHash };
    writeState(state);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[doc-punk] Complete for ${projectId} in ${elapsed}s`);
    return { post, skipped: null };
  }

  /**
   * Run doc punk across all projects that have recent journal activity.
   * Called by the nightly scheduler.
   *
   * @param {Array<{ projectId: string, workingDir: string }>} projects
   * @returns {Promise<Array>}
   */
  async runAll(projects) {
    const results = [];
    for (const p of projects) {
      try {
        const result = await this.run(p.projectId, p.workingDir);
        results.push({ ...p, ...result });
      } catch (err) {
        console.error(`[doc-punk] Failed for ${p.projectId}:`, err.message);
        results.push({ ...p, post: null, skipped: "error", error: err.message });
      }
    }
    return results;
  }

  // ── Phase 1: Gather ──────────────────────────────────────────────────

  async _gather(projectId, workingDir, lastGitHash) {
    const journalEntries = this._readJournal(projectId);
    const gitInfo = await this._getGitInfo(workingDir, lastGitHash);
    const docsTree = this._readDocsTree(workingDir);

    if (!journalEntries && !gitInfo?.diff && docsTree.length === 0) {
      return null;
    }

    return {
      projectId,
      workingDir,
      journalEntries: journalEntries || [],
      gitDiff: gitInfo?.diff || "",
      gitHash: gitInfo?.hash || null,
      gitStat: gitInfo?.stat || "",
      docsTree,
    };
  }

  // ── Journal reading ──────────────────────────────────────────────────

  _readJournal(projectId) {
    try {
      const journalPath = path.join(PANE_DIR, "session", projectId, "journal.ndjson");
      if (!fs.existsSync(journalPath)) return [];

      const raw = fs.readFileSync(journalPath, "utf-8");
      const lines = raw.trim().split("\n");

      // Only last 24h of entries, max 300 lines
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recentLines = lines.slice(-300);

      const entries = [];
      for (const line of recentLines) {
        try {
          const entry = JSON.parse(line);
          if (!entry) continue;

          // Skip state deltas and progress — only real messages
          if (entry._type) continue;

          if (entry.ts && entry.ts < cutoff) continue;

          if (entry.role === "user" && entry.content) {
            const text = typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
            entries.push({ role: "user", text: text.slice(0, 300), ts: entry.ts });
          } else if (entry.role === "assistant" && entry.content) {
            const text = typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
            entries.push({ role: "assistant", text: text.slice(0, 400), ts: entry.ts });
          }
        } catch { /* skip corrupt lines */ }
      }

      return entries;
    } catch {
      return [];
    }
  }

  // ── Git info ─────────────────────────────────────────────────────────

  async _getGitInfo(workingDir, lastGitHash) {
    try {
      // Get current HEAD
      const headR = await execThroughWorker("git rev-parse HEAD 2>/dev/null", {
        cwd: workingDir, timeout: 5,
      });
      const currentHash = headR.success ? headR.stdout.trim() : null;
      if (!currentHash) return null;

      // Get diff since last doc run (or default to last 50 commits)
      const baseRef = lastGitHash || "HEAD~50";
      const diffR = await execThroughWorker(
        `git diff ${baseRef}..HEAD --stat -- . ':!docs/' ':!*.lock' ':!package-lock.json' 2>/dev/null`,
        { cwd: workingDir, timeout: 10 },
      );
      const diffStat = diffR.success ? diffR.stdout.trim() : "";

      // Get a focused diff summary of non-docs, non-lock files
      const detailedR = await execThroughWorker(
        `git diff ${baseRef}..HEAD -- . ':!docs/' ':!*.lock' ':!package-lock.json' ':!node_modules/' 2>/dev/null | head -n 500`,
        { cwd: workingDir, timeout: 10 },
      );
      const detailedDiff = detailedR.success ? detailedR.stdout.trim() : "";

      return {
        hash: currentHash,
        stat: diffStat,
        diff: detailedDiff,
      };
    } catch {
      return null;
    }
  }

  // ── Docs tree ────────────────────────────────────────────────────────

  _readDocsTree(workingDir) {
    const docsDir = path.join(workingDir, "docs");
    if (!fs.existsSync(docsDir)) return [];

    const results = [];
    try {
      this._walkDocsDir(docsDir, docsDir, results);
    } catch {
      // docsDir may not exist or lack read permissions — return empty
    }
    return results;
  }

  _walkDocsDir(baseDir, currentDir, results) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        this._walkDocsDir(baseDir, fullPath, results);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          // Extract headers for structure overview
          const headers = [];
          for (const line of content.split("\n")) {
            const m = line.match(/^(#{1,4})\s+(.+)/);
            if (m) headers.push({ level: m[1].length, text: m[2].trim() });
          }
          results.push({
            path: relativePath,
            headers,
            size: content.length,
            // First 200 chars as preview
            preview: content.replace(/^---[\s\S]*?---\n?/, "").trim().slice(0, 200),
          });
        } catch {
          // Skip unreadable files — won't block the whole docs scan
        }
      }
    }
  }

  // ── Phase 2: Draft ───────────────────────────────────────────────────

  async _draft(gathered, workingDir) {
    const prompt = this._buildDraftPrompt(gathered, workingDir);

    try {
      const raw = await this._quickCall(
        "You are a documentation specialist. You analyze conversations and code changes to produce precise, actionable documentation updates. Output only valid JSON.",
        prompt,
      );

      if (!raw) return null;

      // Parse JSON from response
      const trimmed = raw.trim();
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch {}
        }
      }

      if (!parsed || !parsed.changes || !Array.isArray(parsed.changes)) return null;

      return {
        summary: parsed.summary || "",
        changes: parsed.changes.filter(c => c.file && c.content).slice(0, 5),
        gaps: parsed.gaps || [],
        stale: parsed.stale || [],
      };
    } catch (err) {
      console.error("[doc-punk] LLM call failed:", err.message);
      return null;
    }
  }

  _buildDraftPrompt(gathered, workingDir) {
    const journalSummary = gathered.journalEntries.length > 0
      ? gathered.journalEntries.map(e => `[${e.role}] ${e.text}`).join("\n")
      : "(no recent conversation)";

    const docsSummary = gathered.docsTree.length > 0
      ? gathered.docsTree.map(d =>
          `- ${d.path} (${d.size}B) → headers: ${d.headers.map(h => h.text).join(" | ") || "(none)"}`
        ).join("\n")
      : "(no docs directory found)";

    const schemaLines = [
      '  "summary": "string — 2-4 sentence narrative of what changed and what docs need updating",',
      '  "changes": [',
      '    {',
      '      "file": "string — relative path inside docs/, e.g. guide/getting-started.md",',
      '      "action": "create | update | add-section",',
      '      "title": "string — section or page title",',
      '      "content": "string — the COMPLETE markdown to insert/replace/create. Write the full section or page, not just notes."',
      '    }',
      '  ],',
      '  "gaps": ["string — topics discussed but not documented anywhere"],',
      '  "stale": ["string — existing docs sections that are now outdated"]',
    ];

    return [
      "You are analyzing a development session to produce documentation updates.",
      "",
      "Input:",
      "1. Recent conversation journal (what was discussed)",
      "2. Git diff (what code actually changed)",
      "3. Current docs/ tree (what docs exist)",
      "",
      "Your job: propose specific documentation updates that close the gap between what was built/discussed and what is documented.",
      "",
      "Rules:",
      "- Write COMPLETE markdown sections, not bullet-point notes",
      "- Match the existing docs' tone and style",
      "- Be specific — reference actual files, flags, commands from the diff and conversation",
      "- If a new feature was built but not documented, create a new page or section",
      "- If a conversation revealed a gotcha or pattern, document it",
      "- If existing docs are stale (mention removed features, old paths), flag them",
      "- At most 5 changes — prioritize the most important ones",
      "- If nothing meaningful changed, return an empty changes array",
      "",
      "Output ONLY valid JSON with these exact fields:",
      "{",
      schemaLines.join("\n"),
      "}",
      "",
      "=== CONVERSATION JOURNAL ===",
      journalSummary,
      "",
      "=== GIT DIFF (code changes) ===",
      gathered.gitDiff || "(no diff available)",
      "",
      "=== DIFF STAT ===",
      gathered.gitStat || "(no stat)",
      "",
      "=== CURRENT DOCS TREE ===",
      docsSummary,
      "",
      "Working directory: " + workingDir,
      "",
      "DOC PATCH JSON:",
    ].join("\n");
  }

  // ── Phase 3: Surface ──────────────────────────────────────────────────

  async _surface(projectId, workingDir, draft, gathered) {
    // Build a rich markdown post for Lens
    const parts = [];

    parts.push(`## Doc update for \`${path.basename(workingDir)}\``);
    parts.push("");
    parts.push(draft.summary);
    parts.push("");

    if (draft.changes.length > 0) {
      parts.push("### Proposed changes");
      parts.push("");
      for (const change of draft.changes) {
        const actionLabel = {
          "create": "📄 **New page**",
          "update": "✏️ **Update**",
          "add-section": "➕ **New section in**",
        }[change.action] || `**${change.action}**`;

        parts.push(`#### ${actionLabel}: \`${change.file}\``);
        if (change.title) parts.push(`> ${change.title}`);
        parts.push("");
        parts.push("```markdown");
        parts.push(change.content.slice(0, 2000));
        if (change.content.length > 2000) parts.push("... (truncated)");
        parts.push("```");
        parts.push("");
      }
    }

    if (draft.gaps.length > 0) {
      parts.push("### Undocumented topics");
      for (const g of draft.gaps) parts.push(`- ${g}`);
      parts.push("");
    }

    if (draft.stale.length > 0) {
      parts.push("### Possibly stale docs");
      for (const s of draft.stale) parts.push(`- ${s}`);
      parts.push("");
    }

    parts.push("---");
    parts.push(`_Auto-generated by doc-punk. ${gathered.journalEntries.length} journal entries analyzed, ${draft.changes.length} changes proposed._`);

    const content = parts.join("\n");

    try {
      const result = await this._brainRequest("lens_post_add", {
        contributor: "scribe",
        content,
        projectId,
        entryId: null,
      });
      const post = result?.post || null;
      if (post) {
        this._sendToRenderer("pane://lens-post", post);
      }
      return post;
    } catch (err) {
      console.error("[doc-punk] Failed to post to Lens:", err.message);
      return null;
    }
  }
}
