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
const __dirname = import.meta.dirname;
const isMac = process.platform === "darwin";
let forceQuit = false;
// Punk engine runs in a UtilityProcess to keep the main thread free.
// Main process is a thin relay — never touches JSON.parse or model output.
function registerClaudeHandlers() {
  // Punk is the default engine; keep these names for backwards compatibility.
  registerPunkHandlers();
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
  ipcMain.handle("check_claude_update", async () => {
    try {
      // Get current version from claude --version
      const { stdout: versionOut } = await execFileAsync(
        "claude",
        ["--version"],
        { env: getEnvWithPath() },
      );
      const currentMatch = versionOut.trim().match(/^([\d.]+)/);
      const current = currentMatch?.[1] ?? null;

      // Get latest version from npm registry (no install, just metadata)
      const { stdout: npmOut } = await execFileAsync(
        "npm",
        ["show", "@anthropic-ai/claude-code", "version"],
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
  ipcMain.handle("update_claude", async () => {
    try {
      const env = getEnvWithPath();

      // Find where claude is globally installed
      const { stdout: prefixOut } = await execFileAsync("npm", ["root", "-g"], {
        env,
        timeout: 10000,
      });
      const globalRoot = prefixOut.trim(); // e.g. /Users/x/.nvm/.../lib/node_modules
      const pkgDir = path.join(globalRoot, "@anthropic-ai", "claude-code");

      // Remove existing install directory — npm ENOTEMPTY prevents in-place upgrade
      await fs.promises.rm(pkgDir, { recursive: true, force: true });

      // Fresh install
      const { stdout, stderr } = await execFileAsync(
        "npm",
        ["install", "-g", "@anthropic-ai/claude-code@latest"],
        { timeout: 120000, env },
      );
      return { success: true, output: stdout + stderr, error: null };
    } catch (error) {
      const output = (error.stdout || "") + (error.stderr || "");
      return { success: false, output, error: error.message };
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
      const { stdout } = await execFileAsync(
        "git",
        ["log", `-${max}`, "--pretty=format:%h%s%an%ar"],
        { cwd: args.path },
      );
      const commits = [];
      for (const line of stdout.split("\n")) {
        const parts = line.split("");
        if (parts.length >= 4) {
          commits.push({
            hash: parts[0],
            message: parts[1],
            author: parts[2],
            date: parts[3],
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
  punk_backend: "http",
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

    // Atomic write: write to a temp file then rename.
    // A crash or HMR kill mid-write can never zero the real settings file.
    const tmpPath = filePath + ".tmp";
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
        sendToRenderer("pane://file-changed", Array.from(pendingPaths));
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
    await fs.promises.writeFile(file, JSON.stringify(changes, null, 2), "utf-8");
  }

  ipcMain.handle("record_change", async (_event, args) => {
    const { projectId, filePath, oldString, newString, description, timestamp } = args;
    
    const changes = await readChangeHistory(projectId);
    
    const change = {
      id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: timestamp || Date.now(),
      file: filePath,
      oldString,
      newString,
      description: description || "",
    };
    
    changes.unshift(change); // Add to beginning (most recent first)
    
    // Keep only last 500 changes to prevent unbounded growth
    const trimmed = changes.slice(0, 500);
    
    await writeChangeHistory(projectId, trimmed);
    
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
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.promises.appendFile(
      path.join(dir, "events.jsonl"),
      lines,
      "utf-8",
    );

    // Prune to last N events
    try {
      const content = await fs.promises.readFile(
        path.join(dir, "events.jsonl"),
        "utf-8",
      );
      const allLines = content.trim().split("\n").filter(Boolean);
      if (allLines.length > MEMORY_MAX_EVENTS) {
        const pruned = allLines.slice(-MEMORY_MAX_EVENTS).join("\n") + "\n";
        await fs.promises.writeFile(
          path.join(dir, "events.jsonl"),
          pruned,
          "utf-8",
        );
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
            `**${label}:** ${summary.length > 200 ? summary.slice(0, 200) + "..." : summary}`,
          );
        }
      }
    }

    let brief = parts.join("\n");

    // Section-aware truncation: cap at 3500 chars, break at last ### boundary
    if (brief.length > 3500) {
      const truncated = brief.slice(0, 3500);
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

function getBrainWorker() {
  if (brainWorker && !brainWorker.killed) return brainWorker;
  const workerPath = path.join(__dirname, "brain-engine.mjs");
  brainWorker = utilityProcess.fork(workerPath);

  brainWorker.on("message", (message) => {
    // Route responses back to pending IPC requests
    if (message.requestId && brainPendingRequests.has(message.requestId)) {
      const resolve = brainPendingRequests.get(message.requestId);
      brainPendingRequests.delete(message.requestId);
      resolve(message);
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
    const requestId = `brain-${++brainRequestCounter}`;
    brainPendingRequests.set(requestId, resolve);
    getBrainWorker().postMessage({ type, requestId, ...data });
    // Timeout to prevent hanging
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
    const { projectId, query, fileContext, intent, projectRoot } = args;
    // Auto-trigger file indexing fire-and-forget when projectRoot is known.
    // brain-engine deduplicates via indexedProjects Set — safe to call every time.
    if (projectRoot) {
      brainRequest("index_project_files", { projectId, projectRoot }).catch(() => {});
    }
    return brainRequest("contextual_search", { projectId, query, fileContext, intent, projectRoot: projectRoot || null });
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
    return brainRequest("mind_add", { content: args.content });
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
}

function registerIpcHandlers() {
  registerCommandHandlers();
  registerSettingsHandlers();
  registerClaudeHandlers();
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
    mainWindow.webContents.openDevTools({ mode: "detach" });
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
app.whenReady().then(() => {
  registerIpcHandlers();
  modelManager.initialize();
  createWindow();
  preforkPunkWorker(); // Pre-fork to hide first-use latency
  getPtyWorker();
  getBrainWorker(); // Pre-fork: start loading SQLite + embedding model
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
