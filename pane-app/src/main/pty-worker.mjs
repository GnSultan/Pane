// PTY Host UtilityProcess worker.
// Runs in a separate V8 isolate — node-pty crashes here don't take down the main process.
// Owns all PTY instances, sends data/exit events back to main for relay to renderer.
// Same isolation pattern as claude-worker.mjs.
//
// See: https://github.com/microsoft/vscode/issues/243952

import __cjs_mod__ from "node:module";
const require2 = __cjs_mod__.createRequire(import.meta.url);
const nodePty = require2("node-pty");

const activePtys = new Map();

function sendToMain(message) {
  process.parentPort.postMessage(message);
}

function handleCreate({ ptyId, projectId, cwd }) {
  const userShell = process.env.SHELL || "/bin/zsh";
  const pty = nodePty.spawn(userShell, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env }
  });

  const dataDisposable = pty.onData((data) => {
    sendToMain({ type: "data", ptyId, data });
  });

  const exitDisposable = pty.onExit(({ exitCode }) => {
    sendToMain({ type: "exit", ptyId, exitCode });
    activePtys.delete(ptyId);
  });

  activePtys.set(ptyId, { pty, projectId, dataDisposable, exitDisposable });
}

function handleWrite({ ptyId, data }) {
  const entry = activePtys.get(ptyId);
  if (entry) {
    entry.pty.write(data);
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
  switch (data.type) {
    case "create":          handleCreate(data);         break;
    case "write":           handleWrite(data);          break;
    case "destroy":         handleDestroy(data);        break;
    case "destroy_project": handleDestroyProject(data); break;
    case "shutdown":        handleShutdown();           break;
  }
});
