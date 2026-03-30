// PTY Host UtilityProcess worker.
// Runs in a separate V8 isolate — node-pty crashes here don't take down the main process.
// Owns all PTY instances, sends data/exit events back to main for relay to renderer.
// Same isolation pattern as claude-worker.mjs.
//
// See: https://github.com/microsoft/vscode/issues/243952

import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty");

const activePtys = new Map();

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

function sendToMain(message) {
  process.parentPort.postMessage(message);
}

function handleCreate({ ptyId, projectId, cwd }) {
  try {
    const userShell = process.env.SHELL || "/bin/zsh";
    const pty = nodePty.spawn(userShell, ["-l"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: getEnvWithPath()
    });

    const dataDisposable = pty.onData((data) => {
      sendToMain({ type: "data", ptyId, data });
    });

    const exitDisposable = pty.onExit(({ exitCode }) => {
      sendToMain({ type: "exit", ptyId, exitCode });
      activePtys.delete(ptyId);
    });

    activePtys.set(ptyId, { pty, projectId, dataDisposable, exitDisposable });
  } catch (err) {
    // Spawn failed (bad cwd, shell not found, etc.) — notify renderer so the
    // tab shows as dead rather than hanging. Worker stays alive.
    console.error("[pty-worker] spawn failed:", err.message);
    sendToMain({ type: "exit", ptyId, exitCode: 1 });
  }
}

function handleWrite({ ptyId, data }) {
  const entry = activePtys.get(ptyId);
  if (!entry) return;
  try {
    entry.pty.write(data);
  } catch {
    // PTY died between the write and cleanup — ignore silently.
  }
}

function handleDestroy({ ptyId }) {
  const entry = activePtys.get(ptyId);
  if (entry) {
    try { entry.dataDisposable.dispose(); } catch {}
    try { entry.exitDisposable.dispose(); } catch {}
    try { process.kill(entry.pty.pid, "SIGKILL"); } catch {}
    activePtys.delete(ptyId);
  }
}

function handleDestroyProject({ projectId }) {
  for (const [ptyId, entry] of activePtys) {
    if (entry.projectId === projectId) {
      try { entry.dataDisposable.dispose(); } catch {}
      try { entry.exitDisposable.dispose(); } catch {}
      try { process.kill(entry.pty.pid, "SIGKILL"); } catch {}
      activePtys.delete(ptyId);
    }
  }
}

function handleShutdown() {
  for (const [, entry] of activePtys) {
    try { entry.dataDisposable.dispose(); } catch {}
    try { entry.exitDisposable.dispose(); } catch {}
    try { process.kill(entry.pty.pid, "SIGKILL"); } catch {}
  }
  activePtys.clear();
  // Let the event loop drain so node-pty's native ThreadSafeFunction callbacks
  // see napi_closing and bail out before environment teardown begins.
  // Calling process.exit(0) immediately triggers FreeEnvironment() while
  // the native thread's CallJS is still in-flight → SIGABRT.
  setTimeout(() => process.exit(0), 200);
}

process.parentPort.on("message", ({ data }) => {
  try {
    switch (data.type) {
      case "create":          handleCreate(data);         break;
      case "write":           handleWrite(data);          break;
      case "destroy":         handleDestroy(data);        break;
      case "destroy_project": handleDestroyProject(data); break;
      case "shutdown":        handleShutdown();           break;
    }
  } catch (err) {
    console.error("[pty-worker] unhandled error in message handler:", err.message);
  }
});
