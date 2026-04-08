import path from "node:path";
import {
  ipcMain,
  BrowserWindow,
  shell,
  dialog,
  app,
  utilityProcess,
  nativeImage,
} from "electron";
import windowStateKeeper from "electron-window-state";
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";

import { promisify } from "node:util";
import ignore from "ignore";
import chokidar from "chokidar";
import {
  registerPunkHandlers,
  preforkPunkWorker,
  shutdownPunkWorker,
  punkEngine,
} from "./punk-engine.mjs";
import { modelManager } from "./model-manager.mjs";
import { startBackupSchedule } from "./backup-engine.mjs";
import { initCloudAuth } from "./cloud-auth.mjs";
import { registerCloudSyncHandlers } from "./cloud-sync.mjs";
import { MindPunks } from "./mind-punks.mjs";
import { getModelRates } from "./pricing.mjs";
import { contextStore } from "./context-store.mjs";
import { getPaneDb, extractMessageText } from "./pane-db.mjs";
import { loadRecentTurns } from "./session-turns.mjs";
const __dirname = import.meta.dirname;
const isMac = process.platform === "darwin";
let forceQuit = false;
let mindPunks = null;
// Punk engine runs in a UtilityProcess to keep the main thread free.
// Main process is a thin relay — never touches JSON.parse or model output.
async function registerClaudeHandlers() {
  // Punk is the default engine; keep these names for backwards compatibility.
  await registerPunkHandlers();

  // ── Token Usage Persistence Hook ───────────────────────────────────────
  // Intercept all token_usage events from backends (HTTP and CLI) and record
  // them to SQLite for long-term analytics.
  const origHandleBackendEvent = punkEngine.handleBackendEvent.bind(punkEngine);
  punkEngine.handleBackendEvent = (projectId, event, requestId) => {
    if (event.event === "token_usage") {
      try {
        const db = getPaneDb();
        if (!db.stmts.insertTokenUsage) {
          console.warn("[main] Database not initialized, skipping token usage recording");
          return;
        }
        const usage = event.data;
        const id = `tu-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        db.stmts.insertTokenUsage.run(
          id,
          projectId,
          usage.provider,
          usage.activity_type,
          usage.model,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_creation_input_tokens || 0,
          usage.cache_read_input_tokens || 0,
          usage.cost_usd,
          usage.duration_ms || 0,
          Date.now(),
        );
      } catch (err) {
        console.error("[main] Failed to record token usage:", err.message);
      }
    }
    return origHandleBackendEvent(projectId, event, requestId);
  };

  ipcMain.handle("send_to_claude", async (_event, args) => {
    const { projectId, prompt, workingDir, model, intent } = args;
    await punkEngine.spawn({
      projectId,
      prompt,
      workingDir,
      model,
      intent,
    });
  });
  ipcMain.handle("abort_claude", async (_event, args) => {
    await punkEngine.abort(args.projectId);
  });
  ipcMain.handle("terminate_claude_session", async (_event, args) => {
    await punkEngine.terminate(args.projectId);
  });
  ipcMain.handle("get_token_analytics", async (_event, { projectId, sinceMs }) => {
    try {
      const db = getPaneDb();
      if (!db.stmts.getTokenAnalytics) {
        console.warn("[main] Database not fully initialized, returning empty analytics");
        return [];
      }
      if (projectId) {
        return db.stmts.getTokenAnalytics.all(projectId, sinceMs || 0);
      } else {
        return db.stmts.getGlobalTokenAnalytics.all(sinceMs || 0);
      }
    } catch (err) {
      console.error("[main] get_token_analytics error:", err.message);
      return [];
    }
  });
  ipcMain.handle("get_token_timeseries", async (_event, { projectId, sinceMs }) => {
    try {
      const db = getPaneDb();
      if (projectId) {
        return db.stmts.getTokenTimeSeries?.all(projectId, sinceMs || 0) || [];
      }
      return db.stmts.getGlobalTokenTimeSeries?.all(sinceMs || 0) || [];
    } catch (err) {
      console.error("[main] get_token_timeseries error:", err.message);
      return [];
    }
  });

  ipcMain.handle("get_model_rates", async (_event, { models }) => {
    const rates = {};
    for (const m of models) {
      rates[m] = getModelRates(m);
    }
    return rates;
  });

  ipcMain.handle("check_claude_version", async () => {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], {
        env: getEnvWithPath(),
      });
      const versionMatch = stdout.trim().match(/^([\d.]+)/);
      if (!versionMatch)
        return { current: null, error: "Could not parse version" };
      return { current: versionMatch[1], error: null };
    } catch (error) {
      return { current: null, error: error.message };
    }
  });
  ipcMain.handle("check_gemini_version", async () => {
    try {
      const { stdout } = await execFileAsync("gemini", ["-v"], {
        env: getEnvWithPath(),
      });
      const versionMatch = stdout.trim().match(/^([\d.]+)/);
      if (!versionMatch)
        return { current: null, error: "Could not parse version" };
      return { current: versionMatch[1], error: null };
    } catch (error) {
      return { current: null, error: error.message };
    }
  });

  ipcMain.handle("check_gemini_update", async () => {
    try {
      // Get current version from gemini -v
      const { stdout: versionOut } = await execFileAsync("gemini", ["-v"], {
        env: getEnvWithPath(),
      });
      const currentMatch = versionOut.trim().match(/^([\d.]+)/);
      const current = currentMatch?.[1] ?? null;

      // Get latest version from npm registry
      const { stdout: npmOut } = await execFileAsync(
        "npm",
        ["show", "@google/gemini-cli", "version"],
        { timeout: 15000, env: getEnvWithPath() },
      );
      const latest = npmOut.trim() || null;

      if (!current || !latest) {
        return {
          updateAvailable: false,
          currentVersion: current,
          newVersion: null,
          error: null,
        };
      }

      const updateAvailable = latest !== current;
      return {
        updateAvailable,
        currentVersion: current,
        newVersion: updateAvailable ? latest : null,
        error: null,
      };
    } catch (error) {
      return {
        updateAvailable: false,
        currentVersion: null,
        newVersion: null,
        error: error.message,
      };
    }
  });

  ipcMain.handle("update_gemini", async () => {
    try {
      const env = getEnvWithPath();

      // Find where gemini is globally installed
      const { stdout: prefixOut } = await execFileAsync("npm", ["root", "-g"], {
        env,
        timeout: 10000,
      });
      const globalRoot = prefixOut.trim();
      const pkgDir = path.join(globalRoot, "@google", "gemini-cli");

      // Remove existing install directory
      await fs.promises.rm(pkgDir, { recursive: true, force: true });

      // Fresh install
      const { stdout, stderr } = await execFileAsync(
        "npm",
        ["install", "-g", "@google/gemini-cli@latest"],
        { timeout: 120000, env },
      );
      return { success: true, output: stdout + stderr, error: null };
    } catch (error) {
      const output = (error.stdout || "") + (error.stderr || "");
      return { success: false, output, error: error.message };
    }
  });
}
const execFileAsync = promisify(execFile);

// Build a PATH that includes common tool locations Electron strips out
function getEnvWithPath() {
  const home = os.homedir();
  // Add all nvm node version bin dirs
  const nvmVersionsDir = path.join(home, ".nvm", "versions", "node");
  const nvmBins = [];
  try {
    const versions = fs.readdirSync(nvmVersionsDir);
    for (const v of versions) {
      nvmBins.push(path.join(nvmVersionsDir, v, "bin"));
    }
  } catch {}
  const extra = [
    ...nvmBins,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ];
  const existing = process.env.PATH || "";
  const combined = [...extra, ...existing.split(":")].filter(Boolean).join(":");
  return { ...process.env, PATH: combined };
}
function registerCommandHandlers() {
  ipcMain.handle("read_directory", async (_event, args) => {
    const dirEntries = await fs.promises.readdir(args.path, {
      withFileTypes: true,
    });
    const entries = [];
    for (const entry of dirEntries) {
      if (entry.name === ".DS_Store") continue;
      const fullPath = path.join(args.path, entry.name);
      const isDir = entry.isDirectory();
      entries.push({
        name: entry.name,
        path: fullPath,
        is_dir: isDir,
        is_hidden: entry.name.startsWith("."),
        extension: isDir ? null : path.extname(entry.name).slice(1) || null,
      });
    }
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return entries;
  });
  ipcMain.handle("read_directory_tree", async (_event, args) => {
    const SKIP_DIRS = new Set([
      "node_modules",
      "dist",
      "build",
      "out",
      ".next",
      "target",
      ".turbo",
      "coverage",
      "__pycache__",
      ".cache",
      ".parcel-cache",
      "vendor",
      ".gradle",
      ".dart_tool",
      "Pods",
    ]);
    const result = {};
    async function readLevel(dirPath, depth) {
      try {
        const dirEntries = await fs.promises.readdir(dirPath, {
          withFileTypes: true,
        });
        const entries = [];
        const subdirs = [];
        for (const entry of dirEntries) {
          if (entry.name === ".DS_Store") continue;
          const fullPath = path.join(dirPath, entry.name);
          const isDir = entry.isDirectory();
          entries.push({
            name: entry.name,
            path: fullPath,
            is_dir: isDir,
            is_hidden: entry.name.startsWith("."),
            extension: isDir ? null : path.extname(entry.name).slice(1) || null,
          });
          if (
            isDir &&
            depth < args.maxDepth &&
            !entry.name.startsWith(".") &&
            !SKIP_DIRS.has(entry.name)
          ) {
            subdirs.push(fullPath);
          }
        }
        entries.sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        result[dirPath] = entries;
        await Promise.all(subdirs.map((sub) => readLevel(sub, depth + 1)));
      } catch {}
    }
    await readLevel(args.path, 0);
    return result;
  });
  ipcMain.handle("read_file", async (_event, args) => {
    const stat = await fs.promises.stat(args.path);
    if (stat.size > 5 * 1024 * 1024) {
      throw new Error("File too large (>5MB)");
    }
    const buffer = await fs.promises.readFile(args.path);
    const checkLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) throw new Error("Binary file — cannot display");
    }
    // Convert to string and strip any trailing null bytes that might have 
    // been added by file system oddities or previous bugs.
    return buffer.toString("utf-8").replace(/\0+$/, "");
  });
  ipcMain.handle("write_file", async (_event, args) => {
    await fs.promises.mkdir(path.dirname(args.path), { recursive: true });
    // Using 'w' flag explicitly to ensure truncation, though writeFile default is 'w'
    await fs.promises.writeFile(args.path, args.content, { encoding: "utf-8", flag: "w" });
  });

  ipcMain.handle("load_scroll_positions", () => {
    try {
      const db = getPaneDb();
      const rows = db.stmts.getAllScrolls.all();
      return Object.fromEntries(rows.map(r => [
        r.project_id,
        r.position === "bottom" ? "bottom" : Number(r.position),
      ]));
    } catch {
      return {};
    }
  });
  ipcMain.handle("save_scroll_positions", (_event, args) => {
    try {
      const db = getPaneDb();
      const insertAll = db.transaction((positions) => {
        for (const [pid, pos] of Object.entries(positions)) {
          db.stmts.upsertScroll.run(pid, String(pos), Date.now());
        }
      });
      insertAll(args.positions);
    } catch (e) {
      console.error("[pane-db] save_scroll_positions error:", e.message);
    }
  });
  ipcMain.handle("rename_file", async (_event, args) => {
    await fs.promises.rename(args.oldPath, args.newPath);
  });
  ipcMain.handle("delete_file", async (_event, args) => {
    // Move to Trash instead of permanent deletion
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const escapedPath = args.path.replace(/'/g, "'\\''");
    const script = `osascript -e 'tell application "Finder" to delete POSIX file "${escapedPath}"'`;

    try {
      await execAsync(script);
    } catch (error) {
      // If AppleScript fails, fall back to permanent deletion with explicit confirmation
      throw new Error(
        `Failed to move to Trash: ${error.message}. File was NOT deleted.`,
      );
    }
  });
  ipcMain.handle("get_home_dir", () => os.homedir());
  ipcMain.handle("get_cwd", () => process.cwd());
  ipcMain.handle("detect_project_root", async (_event, args) => {
    let current = args.startPath;
    while (true) {
      try {
        await fs.promises.access(path.join(current, ".git"));
        return current;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return args.startPath;
        current = parent;
      }
    }
  });
  ipcMain.handle("walk_project_files", async (_event, args) => {
    const files = [];
    const ig = ignore();
    try {
      const gitignore = await fs.promises.readFile(
        path.join(args.root, ".gitignore"),
        "utf-8",
      );
      ig.add(gitignore);
    } catch {}
    ig.add(".git");
    async function walk(dir, depth) {
      if (depth > 20) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(args.root, fullPath);
        if (ig.ignores(relativePath)) continue;
        if (entry.isDirectory()) {
          if (ig.ignores(`${relativePath}/`)) continue;
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      }
    }
    await walk(args.root, 0);
    files.sort();
    return files;
  });
  ipcMain.handle("search_in_files", async (_event, args) => {
    const max = args.maxResults ?? 200;
    const queryLower = args.query.toLowerCase();
    const results = [];
    const ig = ignore();
    try {
      const gitignore = await fs.promises.readFile(
        path.join(args.root, ".gitignore"),
        "utf-8",
      );
      ig.add(gitignore);
    } catch {}
    ig.add(".git");
    async function walk(dir, depth) {
      if (depth > 20 || results.length >= max) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= max) break;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(args.root, fullPath);
        if (ig.ignores(relativePath)) continue;
        if (entry.isDirectory()) {
          if (ig.ignores(`${relativePath}/`)) continue;
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size > 2 * 1024 * 1024) continue;
          } catch {
            continue;
          }
          let content;
          try {
            content = await fs.promises.readFile(fullPath);
          } catch {
            continue;
          }
          const checkLen = Math.min(content.length, 512);
          let isBinary = false;
          for (let i = 0; i < checkLen; i++) {
            if (content[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) continue;
          const text = content.toString("utf-8");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= max) break;
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push({
                file_path: relativePath,
                absolute_path: fullPath,
                line_number: i + 1,
                line_content: lines[i].slice(0, 200),
              });
            }
          }
        }
      }
    }
    await walk(args.root, 0);
    return results;
  });
  ipcMain.handle("get_git_status", async (_event, args) => {
    let branch;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: args.path,
        },
      );
      branch = stdout.trim();
    } catch {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          {
            cwd: args.path,
          },
        );
        branch = stdout.trim();
      } catch {
        branch = "master";
      }
    }
    const files = {};
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-unormal"],
        {
          cwd: args.path,
        },
      );
      for (const line of stdout.split("\n")) {
        if (line.length < 4) continue;
        const statusCode = line.slice(0, 2).trim();
        let filePath = line.slice(3);
        const arrowPos = filePath.indexOf(" -> ");
        if (arrowPos !== -1) {
          filePath = filePath.slice(arrowPos + 4);
        }
        files[filePath] = statusCode;
      }
    } catch {}
    return { branch, files };
  });
  ipcMain.handle("get_git_log", async (_event, args) => {
    const max = args.count ?? 50;
    try {
      // \x00 = field sep, \x1E = commit record sep — both safe in git output
      const { stdout } = await execFileAsync(
        "git",
        ["log", `-${max}`, "--pretty=format:%h%x00%s%x00%B%x00%an%x00%ar%x1E"],
        { cwd: args.path },
      );
      const commits = [];
      for (const block of stdout.split("\x1E")) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const parts = trimmed.split("\x00");
        if (parts.length >= 5) {
          commits.push({
            hash: (parts[0] ?? "").trim(),
            subject: (parts[1] ?? "").trim(),
            body: (parts[2] ?? "").trim(),
            author: (parts[3] ?? "").trim(),
            date: (parts[4] ?? "").trim(),
          });
        }
      }
      return commits;
    } catch {
      return [];
    }
  });
  ipcMain.handle("git_commit", async (_event, args) => {
    try {
      await execFileAsync("git", ["add", "-A"], { cwd: args.path });
      await execFileAsync("git", ["commit", "-m", args.message], {
        cwd: args.path,
      });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });
  ipcMain.handle("git_push", async (_event, args) => {
    try {
      await execFileAsync("git", ["push"], { cwd: args.path });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });
  ipcMain.handle("git_pull", async (_event, args) => {
    try {
      await execFileAsync("git", ["pull"], { cwd: args.path });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle("git_ahead_behind", async (_event, args) => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--count", "--left-right", "HEAD...@{upstream}"],
        { cwd: args.path },
      );
      const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      // No upstream or other error — return zeros
      return { ahead: 0, behind: 0 };
    }
  });

  ipcMain.handle("git_list_branches", async (_event, args) => {
    try {
      // Plain `git branch` output: "* main\n  feature\n  ..." — strip the * marker
      const { stdout } = await execFileAsync("git", ["branch"], { cwd: args.path });
      const branches = stdout
        .split("\n")
        .map((l) => l.replace(/^\*?\s*/, "").trim())
        .filter(Boolean);
      return { branches };
    } catch (err) {
      return { branches: [], error: String(err) };
    }
  });

  ipcMain.handle("git_checkout", async (_event, args) => {
    try {
      await execFileAsync("git", ["checkout", args.branch], { cwd: args.path });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle("git_stash", async (_event, args) => {
    try {
      await execFileAsync("git", ["stash"], { cwd: args.path });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // --- Auto-draft commit message via LLM ---
  ipcMain.handle("draft_commit_message", async (_event, args) => {
    const { projectId, root } = args;
    try {
      // 1. Staged diff (what's actually going to be committed)
      let stagedDiff = "";
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--cached"], { cwd: root });
        stagedDiff = stdout.trim();
      } catch {}

      // 2. Unstaged diff (working tree changes not yet staged)
      let unstagedDiff = "";
      try {
        const { stdout } = await execFileAsync("git", ["diff"], { cwd: root });
        unstagedDiff = stdout.trim();
      } catch {}

      // 3. Full status — file-level summary with status codes
      let statusSummary = "";
      try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-unormal"], { cwd: root });
        statusSummary = stdout.trim();
      } catch {}

      // 4. Recent commits — understand the project's commit style and context
      let recentCommits = "";
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["log", "--oneline", "-8"],
          { cwd: root },
        );
        recentCommits = stdout.trim();
      } catch {}

      // 5. Pane session change history — what the AI assistant actually did
      let changeDescriptions = [];
      try {
        const rows = db.stmts.getChanges.all(projectId);
        for (const c of rows.slice(0, 40)) {
          if (c.description) changeDescriptions.push(`- ${c.file_path}: ${c.description}`);
          else if (c.file_path) changeDescriptions.push(`- modified ${c.file_path}`);
        }
      } catch {}

      // Combine diffs — prefer staged, fall back to unstaged, cap total to avoid token blowout
      const MAX_DIFF = 6000;
      let diffSection = "";
      if (stagedDiff) {
        diffSection = stagedDiff.length > MAX_DIFF
          ? stagedDiff.slice(0, MAX_DIFF) + "\n... (truncated)"
          : stagedDiff;
      } else if (unstagedDiff) {
        diffSection = unstagedDiff.length > MAX_DIFF
          ? unstagedDiff.slice(0, MAX_DIFF) + "\n... (truncated)"
          : unstagedDiff;
      }

      const systemPrompt = `Output only the raw git commit message text. No preamble, no explanation, no "Here is the commit message:", no markdown fences. Your entire response IS the commit message — nothing before it, nothing after it.

Study the actual diff carefully — understand what changed at the code level, not just which files.

Subject line rules:
- Conventional commit format: type(scope): description — all lowercase, max 72 chars
- Types: feat, fix, refactor, style, chore, docs, test, perf — pick the most accurate one
- Scope: optional, short noun describing what area changed (e.g. git-panel, input-bar, terminal)
- Description: outcome phrase, imperative mood ("add branch auto-stash on checkout", not "update git UI")

Body rules (only include sections that apply — omit empty sections entirely):
- After the subject line, add a blank line then organize changes into labeled sections
- Use exactly these section headers (no bold, no markdown): "New features", "Bug fixes", "Improvements"
- Under each section, write a tight bullet list (- item)
- Each bullet: describes behavior/capability — what it IS and DOES, not which files changed
- Lead with a verb: "add", "fix", "remove", "prevent", "expose", "allow"
- Lowercase, no trailing punctuation
- No emoji, no filler phrases ("this commit", "various improvements")

Example format:
feat(terminal): add persistent shell sessions with multi-tab support

New features
- add PTY-backed shell sessions that preserve env, cwd, and aliases across commands
- add multi-tab support with Cmd+Shift+N/W/]/[ shortcuts

Bug fixes
- fix echo suppression so the first echoed line is not shown as output

Improvements
- strip ANSI codes for clean readable output without color artifacts`;

      const userPrompt = [
        statusSummary ? `Changed files:\n${statusSummary}` : "",
        diffSection   ? `Diff:\n${diffSection}` : "(no diff — all changes may be untracked)",
        recentCommits ? `Recent commits (for style context):\n${recentCommits}` : "",
        changeDescriptions.length > 0
          ? `Session changes (what the AI assistant did):\n${changeDescriptions.join("\n")}`
          : "",
      ].filter(Boolean).join("\n\n");

      const draft = await punkEngine.quickCall(systemPrompt, userPrompt);
      return { draft: draft.trim() };
    } catch (err) {
      return { draft: "", error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("reveal_in_finder", (_event, args) => {
    shell.showItemInFolder(args.path);
  });
  ipcMain.handle("play_sound", async (_event, args) => {
    const { sound } = args;
    if (sound === "none") return;
    const soundPath = `/System/Library/Sounds/${sound}.aiff`;
    try {
      await execFileAsync("afplay", [soundPath]);
    } catch (error) {
      console.error("Sound playback failed:", error);
    }
  });
  ipcMain.handle("set_window_title", (_event, args) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.setTitle(args.title);
  });
  ipcMain.handle("set_vibrancy", (_event, args) => {
    if (!mainWindow) return;
    mainWindow.setVibrancy(args.vibrancy ?? null);
  });
  ipcMain.handle("open-directory-dialog", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Generic file/folder picker used by the InputBar "add path" button.
  // Returns an array of display strings — relative to projectRoot when the
  // selection is inside it, absolute otherwise.
  ipcMain.handle("show-file-picker", async (_event, { defaultPath, projectRoot } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || undefined,
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths.map((p) => {
      if (projectRoot && p.startsWith(projectRoot + path.sep)) {
        return path.relative(projectRoot, p);
      }
      return p;
    });
  });
  ipcMain.handle("create-directory", async (_event, dirPath) => {
    const resolved = dirPath.startsWith("~/")
      ? path.join(os.homedir(), dirPath.slice(2))
      : dirPath;
    await fs.promises.mkdir(resolved, { recursive: true });
    return resolved;
  });
  ipcMain.handle("get_claude_plan_info", async () => {
    try {
      const claudeConfigPath = path.join(os.homedir(), ".claude.json");
      const configData = await fs.promises.readFile(claudeConfigPath, "utf-8");
      const config = JSON.parse(configData);

      // Infer plan from available fields
      let plan = null;
      const hasSubscription =
        config.oauthAccount?.billingType === "stripe_subscription";
      const hasExtraUsage = config.oauthAccount?.hasExtraUsageEnabled === true;

      if (hasSubscription && hasExtraUsage) {
        // Has paid subscription with extra usage enabled = Max plan
        plan = "Max";
      } else if (hasSubscription) {
        // Has subscription but no extra usage = Pro plan
        plan = "Pro";
      } else {
        // No subscription = Free plan
        plan = "Free";
      }

      return plan;
    } catch (error) {
      // If config doesn't exist or can't be read, return null
      console.warn("Could not read Claude config:", error.message);
      return null;
    }
  });
}
function settingsPath() {
  return path.join(os.homedir(), ".pane", "settings.json");
}
const defaultSettings = {
  project_roots: [],
  active_project_root: null,
  control_panel_visible: true,
  project_states: {},
  font_size: null,
  editor_font_size: null,
  panel_font_size: null,
  font_weight: null,
  keybindings: null,
  theme: null,
  panel_width: null,
  punk_backend: "api",
  http_provider: "deepseek",
  http_api_keys: {},
  http_base_urls: {},
  selected_model: null,
  completion_sound: null,
  intent_routing: null,
  intent_auto_route: true,
};
function registerSettingsHandlers() {
  ipcMain.handle("load_settings", async () => {
    const filePath = settingsPath();
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      return { ...defaultSettings, ...JSON.parse(content) };
    } catch {
      return defaultSettings;
    }
  });
  ipcMain.handle("save_settings", async (_event, args) => {
    const filePath = settingsPath();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    let existing = {};
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      if (content.trim().length > 0) existing = JSON.parse(content);
    } catch {}

    const merged = { ...existing, ...args.settings };
    const json = JSON.stringify(merged, null, 2);

    // Unique tmp path per write — safe against concurrent saves.
    const tmpPath = filePath + ".tmp." + process.hrtime.bigint();
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  });

  // Dock icon switches with theme — clear (glass) = no bg, default = semi-transparent dark, dark = solid dark.
  ipcMain.handle("set_app_theme", (_event, { theme }) => {
    if (!app.dock) return; // non-macOS no-op
    const iconName =
      theme === "glass" ? "icon-glass.png" :
      theme === "dark"  ? "icon-dark.png"  :
                          "icon.png";
    const iconPath = getAssetPath(iconName);
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  });
}
// PTY runs in a UtilityProcess to isolate node-pty crashes from the main process.
// Same pattern as the Claude worker — main process is a zero-cost relay.
let ptyWorker = null;
const activePtyIds = new Set();
function getPtyWorker() {
  if (ptyWorker && !ptyWorker.killed) return ptyWorker;
  const workerPath = path.join(__dirname, "pty-worker.mjs");
  ptyWorker = utilityProcess.fork(workerPath);
  ptyWorker.on("message", (message) => {
    if (message.type === "data") {
      const channel = `pty-data:${message.ptyId}`;
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, message.data);
        }
      }
    } else if (message.type === "exit") {
      activePtyIds.delete(message.ptyId);
      const channel = `pty-exit:${message.ptyId}`;
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, { exitCode: message.exitCode });
        }
      }
    }
  });
  // Crash recovery: if node-pty kills the worker, send synthetic exit to all active PTYs.
  // Ignore exits during app shutdown (ptyWorker already nulled by before-quit handler).
  ptyWorker.on("exit", (code) => {
    if (forceQuit) return;
    console.warn(`[pane] PTY worker exited unexpectedly with code ${code}`);
    for (const ptyId of activePtyIds) {
      const channel = `pty-exit:${ptyId}`;
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, { exitCode: null });
        }
      }
    }
    activePtyIds.clear();
    ptyWorker = null;
  });
  return ptyWorker;
}
function registerPtyHandlers() {
  ipcMain.handle("pty_create", async (_event, args) => {
    const worker = getPtyWorker();
    activePtyIds.add(args.ptyId);
    worker.postMessage({
      type: "create",
      ptyId: args.ptyId,
      projectId: args.projectId,
      cwd: args.cwd,
    });
  });
  ipcMain.handle("pty_write", async (_event, args) => {
    if (ptyWorker && !ptyWorker.killed) {
      ptyWorker.postMessage({
        type: "write",
        ptyId: args.ptyId,
        data: args.data,
      });
    }
  });
  ipcMain.handle("pty_destroy", async (_event, args) => {
    if (ptyWorker && !ptyWorker.killed) {
      ptyWorker.postMessage({ type: "destroy", ptyId: args.ptyId });
    }
    activePtyIds.delete(args.ptyId);
  });
  ipcMain.handle("pty_destroy_project", async (_event, args) => {
    if (ptyWorker && !ptyWorker.killed) {
      ptyWorker.postMessage({
        type: "destroy_project",
        projectId: args.projectId,
      });
    }
  });
}
// Both Claude and PTY run in UtilityProcesses — clean shutdown via postMessage.
// node-pty's SIGABRT bug (vscode#243952) can't crash the main process anymore
// because node-pty lives in the PTY worker, not here.
app.on("before-quit", () => {
  forceQuit = true;
  shutdownPunkWorker();
  if (ptyWorker && !ptyWorker.killed) {
    // Send shutdown and let the worker exit gracefully — it needs time to
    // dispose native ThreadSafeFunction handles before environment teardown.
    // Force-kill only as a fallback if graceful shutdown doesn't complete.
    ptyWorker.postMessage({ type: "shutdown" });
    const workerRef = ptyWorker;
    ptyWorker = null;
    setTimeout(() => {
      if (!workerRef.killed) {
        workerRef.kill();
      }
    }, 500);
  }
  // Shut down brain worker — it holds ONNX embedder memory (~200-400MB)
  // and was previously left to Electron's default cleanup (unreliable).
  if (brainWorker && !brainWorker.killed) {
    brainWorker.postMessage({ type: "shutdown" });
    const brainRef = brainWorker;
    brainWorker = null;
    setTimeout(() => {
      if (!brainRef.killed) brainRef.kill();
    }, 500);
  }
  // Close all chokidar file watchers — persistent watchers keep event loops
  // alive and each holds fs.stat polling intervals via awaitWriteFinish.
  for (const [, watcher] of watchers) {
    watcher.close().catch(() => {});
  }
  watchers.clear();
});
const watchers = /* @__PURE__ */ new Map();
function sendToRenderer(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
function registerWatcherHandlers() {
  ipcMain.handle("watch_directory", async (_event, args) => {
    if (watchers.has(args.path)) return;
    let pendingPaths = /* @__PURE__ */ new Set();
    let debounceTimer = null;
    const flush = () => {
      if (pendingPaths.size > 0) {
        const paths = Array.from(pendingPaths);
        sendToRenderer("pane://file-changed", paths);
        pendingPaths = /* @__PURE__ */ new Set();
      }
      debounceTimer = null;
    };
    const watcher = chokidar.watch(args.path, {
      ignoreInitial: true,
      ignored: [
        /(^|[/\\])\../, // dotfiles (.git, .DS_Store, etc.)
        /node_modules/,
        /\.next\//,
        /dist\//,
        /build\//,
        /out\//,
        /target\//,
        /\.turbo\//,
        /coverage\//,
      ],
      persistent: true,
      usePolling: false,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });
    watcher.on("error", (err) => {
      console.error("Chokidar watcher error:", err.message);
    });
    watcher.on("all", (_eventType, filePath) => {
      pendingPaths.add(filePath);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 800);
    });
    watchers.set(args.path, watcher);
  });
  ipcMain.handle("unwatch_directory", async (_event, args) => {
    const watcher = watchers.get(args.path);
    if (watcher) {
      await watcher.close();
      watchers.delete(args.path);
    }
  });
}
function registerCheckpointHandlers(db) {
  const CHECKPOINT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
  const CHECKPOINT_MAX_FILES = 200;

  function checkpointDir(projectId) {
    return path.join(os.homedir(), ".pane", "checkpoints", projectId);
  }

  ipcMain.handle("create_checkpoint", async (_event, args) => {
    const { projectId, workingDir, messageId } = args;
    const cpId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Must be a git repo
    let headCommit = null;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workingDir,
      });
      headCommit = stdout.trim();
    } catch {
      return { id: null, fileCount: 0 };
    }

    // Get dirty + untracked files
    let porcelain = "";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-unormal"],
        { cwd: workingDir },
      );
      porcelain = stdout;
    } catch {
      return { id: null, fileCount: 0 };
    }

    const entries = [];
    for (const line of porcelain.split("\n")) {
      if (line.length < 4) continue;
      const statusCode = line.slice(0, 2).trim();
      let filePath = line.slice(3);
      const arrowPos = filePath.indexOf(" -> ");
      if (arrowPos !== -1) filePath = filePath.slice(arrowPos + 4);
      entries.push({ relativePath: filePath, gitStatus: statusCode });
    }

    // Read file contents (skip binary, large files)
    const files = [];
    for (const { relativePath, gitStatus } of entries.slice(
      0,
      CHECKPOINT_MAX_FILES,
    )) {
      const fullPath = path.join(workingDir, relativePath);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.size > CHECKPOINT_MAX_FILE_SIZE) continue;
        const buffer = await fs.promises.readFile(fullPath);
        // Binary check: null byte in first 512 bytes
        const checkLen = Math.min(buffer.length, 512);
        let isBinary = false;
        for (let i = 0; i < checkLen; i++) {
          if (buffer[i] === 0) {
            isBinary = true;
            break;
          }
        }
        if (isBinary) continue;
        files.push({
          relativePath,
          content: buffer.toString("utf-8"),
          gitStatus,
        });
      } catch {
        files.push({ relativePath, content: null, gitStatus });
      }
    }

    const checkpoint = {
      id: cpId,
      timestamp: Date.now(),
      projectId,
      headCommit,
      files,
      messageId,
    };
    const dir = checkpointDir(projectId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, `${cpId}.json`),
      JSON.stringify(checkpoint),
      "utf-8",
    );

    // Insert metadata into SQLite
    db.stmts.insertCheckpoint.run(
      cpId, projectId, messageId ?? null,
      checkpoint.timestamp, files.length, headCommit,
    );

    // Keep manifest.json in sync for tool-executor.mjs and pane-mcp-server.mjs
    try {
      const allMeta = db.stmts.listCheckpoints.all(projectId);
      const manifest = allMeta.map(m => ({
        id: m.id,
        timestamp: m.created_at,
        messageId: m.message_id,
        fileCount: m.file_count,
        headCommit: m.head_commit,
        workingDir,
      }));
      await fs.promises.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({ projectId, projectRoot: workingDir, checkpoints: manifest }),
        "utf-8",
      );
    } catch {}

    return {
      id: cpId,
      fileCount: files.length,
      timestamp: checkpoint.timestamp,
    };
  });

  ipcMain.handle("restore_checkpoint", async (_event, args) => {
    const { projectId, checkpointId, workingDir } = args;
    let checkpoint;
    try {
      const raw = await fs.promises.readFile(
        path.join(checkpointDir(projectId), `${checkpointId}.json`),
        "utf-8",
      );
      checkpoint = JSON.parse(raw);
    } catch {
      return {
        success: false,
        error: "Checkpoint not found",
        restoredFiles: [],
      };
    }

    const restored = [];

    // Restore files from checkpoint
    for (const file of checkpoint.files) {
      const fullPath = path.join(workingDir, file.relativePath);
      try {
        if (file.content === null) {
          try {
            await fs.promises.unlink(fullPath);
            restored.push({ path: file.relativePath, action: "deleted" });
          } catch {}
        } else {
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, file.content, "utf-8");
          restored.push({ path: file.relativePath, action: "restored" });
        }
      } catch {}
    }

    // Restore clean tracked files Claude modified (not in checkpoint) from git HEAD
    if (checkpoint.headCommit) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["status", "--porcelain=v1", "-unormal"],
          { cwd: workingDir },
        );
        const cpPaths = new Set(checkpoint.files.map((f) => f.relativePath));
        for (const line of stdout.split("\n")) {
          if (line.length < 4) continue;
          const sc = line.slice(0, 2).trim();
          let fp = line.slice(3);
          const ap = fp.indexOf(" -> ");
          if (ap !== -1) fp = fp.slice(ap + 4);
          if (cpPaths.has(fp)) continue;
          if (sc === "??") {
            restored.push({ path: fp, action: "orphaned_new" });
          } else {
            try {
              await execFileAsync(
                "git",
                ["checkout", checkpoint.headCommit, "--", fp],
                { cwd: workingDir },
              );
              restored.push({ path: fp, action: "git_restored" });
            } catch {}
          }
        }
      } catch {}
    }

    return { success: true, restoredFiles: restored };
  });

  ipcMain.handle("list_checkpoints", (_event, args) => {
    try {
      return db.stmts.listCheckpoints.all(args.projectId).map(m => ({
        id: m.id,
        timestamp: m.created_at,
        messageId: m.message_id,
        fileCount: m.file_count,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle("resume_from_checkpoint", async (_event, args) => {
    const { projectId, sessionId } = args;
    const turns = loadRecentTurns(projectId, sessionId, 1);
    if (turns.length === 0) return null;
    return turns[0];
  });

  ipcMain.handle("get_checkpoint_diff", async (_event, args) => {
    const { projectId, checkpointId, workingDir } = args;
    let checkpoint;
    try {
      const raw = await fs.promises.readFile(
        path.join(checkpointDir(projectId), `${checkpointId}.json`),
        "utf-8",
      );
      checkpoint = JSON.parse(raw);
    } catch {
      return { files: [] };
    }
    const diffs = [];
    for (const file of checkpoint.files) {
      let currentContent = null;
      try {
        currentContent = await fs.promises.readFile(
          path.join(workingDir, file.relativePath),
          "utf-8",
        );
      } catch {}
      if (currentContent !== file.content) {
        diffs.push({
          relativePath: file.relativePath,
          status:
            currentContent === null
              ? "deleted"
              : file.content === null
                ? "created"
                : "modified",
        });
      }
    }
    // Also check for new untracked files not in checkpoint
    if (checkpoint.headCommit) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["status", "--porcelain=v1", "-unormal"],
          { cwd: workingDir },
        );
        const cpPaths = new Set(checkpoint.files.map((f) => f.relativePath));
        for (const line of stdout.split("\n")) {
          if (line.length < 4) continue;
          const sc = line.slice(0, 2).trim();
          let fp = line.slice(3);
          const ap = fp.indexOf(" -> ");
          if (ap !== -1) fp = fp.slice(ap + 4);
          if (!cpPaths.has(fp) && sc !== "??") {
            diffs.push({ relativePath: fp, status: "modified" });
          } else if (!cpPaths.has(fp) && sc === "??") {
            diffs.push({ relativePath: fp, status: "created" });
          }
        }
      } catch {}
    }
    return { files: diffs };
  });

  ipcMain.handle("delete_project_checkpoints", async (_event, args) => {
    try {
      db.stmts.deleteCheckpointsByProject.run(args.projectId);
      await fs.promises.rm(checkpointDir(args.projectId), { recursive: true, force: true });
    } catch {}
  });

  // --- Change History Handlers ---
  // Primary store: SQLite (change_history table).

  ipcMain.handle("record_change", async (_event, args) => {
    const { projectId, filePath, oldString, newString, description, timestamp, workingDir } = args;

    // Normalize to relative path — Claude Code passes absolute paths
    let relFile = filePath;
    if (workingDir && path.isAbsolute(filePath) && filePath.startsWith(workingDir)) {
      relFile = path.relative(workingDir, filePath);
    }

    const id = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.stmts.insertChange.run(
      id, projectId, relFile,
      oldString ?? null, newString ?? "",
      description ?? "", timestamp || Date.now(),
      workingDir ?? null,
    );

    return { id, success: true };
  });

  ipcMain.handle("get_change_history", (_event, args) => {
    const rows = db.stmts.getChanges.all(args.projectId);
    // Return in legacy shape so ChangeHistoryPanel works without changes
    const changes = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      file: r.file_path,
      oldString: r.old_string,
      newString: r.new_string,
      description: r.description,
    }));
    return { changes };
  });

  ipcMain.handle("revert_change", async (_event, args) => {
    const { projectId, changeId, workingDir } = args;

    const row = db.stmts.getChangeById.get(changeId);
    if (!row) return { success: false, error: "Change not found" };

    const resolvedPath = path.isAbsolute(row.file_path)
      ? row.file_path
      : path.join(workingDir, row.file_path);

    try {
      const currentContent = await fs.promises.readFile(resolvedPath, "utf-8");

      if (!currentContent.includes(row.new_string)) {
        return { success: false, error: "File content doesn't match expected change" };
      }

      const revertedContent = currentContent.replace(row.new_string, row.old_string ?? "");
      await fs.promises.writeFile(resolvedPath, revertedContent, "utf-8");

      db.stmts.deleteChangeById.run(changeId);

      return { success: true, output: `Reverted change in ${row.file_path}`, file: row.file_path };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("search_changes", (_event, args) => {
    const { projectId, query, filePath } = args;
    let rows;
    if (filePath && !query) {
      rows = db.stmts.searchChangesByFile.all(projectId, filePath);
    } else if (query) {
      const like = `%${query}%`;
      rows = filePath
        ? db.stmts.searchChangesByFile.all(projectId, filePath).filter(r =>
            r.description?.toLowerCase().includes(query.toLowerCase()) ||
            r.new_string?.toLowerCase().includes(query.toLowerCase()) ||
            r.old_string?.toLowerCase().includes(query.toLowerCase())
          )
        : db.stmts.searchChanges.all(projectId, like, like, like, like);
    } else {
      rows = db.stmts.getChanges.all(projectId);
    }
    const changes = rows.map(r => ({
      id: r.id, timestamp: r.timestamp, file: r.file_path,
      oldString: r.old_string, newString: r.new_string, description: r.description,
    }));
    return { changes };
  });

  ipcMain.handle("delete_change_history", async (_event, args) => {
    const { projectId } = args;
    try {
      db.stmts.deleteAllChanges.run(projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// --- State + Memory handlers for Pane Intelligence Layer ---
// Writes state to ~/.pane/state/{projectId}/ for the MCP server to read.
// Writes memory to ~/.pane/memory/{projectId}/ for cross-session persistence.
function registerStateHandlers(db) {
  function upsertBlob(projectId, key, data) {
    db.stmts.upsertBlob.run(projectId, key, JSON.stringify(data), Date.now());
  }

  function readBlob(projectId, key) {
    const row = db.stmts.getBlob.get(projectId, key);
    return row ? JSON.parse(row.data) : null;
  }

  ipcMain.handle("write_editor_state", (_event, args) => {
    upsertBlob(args.projectId, "editor", args.data);
  });

  ipcMain.handle("write_terminal_state", (_event, args) => {
    upsertBlob(args.projectId, "terminal", args.data);
  });

  // Atomically appends one completed command to the shared multi-tab terminal history.
  // better-sqlite3 is synchronous — no concurrent write races possible.
  ipcMain.handle("append_terminal_command", (_event, { projectId, entry }) => {
    let data = readBlob(projectId, "terminal") ?? { commands: [] };
    if (!Array.isArray(data.commands)) data.commands = [];
    // Remove stale partial entry for this tab (command just finished)
    data.commands = data.commands.filter(
      (c) => !(c.tabId === entry.tabId && c.partial === true),
    );
    data.commands.push(entry);
    data.commands = data.commands.slice(-50);
    upsertBlob(projectId, "terminal", data);
  });

  // Returns the stored terminal history for a project (last 50 commands).
  ipcMain.handle("get_terminal_history", (_event, { projectId }) => {
    const data = readBlob(projectId, "terminal") ?? { commands: [] };
    return { commands: Array.isArray(data.commands) ? data.commands.filter((c) => !c.partial) : [] };
  });

  // Upserts a live snapshot for a long-running command.
  ipcMain.handle("update_terminal_running", (_event, { projectId, entry }) => {
    let data = readBlob(projectId, "terminal") ?? { commands: [] };
    if (!Array.isArray(data.commands)) data.commands = [];
    const idx = data.commands.findIndex(
      (c) => c.tabId === entry.tabId && c.partial === true,
    );
    if (idx !== -1) {
      data.commands[idx] = entry;
    } else {
      data.commands.push(entry);
      data.commands = data.commands.slice(-50);
    }
    upsertBlob(projectId, "terminal", data);
  });

  ipcMain.handle("write_project_state", (_event, args) => {
    upsertBlob(args.projectId, "project", args.data);
  });

  // save_conversation: accepts projectId instead of filePath.
  // Upserts the renderer's in-memory slice — INSERT OR REPLACE handles both
  // new messages and streaming updates. Rows in the DB outside the renderer's
  // slice (the history prefix) are untouched; no prefix-merge needed.
  ipcMain.handle("save_conversation", (_event, args) => {
    const { projectId, conversation } = args;
    const { model, messages } = conversation;

    const save = db.transaction(() => {
      for (const msg of messages) {
        const id = msg.id || `msg-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const contentJson = JSON.stringify(msg);
        db.stmts.insertMessage.run(
          id, projectId, msg.type ?? "assistant",
          contentJson,
          msg.created_at ?? msg.timestamp ?? Date.now(),
          msg.cost_usd ?? null, msg.duration_ms ?? null,
          msg.input_tokens ?? null, msg.output_tokens ?? null,
          msg.checkpoint_id ?? null, msg.model ?? null, msg.num_turns ?? null,
        );
        // Keep FTS in sync: delete old entry (if any), insert fresh
        const text = extractMessageText(contentJson);
        if (text) {
          db.stmts.deleteFts.run(id);
          db.stmts.insertFts.run(projectId, id, text);
        }
      }
      db.stmts.upsertConvMeta.run(projectId, null, model ?? null, Date.now());
    });

    try {
      save();
    } catch (e) {
      console.error("[pane-db] save_conversation error:", e.message);
    }
  });

  // Returns a slice of messages from SQLite — sub-millisecond indexed query
  // regardless of total conversation size.
  ipcMain.handle("get_conversation_slice", (_event, { projectId, beforeIndex, count }) => {
    const _t = Date.now();
    try {
      const totalCount = db.stmts.countMessages.get(projectId).cnt;
      const end = (beforeIndex != null && beforeIndex >= 0) ? beforeIndex : totalCount;
      const start = Math.max(0, end - count);
      const rows = db.stmts.selectMessagesSlice.all(projectId, end - start, start);
      const meta = db.stmts.getConvMeta.get(projectId);
      const result = {
        messages: rows.map(r => JSON.parse(r.content)),
        totalCount,
        startIndex: start,
        model: meta?.model ?? null,
      };
      return result;
    } catch {
      return { messages: [], totalCount: 0, startIndex: 0, model: null };
    }
  });

  // Full-text search across conversation messages using FTS5.
  // projectId = null searches all projects. Results are ranked by relevance.
  ipcMain.handle("search_conversations", (_event, { query, projectId = null, limit = 20 }) => {
    try {
      if (!query?.trim()) return { results: [] };
      const rows = db.stmts.searchMessages.all({ query: query.trim(), projectId, limit });
      return {
        results: rows.map(r => ({
          message: JSON.parse(r.content),
          projectId: r.project_id,
        })),
      };
    } catch (e) {
      console.error("[pane-db] search_conversations error:", e.message);
      return { results: [] };
    }
  });
}

function registerMemoryHandlers() {
  const MEMORY_MAX_EVENTS = 500;

  function memoryDir(projectId) {
    return path.join(os.homedir(), ".pane", "memory", projectId);
  }

  ipcMain.handle("record_memory_events", async (_event, args) => {
    const { projectId, events } = args;
    const dir = memoryDir(projectId);
    await fs.promises.mkdir(dir, { recursive: true });

    // Deduplicate against last 20 lines in the existing events file
    const eventsFilePath = path.join(dir, "events.jsonl");
    const recentKeys = new Set();
    try {
      const existing = await fs.promises.readFile(eventsFilePath, "utf-8");
      const allLines = existing.trim().split("\n").filter(Boolean);
      const last20 = allLines.slice(-20);
      for (const line of last20) {
        try {
          const e = JSON.parse(line);
          recentKeys.add(`${e.type}:${e.content}`);
        } catch {}
      }
    } catch {}

    const dedupedEvents = events.filter((e) => !recentKeys.has(`${e.type}:${e.content}`));
    if (dedupedEvents.length === 0) return;

    const lines = dedupedEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.promises.appendFile(
      eventsFilePath,
      lines,
      "utf-8",
    );

    // Prune to last N events
    try {
      const content = await fs.promises.readFile(eventsFilePath, "utf-8");
      const allLines = content.trim().split("\n").filter(Boolean);
      if (allLines.length > MEMORY_MAX_EVENTS) {
        const pruned = allLines.slice(-MEMORY_MAX_EVENTS).join("\n") + "\n";
        await fs.promises.writeFile(eventsFilePath, pruned, "utf-8");
      }
    } catch {}
  });

  ipcMain.handle("generate_brief", async (_event, args) => {
    const { projectId } = args;
    const dir = memoryDir(projectId);
    const eventsPath = path.join(dir, "events.jsonl");
    let content;
    try {
      content = await fs.promises.readFile(eventsPath, "utf-8");
    } catch {
      return "";
    }

    const events = content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Take last 50 events for the brief
    const recent = events.slice(-50);
    if (recent.length === 0) return "";

    // Group by type
    const decisions = recent.filter((e) => e.type === "decision");
    const lessons = recent.filter((e) => e.type === "lesson");
    const errors = recent.filter((e) => e.type === "error");
    const errorFixes = recent.filter((e) => e.type === "error_fix");
    const fileEdits = recent.filter((e) => e.type === "file_edit");
    const commands = recent.filter((e) => e.type === "command");
    const summaries = recent.filter((e) => e.type === "summary");

    const parts = ["## Pane Project Memory"];

    if (decisions.length > 0) {
      parts.push("\n### Recent decisions");
      // Deduplicate similar decisions
      const seen = new Set();
      for (const d of decisions.slice(-8)) {
        const key = d.content.slice(0, 50).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          parts.push(`- ${d.content}`);
        }
      }
    }

    if (lessons.length > 0) {
      parts.push("\n### Lessons learned");
      for (const l of lessons.slice(-5)) parts.push(`- ${l.content}`);
    }

    if (errorFixes.length > 0) {
      parts.push("\n### Error fixes");
      for (const e of errorFixes.slice(-3)) parts.push(`- ${e.content}`);
    } else if (errors.length > 0) {
      parts.push("\n### Recent errors");
      for (const e of errors.slice(-3)) parts.push(`- ${e.content}`);
    }

    // Count file edit frequency
    if (fileEdits.length > 0) {
      const fileCounts = {};
      for (const e of fileEdits) {
        const file = e.metadata?.file || "unknown";
        fileCounts[file] = (fileCounts[file] || 0) + 1;
      }
      const sorted = Object.entries(fileCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      parts.push("\n### Frequently modified files");
      for (const [file, count] of sorted)
        parts.push(`- ${file} (${count} edits)`);
    }

    // Command frequency — group by base command, show counts
    if (commands.length > 0) {
      const cmdCounts = {};
      for (const e of commands) {
        // Normalize: take first 60 chars or first line as the key
        const cmd = (e.content || "").split("\n")[0].slice(0, 60);
        cmdCounts[cmd] = (cmdCounts[cmd] || 0) + 1;
      }
      const sorted = Object.entries(cmdCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (sorted.length > 0) {
        parts.push("\n### Recent commands");
        for (const [cmd, count] of sorted) {
          parts.push(`- ${cmd}${count > 1 ? ` (${count}x)` : ""}`);
        }
      }
    }

    // Multi-summary rollup — combine last 3 summaries for richer context
    if (summaries.length > 0) {
      const recentSummaries = summaries.slice(-3);
      if (recentSummaries.length === 1) {
        parts.push("\n### Last session summary");
        parts.push(recentSummaries[0].content);
      } else {
        parts.push("\n### Recent session summaries");
        for (let i = 0; i < recentSummaries.length; i++) {
          const label =
            i === recentSummaries.length - 1 ? "Latest" : `Previous`;
          const summary = recentSummaries[i].content;
          // Truncate each to ~200 chars to leave room
          parts.push(
            `**${label}:** ${summary.length > 400 ? summary.slice(0, 400) + "..." : summary}`,
          );
        }
      }
    }

    let brief = parts.join("\n");

    // Section-aware truncation: cap at 6000 chars, break at last ### boundary
    if (brief.length > 6000) {
      const truncated = brief.slice(0, 6000);
      const lastSection = truncated.lastIndexOf("\n###");
      if (lastSection > 500) {
        brief = truncated.slice(0, lastSection);
      } else {
        brief = truncated;
      }
    }

    // Write brief to disk
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "brief.md"), brief, "utf-8");

    return brief;
  });

  ipcMain.handle("read_brief", async (_event, args) => {
    const { projectId } = args;
    try {
      return await fs.promises.readFile(
        path.join(memoryDir(projectId), "brief.md"),
        "utf-8",
      );
    } catch {
      return "";
    }
  });

  ipcMain.handle("get_project_why", async (_event, args) => {
    const { projectId } = args;
    try {
      const content = await fs.promises.readFile(
        path.join(memoryDir(projectId), "why.md"),
        "utf-8",
      );
      return content.trim() || null;
    } catch {
      return null;
    }
  });

  // LLM-based preference extraction — runs after each conversation turn.
  // Takes the last user+assistant exchange and asks the model to extract
  // structured preferences: tools, patterns, corrections. Much richer than regex.
  ipcMain.handle("brain_extract_preferences_llm", async (_event, args) => {
    const { turnText } = args;
    if (!turnText || turnText.length < 100) return null;

    const system = `You extract preferences and patterns from conversations between a developer and an AI assistant.
Focus on what the DEVELOPER prefers, values, or corrects — not the AI's suggestions.
Return ONLY valid JSON. No explanation, no markdown, just the JSON object.`;

    const prompt = `CONVERSATION TURN:
${turnText.slice(0, 3000)}

Extract preferences the developer expressed. Look for:
- Tools, libraries, frameworks they chose or avoided
- Coding/design patterns they enforce
- Things they corrected the AI toward
- Ways of working they clearly prefer

Return JSON:
{
  "tools": [{"name": "string", "prefers": true/false, "evidence": "short quote"}],
  "patterns": [{"pattern": "string", "evidence": "short quote"}],
  "corrections": [{"toward": "string", "away_from": "string", "evidence": "short quote"}]
}

Only include items with clear evidence. Empty arrays if nothing found.`;

    try {
      const raw = await punkEngine.quickCall(system, prompt);
      // Strip any markdown fences the model might add
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const extracted = JSON.parse(cleaned);

      // Forward to brain-engine to persist into preferences.json
      if (extracted && (extracted.tools?.length || extracted.patterns?.length || extracted.corrections?.length)) {
        await brainRequest("update_preferences_from_llm", { extracted });
      }
      return extracted;
    } catch {
      // LLM extraction is non-critical — never surface failures
      return null;
    }
  });
}

// --- Session Context (per-project active state for context compilation) ---
// Dual-write: SQLite (state_blobs key='session') + file on disk.
// session-context.mjs runs in UtilityProcess workers and reads the file directly
// with fs.readFileSync — we keep the file in sync so it never needs to change.
function registerSessionHandlers(db) {
  const SESSION_DIR = path.join(os.homedir(), ".pane", "session");

  function writeSessionFile(projectId, state) {
    const stateDir = path.join(SESSION_DIR, projectId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }

  ipcMain.handle("session_merge_state", (_event, args) => {
    const { projectId, delta } = args;

    const row = db.stmts.getBlob.get(projectId, "session");
    let current = row ? JSON.parse(row.data) : {
      activeTask: null, workingSet: [], decisions: [],
      recentActions: [], turnCount: 0, lastProvider: null, lastIntent: null,
      startedAt: Date.now(),
    };

    if (delta.activeTask !== undefined) {
      current.activeTask = delta.activeTask ? { ...current.activeTask, ...delta.activeTask } : null;
    }
    if (delta.workingSet?.length) {
      for (const file of delta.workingSet) {
        const idx = current.workingSet.findIndex(f => f.path === file.path);
        if (idx >= 0) {
          current.workingSet[idx] = { ...current.workingSet[idx], ...file, touches: (current.workingSet[idx].touches || 0) + 1 };
        } else {
          current.workingSet.push({ ...file, touches: 1 });
        }
      }
      current.workingSet.sort((a, b) => (b.touches || 0) - (a.touches || 0));
      current.workingSet = current.workingSet.slice(0, 10);
    }
    if (delta.decisions?.length) {
      for (const d of delta.decisions) {
        const key = d.content.slice(0, 60).toLowerCase();
        const dupe = current.decisions.some(x => x.content.slice(0, 60).toLowerCase() === key);
        if (!dupe) current.decisions.unshift({ content: d.content, timestamp: Date.now() });
      }
      current.decisions = current.decisions.slice(0, 8);
    }
    if (delta.recentActions?.length) {
      current.recentActions = [...delta.recentActions, ...current.recentActions].slice(0, 8);
    }
    if (delta.turnCount !== undefined) current.turnCount = delta.turnCount;
    if (delta.lastProvider) current.lastProvider = delta.lastProvider;
    if (delta.lastIntent)   current.lastIntent = delta.lastIntent;
    if (delta.gitStatus !== undefined) current.gitStatus = delta.gitStatus;
    if (delta.todos !== undefined)     current.todos = delta.todos;

    db.stmts.upsertBlob.run(projectId, "session", JSON.stringify(current), Date.now());
    writeSessionFile(projectId, current); // keep file in sync for UtilityProcess readers
    return current;
  });

  ipcMain.handle("session_clear_state", (_event, args) => {
    const { projectId } = args;
    const blank = { activeTask: null, todos: [], workingSet: [], decisions: [], recentActions: [],
      turnCount: 0, lastProvider: null, lastIntent: null, startedAt: Date.now() };
    db.stmts.upsertBlob.run(projectId, "session", JSON.stringify(blank), Date.now());
    writeSessionFile(projectId, blank);
    return blank;
  });

  ipcMain.handle("session_read_state", (_event, args) => {
    const row = db.stmts.getBlob.get(args.projectId, "session");
    return row ? JSON.parse(row.data) : null;
  });
}

// --- Brain Engine (knowledge graph + embeddings + semantic search) ---
let brainWorker = null;
const brainPendingRequests = new Map();
let brainRequestCounter = 0;
let brainWorkerExitCount = 0;
let brainWorkerLastExitTime = 0;
let brainWorkerDisabled = false;
const BRAIN_BACKOFF_WINDOW_MS = 30_000; // 30s
const BRAIN_BACKOFF_THRESHOLD = 3;     // disable after 3 crashes in window
const BRAIN_SURVIVE_RESET_MS  = 60_000; // reset counter if worker lives 60s

function getBrainWorker() {
  if (brainWorker && !brainWorker.killed) return brainWorker;

  // Backoff: if the worker has crashed repeatedly in a short window, stop
  // re-forking — a rapid crash loop leaks memory and consumes CPU.
  if (brainWorkerDisabled) {
    const timeSince = Date.now() - brainWorkerLastExitTime;
    if (timeSince < BRAIN_BACKOFF_WINDOW_MS) return null;
    // Enough time has passed — try once more
    console.log("[pane] Brain worker backoff elapsed, retrying...");
    brainWorkerDisabled = false;
    brainWorkerExitCount = 0;
  }

  const workerPath = path.join(__dirname, "brain-engine.mjs");
  brainWorker = utilityProcess.fork(workerPath);

  // Track whether this instance survives long enough to reset the crash counter
  const spawnTime = Date.now();
  const surviveTimer = setTimeout(() => {
    if (brainWorker && !brainWorker.killed) {
      brainWorkerExitCount = 0;
      brainWorkerDisabled = false;
    }
  }, BRAIN_SURVIVE_RESET_MS);
  if (surviveTimer.unref) surviveTimer.unref();

  brainWorker.on("message", (message) => {
    // Route responses back to pending IPC requests
    if (message.requestId && brainPendingRequests.has(message.requestId)) {
      const resolve = brainPendingRequests.get(message.requestId);
      brainPendingRequests.delete(message.requestId);
      resolve(message);
    }
    // LLM call relay: brain asks main to run a quickCall through the user's
    // active backend + model — same path as commit drafts, summaries, etc.
    if (message.type === "llm_call") {
      punkEngine.quickCall(message.systemPrompt, message.userPrompt)
        .then(result => {
          brainWorker?.postMessage({ type: "llm_call_result", callId: message.callId, result });
        })
        .catch(err => {
          console.warn(`[pane] Brain LLM relay failed: ${err.message}`);
          brainWorker?.postMessage({ type: "llm_call_result", callId: message.callId, result: null });
        });
    }
    // Forward tension alerts to renderer
    if (message.type === "tensions_detected") {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("brain:tensions", message);
        }
      }
    }
  });

  brainWorker.on("exit", (code) => {
    console.warn(`[pane] Brain worker exited with code ${code}`);
    brainWorker = null;
    brainWorkerLastExitTime = Date.now();
    brainWorkerExitCount++;
    if (brainWorkerExitCount >= BRAIN_BACKOFF_THRESHOLD) {
      brainWorkerDisabled = true;
      console.warn(`[pane] Brain worker disabled after ${brainWorkerExitCount} crashes — will retry in ${BRAIN_BACKOFF_WINDOW_MS / 1000}s`);
    }
    // Reject pending requests
    for (const [id, resolve] of brainPendingRequests) {
      resolve({ type: "error", error: "Brain worker exited" });
    }
    brainPendingRequests.clear();
  });

  return brainWorker;
}

function brainRequest(type, data, timeout = 30000) {
  return new Promise((resolve) => {
    const worker = getBrainWorker();
    if (!worker) {
      // Worker is in backoff — resolve immediately so callers don't hang
      resolve({ type: "error", error: "Brain worker temporarily disabled (crash backoff)" });
      return;
    }
    const requestId = `brain-${++brainRequestCounter}`;
    brainPendingRequests.set(requestId, resolve);
    worker.postMessage({ type, requestId, ...data });
    // Timeout to prevent hanging if worker dies without clearing pending map
    setTimeout(() => {
      if (brainPendingRequests.has(requestId)) {
        brainPendingRequests.delete(requestId);
        resolve({ type: "error", error: "Brain request timed out" });
      }
    }, timeout);
  });
}

function registerBrainHandlers() {
  ipcMain.handle("brain_index_events", async (_event, args) => {
    const { projectId, events } = args;
    return brainRequest("index_events", { projectId, events });
  });

  ipcMain.handle("brain_search", async (_event, args) => {
    const { query, projectId, limit } = args;
    return brainRequest("search", { query, projectId, limit });
  });

  ipcMain.handle("brain_contextual_search", async (_event, args) => {
    const { projectId, query, fileContext, intent, projectRoot, taskType, atomHints, projectWhy } = args;
    // Auto-trigger file indexing fire-and-forget when projectRoot is known.
    // brain-engine deduplicates via indexedProjects Set — safe to call every time.
    if (projectRoot) {
      brainRequest("index_project_files", { projectId, projectRoot }).catch(() => {});
    }
    return brainRequest("contextual_search", { projectId, query, fileContext, intent, projectRoot: projectRoot || null, taskType: taskType || null, atomHints: atomHints || [], projectWhy: projectWhy || "" });
  });

  ipcMain.handle("brain_session_pins_clear", async (_event, args) => {
    const { projectId } = args;
    return brainRequest("session_pins_clear", { projectId });
  });

  ipcMain.handle("brain_index_project_files", async (_event, args) => {
    const { projectId, projectRoot } = args;
    return brainRequest("index_project_files", { projectId, projectRoot });
  });

  ipcMain.handle("brain_get_related", async (_event, args) => {
    const { nodeId } = args;
    return brainRequest("get_related", { nodeId });
  });

  ipcMain.handle("brain_get_stats", async () => {
    return brainRequest("get_stats", {});
  });

  ipcMain.handle("brain_get_intelligence_stats", async (_event, args) => {
    const { projectId } = args;
    return brainRequest("get_intelligence_stats", { projectId });
  });

  ipcMain.handle("brain_get_profile", async () => {
    return brainRequest("get_profile", {});
  });

  ipcMain.handle("brain_add_rule", async (_event, args) => {
    return brainRequest("add_rule", { rule: args.rule });
  });

  ipcMain.handle("brain_update_philosophy", async (_event, args) => {
    return brainRequest("update_philosophy", { text: args.text });
  });

  ipcMain.handle("brain_update_rules", async (_event, args) => {
    return brainRequest("update_rules", { text: args.text });
  });

  ipcMain.handle("brain_extract_profile", async () => {
    return brainRequest("extract_profile", {});
  });

  ipcMain.handle("brain_update_identity", async (_event, args) => {
    return brainRequest("update_identity", { identity: args.identity });
  });

  ipcMain.handle("brain_save_avatar", async (_event, args) => {
    return brainRequest("save_avatar", {
      base64Data: args.base64Data,
      mimeType: args.mimeType,
    });
  });

  ipcMain.handle("brain_get_avatar", async () => {
    return brainRequest("get_avatar", {});
  });

  ipcMain.handle("brain_mind_add", async (_event, args) => {
    const result = await brainRequest("mind_add", { content: args.content, projectId: args.projectId || null });
    return result;
  });

  ipcMain.handle("brain_mind_get_all", async () => {
    return brainRequest("mind_get_all", {});
  });

  ipcMain.handle("brain_mind_update", async (_event, args) => {
    return brainRequest("mind_update", { id: args.id, content: args.content, completed: args.completed });
  });

  ipcMain.handle("brain_mind_delete", async (_event, args) => {
    return brainRequest("mind_delete", { id: args.id });
  });

  ipcMain.handle('brain_mind_thread_create', async (_event, args) => brainRequest('mind_thread_create', {entry_id: args.entryId}));
  ipcMain.handle('brain_mind_thread_get', async (_event, args) => brainRequest('mind_thread_get', {entry_id: args.entryId}));
  ipcMain.handle('brain_mind_thread_list_entry_ids', async () => brainRequest('mind_thread_list_entry_ids', {}));
  ipcMain.handle('brain_mind_thread_add_turn', async (_event, args) => brainRequest('mind_thread_add_turn', {thread_id: args.threadId, role: args.role, content_json: args.contentJson}));
  ipcMain.handle('brain_mind_thread_set_session', async (_event, args) => brainRequest('mind_thread_set_session', {thread_id: args.threadId, session_id: args.sessionId}));
  ipcMain.handle('brain_mind_thread_delete', async (_event, args) => brainRequest('mind_thread_delete', {id: args.id}));

  // On-demand punk review: user triggers from Lens UI
  ipcMain.handle('run_review', async (_event, args) => {
    if (!mindPunks || !args.projectId) return { started: false };
    // Fire-and-forget — results come via pane://review-complete event
    mindPunks.runReview(args.projectId, args.workingDir).catch(err => {
      console.error("[review] failed:", err.message);
      sendToRenderer("pane://review-complete", {
        projectId: args.projectId, sessionId: null, error: err.message, findings: [],
      });
    });
    return { started: true };
  });

  // Review data queries
  ipcMain.handle('review_findings_list', async (_event, args) => {
    return brainRequest('review_findings_list', { sessionId: args.sessionId });
  });
  ipcMain.handle('review_sessions_list', async (_event, args) => {
    return brainRequest('review_sessions_list', { projectId: args.projectId });
  });
  ipcMain.handle('review_session_latest', async (_event, args) => {
    return brainRequest('review_session_latest', { projectId: args.projectId });
  });

  ipcMain.handle('lens_post_add', async (_event, args) => {
    const result = await brainRequest('lens_post_add', { contributor: args.contributor, content: args.content, projectId: args.projectId ?? null, entryId: args.entryId ?? null });
    return result?.post ?? null;
  });

  ipcMain.handle('lens_posts_list', async (_event, args) => {
    const result = await brainRequest('lens_posts_list', { projectId: args.projectId ?? null });
    return result?.posts ?? [];
  });

  ipcMain.handle('lens_post_delete', async (_event, args) => {
    await brainRequest('lens_post_delete', { postId: args.postId });
    return { success: true };
  });

  ipcMain.handle('lens_comments_list', async (_event, args) => {
    const result = await brainRequest('lens_comments_list', { postId: args.postId });
    return result?.comments ?? [];
  });

  ipcMain.handle('lens_comment_add', async (_event, args) => {
    const result = await brainRequest('lens_comment_add', { postId: args.postId, role: args.role, content: args.content });
    return result?.comment ?? null;
  });

  ipcMain.handle('lens_comment_set_session', async (_event, args) => {
    await brainRequest('lens_comment_set_session', { postId: args.postId, sessionId: args.sessionId });
  });

}

async function registerIpcHandlers() {
  let db = null;
  try {
    const { initPaneDb } = await import("./pane-db.mjs");
    db = initPaneDb();
    console.log("[main] Database initialized successfully");
  } catch (err) {
    console.error("[main] Failed to initialize database:", err.message);
    console.error("[main] App will continue with limited functionality");
    // Create a mock db object to prevent crashes
    db = { stmts: {} };
  }

  registerCommandHandlers();
  registerSettingsHandlers();
  await registerClaudeHandlers();
  registerWatcherHandlers();
  registerPtyHandlers();
  registerCheckpointHandlers(db);
  registerStateHandlers(db);
  registerMemoryHandlers();
  registerSessionHandlers(db);
  registerBrainHandlers();
}
let mainWindow = null;
const isDev = !!process.env.ELECTRON_RENDERER_URL;
console.log('[DEBUG] ELECTRON_RENDERER_URL:', process.env.ELECTRON_RENDERER_URL);
console.log('[DEBUG] isDev:', isDev);
function getAssetPath(...paths) {
  return isDev
    ? path.join(__dirname, "../../electron/assets", ...paths)
    : path.join(process.resourcesPath, "assets", ...paths);
}
function createWindow() {
  const windowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800,
  });
  const iconPath = getAssetPath("icon.png");
  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    transparent: true,
    backgroundColor: "#00000000",
    title: "Pane",
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  windowState.manage(mainWindow);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("close", (e) => {
    if (isMac && !forceQuit) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

}
// Single-instance lock — required for Windows deep link (second-instance event).
// Skip in dev: the production app may already hold the lock, which would
// cause the dev build to quit immediately with no visible error.
if (!isDev) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  }
}

// GPU rasterization — hardware-accelerates tile rasterization so scroll stays
// smooth even in content-heavy views (long conversation lists, code blocks).
// Without this, Chromium falls back to CPU rasterization which can stall for
// 1-2s per tile on complex DOM. Must be called before app.whenReady().
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('num-raster-threads', '4');

app.whenReady().then(async () => {
  await registerIpcHandlers();
  modelManager.initialize();
  createWindow();
  preforkPunkWorker(); // Pre-fork to hide first-use latency
  getPtyWorker();
  getBrainWorker(); // Pre-fork: start loading SQLite + embedding model

  // Wire brain contextual search into punk-engine so it fires every turn.
  // This is the critical link: brain searches the knowledge graph for query-
  // relevant context and writes it to disk BEFORE compileContext() reads it.
  punkEngine.setBrainSearch(async args => {
    const { projectId, query, taskType, atomHints, projectRoot, intent, projectWhy } = args;
    if (projectRoot) {
      brainRequest("index_project_files", { projectId, projectRoot }).catch(() => {});
    }
    // Memory lifecycle: decay unused memories, consolidate patterns, graduate principles.
    // Fire-and-forget — runs in the brain worker, doesn't block the context search.
    // enableConsolidation: true only 10% of the time (LLM calls are expensive).
    brainRequest("memory_lifecycle", {
      projectId,
      enableConsolidation: Math.random() < 0.1,
    }).catch(() => {});

    const result = await brainRequest("contextual_search", {
      projectId,
      query,
      fileContext: null,
      intent:      intent || null,
      projectRoot: projectRoot || null,
      taskType:    taskType || null,
      atomHints:   atomHints || [],
      projectWhy:  projectWhy || "",
    });
    // Update in-memory ContextStore — context-orchestrator reads from here
    // instead of the stale JSON file. Disk write still happens in brain-engine
    // as crash recovery backup.
    if (result && result.type !== "error") {
      contextStore.updateBrainExport(projectId, result);
    }
    return result;
  });

  punkEngine.setBrainRequest((type, data) => brainRequest(type, data));

  punkEngine.setBrainIndexer((projectId, events) =>
    brainRequest("index_events", { projectId, events })
  );

  // Mind punks: background intelligence with personality that acts on thoughts
  // Variable is used by brain_mind_add handler declared earlier in this scope,
  // but only called at runtime after this initialization completes.
  /* eslint-disable-next-line no-use-before-define -- runtime order is safe */
  mindPunks = new MindPunks({
    brainRequest,
    quickCall: (sys, usr) => punkEngine.quickCall(sys, usr),
    agentCall: (sys, prompt, workingDir) => punkEngine.agentCall(sys, prompt, workingDir),
    sendToRenderer,
  });

  // Daily backup at midnight — silent, automatic, 7-day rotation + cloud push
  startBackupSchedule();

  // Pane Cloud — GitHub OAuth, encrypted backups, cross-device sync
  initCloudAuth(mainWindow);
  registerCloudSyncHandlers();

  app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
function getMainWindow() {
  return mainWindow;
}
export { getMainWindow };
