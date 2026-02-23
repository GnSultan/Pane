import path from "node:path";
import { ipcMain, BrowserWindow, shell, dialog, app } from "electron";
import windowStateKeeper from "electron-window-state";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import fs from "node:fs";
import { promisify } from "node:util";
import ignore from "ignore";
import chokidar from "chokidar";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const activeProcesses = /* @__PURE__ */ new Map();
function shellEscape(s) {
  if (s.length === 0) return "''";
  if (/^[a-zA-Z0-9\-_./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function sendToRenderer$2(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
function registerClaudeHandlers() {
  ipcMain.handle("send_to_claude", async (_event, args) => {
    const { projectId, prompt, workingDir, sessionId } = args;
    const channel = `claude-stream:${projectId}`;
    const cmdParts = [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "50",
      "--dangerously-skip-permissions",
      "--append-system-prompt",
      `For non-trivial tasks, present a brief plan FIRST and end with: "Ready to proceed — send 'go' to start." Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.`
    ];
    if (sessionId) {
      cmdParts.push("--resume", sessionId);
    }
    const shellCmd = cmdParts.map((arg) => shellEscape(arg)).join(" ");
    const home = os.homedir();
    const fullCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null); [ -f "${home}/.zshrc" ] && source "${home}/.zshrc" 2>/dev/null; ${shellCmd}`;
    const child = spawn("/bin/zsh", ["-c", fullCmd], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });
    activeProcesses.set(projectId, child);
    sendToRenderer$2(channel, {
      event: "processStarted",
      data: null
    });
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (line.trim().length === 0) return;
        sendToRenderer$2(channel, {
          event: "message",
          data: { raw_json: line }
        });
      });
    }
    let stderrOutput = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString();
      });
    }
    return new Promise((resolve) => {
      child.on("close", (code) => {
        if (code !== 0 && stderrOutput.trim().length > 0) {
          sendToRenderer$2(channel, {
            event: "error",
            data: { message: stderrOutput.trim() }
          });
        }
        sendToRenderer$2(channel, {
          event: "processEnded",
          data: { exit_code: code }
        });
        activeProcesses.delete(projectId);
        resolve();
      });
      child.on("error", (err) => {
        sendToRenderer$2(channel, {
          event: "error",
          data: {
            message: `Failed to spawn claude: ${err.message}. Is claude CLI installed and in PATH?`
          }
        });
        sendToRenderer$2(channel, {
          event: "processEnded",
          data: { exit_code: null }
        });
        activeProcesses.delete(projectId);
        resolve();
      });
    });
  });
  ipcMain.handle("abort_claude", async (_event, args) => {
    const child = activeProcesses.get(args.projectId);
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
      }
      activeProcesses.delete(args.projectId);
    }
  });
}
const execFileAsync = promisify(execFile);
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
const activeSessions = /* @__PURE__ */ new Map();
function sendToRenderer$1(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
function registerTerminalHandlers() {
  ipcMain.handle("execute_terminal_command", async (_event, args) => {
    const { sessionId, command, cwd } = args;
    const channel = `terminal-output:${sessionId}`;
    const home = os.homedir();
    const shell2 = process.env.SHELL || "/bin/zsh";
    const shellName = shell2.split("/").pop() || "zsh";
    let initCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null);`;
    if (shellName === "zsh" && require2("fs").existsSync(`${home}/.zshrc`)) {
      initCmd += ` source "${home}/.zshrc" 2>/dev/null;`;
    } else if (shellName === "bash" && require2("fs").existsSync(`${home}/.bashrc`)) {
      initCmd += ` source "${home}/.bashrc" 2>/dev/null;`;
    }
    const fullCmd = `${initCmd} ${command}`;
    const child = spawn(shell2, ["-c", fullCmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });
    activeSessions.set(sessionId, child);
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        sendToRenderer$1(channel, {
          type: "stdout",
          data: chunk.toString()
        });
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        sendToRenderer$1(channel, {
          type: "stderr",
          data: chunk.toString()
        });
      });
    }
    return new Promise((resolve) => {
      child.on("close", (code) => {
        sendToRenderer$1(channel, {
          type: "exit",
          exitCode: code
        });
        activeSessions.delete(sessionId);
        resolve({ exitCode: code });
      });
      child.on("error", (err) => {
        sendToRenderer$1(channel, {
          type: "error",
          message: err.message
        });
        activeSessions.delete(sessionId);
        resolve({ exitCode: null });
      });
    });
  });
  ipcMain.handle("kill_terminal_session", async (_event, args) => {
    const child = activeSessions.get(args.sessionId);
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
      }
      activeSessions.delete(args.sessionId);
    }
  });
}
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
        sendToRenderer("pane://file-changed", {
          paths: Array.from(pendingPaths)
        });
        pendingPaths = /* @__PURE__ */ new Set();
      }
      debounceTimer = null;
    };
    const watcher = chokidar.watch(args.path, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\../,
      // Ignore dotfiles
      persistent: true,
      usePolling: true,  // Use polling to avoid EMFILE
      interval: 1000,
      depth: 5,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50
      }
    });
    watcher.on("all", (_eventType, filePath) => {
      pendingPaths.add(filePath);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 300);
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
  registerTerminalHandlers();
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
