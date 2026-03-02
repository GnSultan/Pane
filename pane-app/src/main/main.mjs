import path from "node:path";
import { ipcMain, BrowserWindow, shell, dialog, app, utilityProcess } from "electron";
import windowStateKeeper from "electron-window-state";
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import { promisify } from "node:util";
import ignore from "ignore";
import chokidar from "chokidar";
const __dirname = import.meta.dirname;
// Claude CLI runs in a UtilityProcess to keep the main thread free.
// Main process is a thin relay — never touches JSON.parse or Claude data.
let claudeWorker = null;
const activeProjectIds = new Set();
function getClaudeWorker() {
  if (claudeWorker && !claudeWorker.killed) return claudeWorker;
  const workerPath = path.join(__dirname, "claude-worker.mjs");
  claudeWorker = utilityProcess.fork(workerPath);
  // setImmediate-based yielding for the relay — prevents the main process from
  // blocking on a burst of messages (e.g., context compaction dumps 30+ messages).
  // Without yielding, each webContents.send() does a synchronous structured clone,
  // and the main process can't handle input events until the entire burst clears.
  const relayQueue = [];
  let relayDraining = false;

  function drainRelayQueue() {
    if (relayQueue.length === 0) { relayDraining = false; return; }
    const { channel, event } = relayQueue.shift();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
    if (relayQueue.length > 0) setImmediate(drainRelayQueue);
    else relayDraining = false;
  }

  claudeWorker.on("message", (message) => {
    if (message.type === "event") {
      if (message.event.event === "processEnded") {
        activeProjectIds.delete(message.projectId);
      }
      const channel = `claude-stream:${message.projectId}`;

      // Critical events bypass queue — must reach renderer immediately
      if (message.event.event === "processEnded" || message.event.event === "error") {
        // Drain any queued events first so ordering is preserved
        while (relayQueue.length > 0) {
          const { channel: ch, event } = relayQueue.shift();
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(ch, event);
          }
        }
        relayDraining = false;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(channel, message.event);
        }
        return;
      }

      relayQueue.push({ channel, event: message.event });
      if (!relayDraining) { relayDraining = true; setImmediate(drainRelayQueue); }
    }
  });
  claudeWorker.on("exit", (code) => {
    console.warn(`[pane] Claude worker exited with code ${code}`);
    for (const projectId of activeProjectIds) {
      const channel = `claude-stream:${projectId}`;
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, {
            event: "processEnded",
            data: { exit_code: null }
          });
        }
      }
    }
    activeProjectIds.clear();
    claudeWorker = null;
  });
  return claudeWorker;
}
function registerClaudeHandlers() {
  ipcMain.handle("send_to_claude", async (_event, args) => {
    const { projectId, prompt, workingDir, sessionId, model } = args;
    const worker = getClaudeWorker();
    activeProjectIds.add(projectId);
    worker.postMessage({ type: "spawn", projectId, prompt, workingDir, sessionId, model });
  });
  ipcMain.handle("abort_claude", async (_event, args) => {
    if (claudeWorker && !claudeWorker.killed) {
      claudeWorker.postMessage({ type: "abort", projectId: args.projectId });
    }
  });
  ipcMain.handle("terminate_claude_session", async (_event, args) => {
    if (claudeWorker && !claudeWorker.killed) {
      claudeWorker.postMessage({ type: "terminate", projectId: args.projectId });
    }
  });
  ipcMain.handle("check_claude_version", async () => {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      const versionMatch = stdout.trim().match(/^([\d.]+)/);
      if (!versionMatch) return { current: null, error: "Could not parse version" };
      return { current: versionMatch[1], error: null };
    } catch (error) {
      return { current: null, error: error.message };
    }
  });
  ipcMain.handle("check_claude_update", async () => {
    try {
      // Get current version from claude --version
      const { stdout: versionOut } = await execFileAsync("claude", ["--version"]);
      const currentMatch = versionOut.trim().match(/^([\d.]+)/);
      const current = currentMatch?.[1] ?? null;

      // Get latest version from npm registry (no install, just metadata)
      const { stdout: npmOut } = await execFileAsync("npm", ["show", "@anthropic-ai/claude-code", "version"], { timeout: 15000, env: getEnvWithPath() });
      const latest = npmOut.trim() || null;

      if (!current || !latest) {
        return { updateAvailable: false, currentVersion: current, newVersion: null, error: null };
      }

      const updateAvailable = latest !== current;
      return { updateAvailable, currentVersion: current, newVersion: updateAvailable ? latest : null, error: null };
    } catch (error) {
      return { updateAvailable: false, currentVersion: null, newVersion: null, error: error.message };
    }
  });
  ipcMain.handle("update_claude", async () => {
    try {
      const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "--force", "@anthropic-ai/claude-code@latest"], { timeout: 120000, env: getEnvWithPath() });
      const output = stdout + stderr;
      const success = !output.toLowerCase().includes("npm error");
      return { success, output, error: null };
    } catch (error) {
      return { success: false, output: error.stdout || "", error: error.message };
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
      withFileTypes: true
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
        extension: isDir ? null : path.extname(entry.name).slice(1) || null
      });
    }
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return entries;
  });
  ipcMain.handle(
    "read_directory_tree",
    async (_event, args) => {
      const result = {};
      async function readLevel(dirPath, depth) {
        try {
          const dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
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
              extension: isDir ? null : path.extname(entry.name).slice(1) || null
            });
            if (isDir && depth < args.maxDepth && !entry.name.startsWith(".")) {
              subdirs.push(fullPath);
            }
          }
          entries.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          });
          result[dirPath] = entries;
          await Promise.all(subdirs.map((sub) => readLevel(sub, depth + 1)));
        } catch {
        }
      }
      await readLevel(args.path, 0);
      return result;
    }
  );
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
    return buffer.toString("utf-8");
  });
  ipcMain.handle("write_file", async (_event, args) => {
    await fs.promises.mkdir(path.dirname(args.path), { recursive: true });
    await fs.promises.writeFile(args.path, args.content, "utf-8");
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
      throw new Error(`Failed to move to Trash: ${error.message}. File was NOT deleted.`);
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
      const gitignore = await fs.promises.readFile(path.join(args.root, ".gitignore"), "utf-8");
      ig.add(gitignore);
    } catch {
    }
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
  ipcMain.handle(
    "search_in_files",
    async (_event, args) => {
      const max = args.maxResults ?? 200;
      const queryLower = args.query.toLowerCase();
      const results = [];
      const ig = ignore();
      try {
        const gitignore = await fs.promises.readFile(path.join(args.root, ".gitignore"), "utf-8");
        ig.add(gitignore);
      } catch {
      }
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
                  line_content: lines[i].slice(0, 200)
                });
              }
            }
          }
        }
      }
      await walk(args.root, 0);
      return results;
    }
  );
  ipcMain.handle("get_git_status", async (_event, args) => {
    let branch;
    try {
      const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: args.path
      });
      branch = stdout.trim();
    } catch {
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: args.path
        });
        branch = stdout.trim();
      } catch {
        branch = "master";
      }
    }
    const files = {};
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-unormal"], {
        cwd: args.path
      });
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
    } catch {
    }
    return { branch, files };
  });
  ipcMain.handle("get_git_log", async (_event, args) => {
    const max = args.count ?? 50;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `-${max}`, "--pretty=format:%h%s%an%ar"],
        { cwd: args.path }
      );
      const commits = [];
      for (const line of stdout.split("\n")) {
        const parts = line.split("");
        if (parts.length >= 4) {
          commits.push({
            hash: parts[0],
            message: parts[1],
            author: parts[2],
            date: parts[3]
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
      await execFileAsync("git", ["commit", "-m", args.message], { cwd: args.path });
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
      properties: ["openDirectory"]
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
      const hasSubscription = config.oauthAccount?.billingType === "stripe_subscription";
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
  panel_width: null
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
    await fs.promises.writeFile(filePath, JSON.stringify(args.settings, null, 2), "utf-8");
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
  // Crash recovery: if node-pty kills the worker, send synthetic exit to all active PTYs
  ptyWorker.on("exit", (code) => {
    console.warn(`[pane] PTY worker exited with code ${code}`);
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
    worker.postMessage({ type: "create", ptyId: args.ptyId, projectId: args.projectId, cwd: args.cwd });
  });
  ipcMain.handle("pty_write", async (_event, args) => {
    if (ptyWorker && !ptyWorker.killed) {
      ptyWorker.postMessage({ type: "write", ptyId: args.ptyId, data: args.data });
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
      ptyWorker.postMessage({ type: "destroy_project", projectId: args.projectId });
    }
  });
}
// Both Claude and PTY run in UtilityProcesses — clean shutdown via postMessage.
// node-pty's SIGABRT bug (vscode#243952) can't crash the main process anymore
// because node-pty lives in the PTY worker, not here.
app.on("before-quit", () => {
  if (claudeWorker && !claudeWorker.killed) {
    claudeWorker.postMessage({ type: "shutdown" });
    claudeWorker.kill();
    claudeWorker = null;
  }
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
        /(^|[/\\])\../,            // dotfiles (.git, .DS_Store, etc.)
        /node_modules/,
        /\.next\//,
        /dist\//,
        /build\//,
        /out\//,
        /target\//,
        /\.turbo\//,
        /coverage\//
      ],
      persistent: true,
      usePolling: false,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
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
function registerIpcHandlers() {
  registerCommandHandlers();
  registerSettingsHandlers();
  registerClaudeHandlers();
  registerWatcherHandlers();
  registerPtyHandlers();
}
let mainWindow = null;
const isDev = !!process.env.ELECTRON_RENDERER_URL;
function getAssetPath(...paths) {
  return isDev ? path.join(__dirname, "../../electron/assets", ...paths) : path.join(process.resourcesPath, "assets", ...paths);
}
function createWindow() {
  const windowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800
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
      sandbox: false
    }
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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  getClaudeWorker(); // Pre-fork to hide first-use latency
  getPtyWorker();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  app.quit();
});
function getMainWindow() {
  return mainWindow;
}
export {
  getMainWindow
};
