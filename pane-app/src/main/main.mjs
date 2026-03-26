import path from "node:path";
import {
  ipcMain,
  BrowserWindow,
  shell,
  dialog,
  app,
  utilityProcess,
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
import { MindWorkers } from "./mind-workers.mjs";
const __dirname = import.meta.dirname;
const isMac = process.platform === "darwin";
let forceQuit = false;
let mindWorkers = null;
// Punk engine runs in a UtilityProcess to keep the main thread free.
// Main process is a thin relay — never touches JSON.parse or model output.
async function registerClaudeHandlers() {
  // Punk is the default engine; keep these names for backwards compatibility.
  await registerPunkHandlers();
  ipcMain.handle("send_to_claude", async (_event, args) => {
    const { projectId, prompt, workingDir, sessionId, model, intent } = args;
    await punkEngine.spawn({
      projectId,
      prompt,
      workingDir,
      sessionId,
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

  const SCROLL_POSITIONS_PATH = path.join(os.homedir(), ".pane", "scroll-positions.json");
  ipcMain.handle("load_scroll_positions", async () => {
    try {
      const content = await fs.promises.readFile(SCROLL_POSITIONS_PATH, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  });
  ipcMain.handle("save_scroll_positions", async (_event, args) => {
    await fs.promises.mkdir(path.dirname(SCROLL_POSITIONS_PATH), { recursive: true });
    await fs.promises.writeFile(SCROLL_POSITIONS_PATH, JSON.stringify(args.positions), "utf-8");
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
        const historyFile = path.join(os.homedir(), ".pane", "change-history", projectId, "changes.json");
        const changes = JSON.parse(await fs.promises.readFile(historyFile, "utf-8"));
        for (const c of changes.slice(-40)) {
          if (c.description) changeDescriptions.push(`- ${c.file}: ${c.description}`);
          else if (c.file) changeDescriptions.push(`- modified ${c.file}`);
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
  ipcMain.handle("open-directory-dialog", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
  http_api_key: "",
  http_base_url: "",
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
        if (mindWorkers) mindWorkers.onFilesChanged(paths);
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
function registerCheckpointHandlers() {
  const CHECKPOINT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
  const CHECKPOINT_MAX_FILES = 200;
  const CHECKPOINT_KEEP = 50;

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

    // Prune old checkpoints
    try {
      const all = (await fs.promises.readdir(dir))
        .filter((f) => f.startsWith("cp-") && f.endsWith(".json"))
        .sort();
      if (all.length > CHECKPOINT_KEEP) {
        const remove = all.slice(0, all.length - CHECKPOINT_KEEP);
        await Promise.all(
          remove.map((f) =>
            fs.promises.unlink(path.join(dir, f)).catch(() => {}),
          ),
        );
      }
    } catch {}

    // Update manifest for external tools (punk-records reads this)
    try {
      const remaining = (await fs.promises.readdir(dir))
        .filter((f) => f.startsWith("cp-") && f.endsWith(".json"))
        .sort();
      const manifest = [];
      for (const f of remaining) {
        try {
          const raw = await fs.promises.readFile(path.join(dir, f), "utf-8");
          const cp = JSON.parse(raw);
          manifest.push({
            id: cp.id,
            timestamp: cp.timestamp,
            messageId: cp.messageId,
            fileCount: cp.files.length,
            headCommit: cp.headCommit,
            workingDir,
          });
        } catch {}
      }
      await fs.promises.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          projectId,
          projectRoot: workingDir,
          checkpoints: manifest,
        }),
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

  ipcMain.handle("list_checkpoints", async (_event, args) => {
    const { projectId } = args;
    try {
      const entries = await fs.promises.readdir(checkpointDir(projectId));
      const metas = [];
      for (const entry of entries) {
        if (!entry.startsWith("cp-") || !entry.endsWith(".json")) continue;
        try {
          const raw = await fs.promises.readFile(
            path.join(checkpointDir(projectId), entry),
            "utf-8",
          );
          const cp = JSON.parse(raw);
          metas.push({
            id: cp.id,
            timestamp: cp.timestamp,
            messageId: cp.messageId,
            fileCount: cp.files.length,
          });
        } catch {}
      }
      metas.sort((a, b) => a.timestamp - b.timestamp);
      return metas;
    } catch {
      return [];
    }
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
      await fs.promises.rm(checkpointDir(args.projectId), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  // --- Change History Handlers ---
  function changeHistoryDir(projectId) {
    return path.join(os.homedir(), ".pane", "change-history", projectId);
  }

  function changeHistoryFile(projectId) {
    return path.join(changeHistoryDir(projectId), "changes.json");
  }

  // Per-project write queue — serializes concurrent writes so they never race.
  const changeHistoryQueues = new Map(); // projectId -> Promise

  async function readChangeHistory(projectId) {
    try {
      const file = changeHistoryFile(projectId);
      const data = await fs.promises.readFile(file, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async function writeChangeHistory(projectId, changes) {
    const dir = changeHistoryDir(projectId);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = changeHistoryFile(projectId);
    // Atomic write: write to temp file then rename — prevents partial-write corruption
    const tmp = file + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(changes, null, 2), "utf-8");
    await fs.promises.rename(tmp, file);
  }

  // Enqueue a change-history write for a project.
  // All writes for the same project are chained — no two run concurrently.
  function enqueueChangeWrite(projectId, fn) {
    const prev = changeHistoryQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn).catch(err =>
      console.error("[change-history] write failed:", err.message)
    );
    // Keep only the tail — old resolved promises can be GC'd
    changeHistoryQueues.set(projectId, next.then(() => {
      if (changeHistoryQueues.get(projectId) === next) changeHistoryQueues.delete(projectId);
    }));
    return next;
  }

  ipcMain.handle("record_change", async (_event, args) => {
    const { projectId, filePath, oldString, newString, description, timestamp, workingDir } = args;

    // Normalize to relative path — Claude Code passes absolute paths
    let relFile = filePath;
    if (workingDir && path.isAbsolute(filePath) && filePath.startsWith(workingDir)) {
      relFile = path.relative(workingDir, filePath);
    }

    const change = {
      id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: timestamp || Date.now(),
      file: relFile,
      oldString,
      newString,
      description: description || "",
    };

    await enqueueChangeWrite(projectId, async () => {
      const changes = await readChangeHistory(projectId);
      changes.unshift(change);
      await writeChangeHistory(projectId, changes.slice(0, 500));
    });

    return { id: change.id, success: true };
  });

  ipcMain.handle("get_change_history", async (_event, args) => {
    const { projectId } = args;
    const changes = await readChangeHistory(projectId);
    return { changes };
  });

  ipcMain.handle("revert_change", async (_event, args) => {
    const { projectId, changeId, workingDir } = args;
    
    const changes = await readChangeHistory(projectId);
    const changeIndex = changes.findIndex((c) => c.id === changeId);
    
    if (changeIndex === -1) {
      return { success: false, error: "Change not found" };
    }
    
    const change = changes[changeIndex];
    const resolvedPath = path.isAbsolute(change.file) 
      ? change.file 
      : path.join(workingDir, change.file);
    
    try {
      const currentContent = await fs.promises.readFile(resolvedPath, "utf-8");
      
      // Verify the current content matches newString
      if (!currentContent.includes(change.newString)) {
        return { success: false, error: "File content doesn't match expected change" };
      }
      
      // Revert: replace newString with oldString
      const revertedContent = currentContent.replace(change.newString, change.oldString);
      await fs.promises.writeFile(resolvedPath, revertedContent, "utf-8");
      
      // Remove the change from history
      changes.splice(changeIndex, 1);
      await writeChangeHistory(projectId, changes);
      
      return { 
        success: true, 
        output: `Reverted change in ${change.file}`,
        file: change.file,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("search_changes", async (_event, args) => {
    const { projectId, query, filePath } = args;
    
    const changes = await readChangeHistory(projectId);
    let filtered = changes;
    
    if (filePath) {
      filtered = filtered.filter((c) => c.file === filePath);
    }
    
    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((c) => 
        c.description?.toLowerCase().includes(lowerQuery) ||
        c.oldString?.toLowerCase().includes(lowerQuery) ||
        c.newString?.toLowerCase().includes(lowerQuery) ||
        c.file.toLowerCase().includes(lowerQuery)
      );
    }
    
    return { changes: filtered };
  });

  ipcMain.handle("delete_change_history", async (_event, args) => {
    const { projectId } = args;
    try {
      await fs.promises.rm(changeHistoryDir(projectId), {
        recursive: true,
        force: true,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// --- State + Memory handlers for Pane Intelligence Layer ---
// Writes state to ~/.pane/state/{projectId}/ for the MCP server to read.
// Writes memory to ~/.pane/memory/{projectId}/ for cross-session persistence.
function registerStateHandlers() {
  function stateDir(projectId) {
    return path.join(os.homedir(), ".pane", "state", projectId);
  }

  async function writeStateFile(projectId, filename, data) {
    const dir = stateDir(projectId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, filename),
      JSON.stringify(data),
      "utf-8",
    );
  }

  ipcMain.handle("write_editor_state", async (_event, args) => {
    await writeStateFile(args.projectId, "editor.json", args.data);
  });

  ipcMain.handle("write_terminal_state", async (_event, args) => {
    await writeStateFile(args.projectId, "terminal.json", args.data);
  });

  ipcMain.handle("write_project_state", async (_event, args) => {
    await writeStateFile(args.projectId, "project.json", args.data);
  });

  ipcMain.handle("save_conversation", async (_event, args) => {
    const { filePath, conversation } = args;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    const THRESHOLD_SIZE = 4 * 1024 * 1024;

    const data = {
      sessionId: conversation.sessionId,
      model: conversation.model,
      messages: conversation.messages,
    };

    // All JSON.stringify/size-checking happens in Node.js, never the renderer.
    let json = JSON.stringify(data);

    if (json.length > THRESHOLD_SIZE) {
      const originalCount = data.messages.length;
      let keepCount = json.length > MAX_FILE_SIZE
        ? Math.min(50, originalCount)
        : Math.min(100, originalCount);

      data.messages = data.messages.slice(-keepCount);
      json = JSON.stringify(data);

      if (json.length > MAX_FILE_SIZE) {
        data.messages = data.messages.map((msg) => {
          if (msg.content && typeof msg.content === "object") {
            const content = Array.isArray(msg.content) ? msg.content : [msg.content];
            return {
              ...msg,
              content: content.map((item) => {
                if (item && typeof item === "object" && typeof item.text === "string" && item.text.length > 2000) {
                  return { ...item, text: item.text.substring(0, 1500) + "\n\n... [truncated] ...\n\n" + item.text.substring(item.text.length - 500) };
                }
                return item;
              }),
            };
          }
          return msg;
        });
        json = JSON.stringify(data);
      }
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Unique tmp path per write — concurrent saves each get their own tmp file,
    // so writeFile calls never interleave on the same file descriptor.
    // The rename is atomic: last writer wins with a complete snapshot.
    const tmpPath = filePath + ".tmp." + process.hrtime.bigint();
    await fs.promises.writeFile(tmpPath, json, { encoding: "utf-8" });
    await fs.promises.rename(tmpPath, filePath);
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
function registerSessionHandlers() {
  const SESSION_DIR = path.join(os.homedir(), ".pane", "session");

  ipcMain.handle("session_merge_state", async (_event, args) => {
    const { projectId, delta } = args;
    const stateDir = path.join(SESSION_DIR, projectId);
    const statePath = path.join(stateDir, "state.json");

    let current = {
      activeTask: null, workingSet: [], decisions: [],
      recentActions: [], turnCount: 0, lastProvider: null, lastIntent: null,
      startedAt: Date.now(),
    };
    try { current = JSON.parse(await fs.promises.readFile(statePath, "utf-8")); } catch {}

    // Active task
    if (delta.activeTask !== undefined) {
      current.activeTask = delta.activeTask ? { ...current.activeTask, ...delta.activeTask } : null;
    }
    // Working set: upsert by path, cap at 10
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
    // Decisions: prepend new, deduplicate, cap at 8
    if (delta.decisions?.length) {
      for (const d of delta.decisions) {
        const key = d.content.slice(0, 60).toLowerCase();
        const dupe = current.decisions.some(x => x.content.slice(0, 60).toLowerCase() === key);
        if (!dupe) current.decisions.unshift({ content: d.content, timestamp: Date.now() });
      }
      current.decisions = current.decisions.slice(0, 8);
    }
    // Recent actions: prepend, cap at 8
    if (delta.recentActions?.length) {
      current.recentActions = [...delta.recentActions, ...current.recentActions].slice(0, 8);
    }
    if (delta.turnCount !== undefined) current.turnCount = delta.turnCount;
    if (delta.lastProvider) current.lastProvider = delta.lastProvider;
    if (delta.lastIntent)   current.lastIntent = delta.lastIntent;
    if (delta.gitStatus !== undefined) current.gitStatus = delta.gitStatus;

    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify(current, null, 2), "utf-8");
    return current;
  });

  ipcMain.handle("session_clear_state", async (_event, args) => {
    const { projectId } = args;
    const statePath = path.join(SESSION_DIR, projectId, "state.json");
    const blank = { activeTask: null, workingSet: [], decisions: [], recentActions: [],
      turnCount: 0, lastProvider: null, lastIntent: null, startedAt: Date.now() };
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify(blank, null, 2), "utf-8");
    return blank;
  });

  ipcMain.handle("session_read_state", async (_event, args) => {
    const statePath = path.join(SESSION_DIR, args.projectId, "state.json");
    try { return JSON.parse(await fs.promises.readFile(statePath, "utf-8")); }
    catch { return null; }
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
    // Fire-and-forget: workers analyze new entries asynchronously
    if (result?.entry && mindWorkers) {
      setTimeout(() => mindWorkers.onMindEntryAdded(result.entry, args.projectId).catch(() => {}), 2000);
    }
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

}

async function registerIpcHandlers() {
  registerCommandHandlers();
  registerSettingsHandlers();
  await registerClaudeHandlers();
  registerWatcherHandlers();
  registerPtyHandlers();
  registerCheckpointHandlers();
  registerStateHandlers();
  registerMemoryHandlers();
  registerSessionHandlers();
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
    title: "Pane",
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
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

  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.error(`[pane] Renderer process gone: ${details.reason} (${details.exitCode})`);
    if (details.reason === "crashed" || details.reason === "oom") {
      console.warn("[pane] Renderer crashed or OOM, reload might be needed.");
    }
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
  punkEngine.setBrainSearch(args => {
    const { projectId, query, taskType, atomHints, projectRoot, intent, projectWhy } = args;
    if (projectRoot) {
      brainRequest("index_project_files", { projectId, projectRoot }).catch(() => {});
    }
    return brainRequest("contextual_search", {
      projectId,
      query,
      fileContext: null,
      intent:      intent || null,
      projectRoot: projectRoot || null,
      taskType:    taskType || null,
      atomHints:   atomHints || [],
      projectWhy:  projectWhy || "",
    });
  });

  punkEngine.setBrainIndexer((projectId, events) =>
    brainRequest("index_events", { projectId, events })
  );

  // Mind workers: background intelligence that acts on thoughts
  // Variable is used by brain_mind_add handler declared earlier in this scope,
  // but only called at runtime after this initialization completes.
  /* eslint-disable-next-line no-use-before-define -- runtime order is safe */
  mindWorkers = new MindWorkers({
    brainRequest,
    quickCall: (sys, usr) => punkEngine.quickCall(sys, usr),
    sendToRenderer,
  });
  mindWorkers.start();

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
