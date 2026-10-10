import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * Preload bridge — channel-allowlisted.
 *
 * The renderer can only invoke/send/listen on channels main actually
 * registered (see src/main/ipc-allowlist.mjs). The allowlist travels in
 * via additionalArguments as base64 JSON: "--pane-ipc-allowlist=...".
 * Anything not in the list throws — a compromised renderer cannot probe
 * handler surface it doesn't already know about, and cannot reach channels
 * main doesn't expose.
 *
 * Timing: all ipcMain.handle/on registrations run in whenReady() before
 * window creation, so the snapshot at window-creation time is complete.
 */

function readAllowlist() {
  try {
    const arg = process.argv.find((a) => a.startsWith("--pane-ipc-allowlist="));
    if (!arg) return null;
    const json = Buffer.from(arg.slice("--pane-ipc-allowlist=".length), "base64").toString("utf-8");
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? new Set(arr.filter((c) => typeof c === "string")) : null;
  } catch {
    return null;
  }
}

/**
 * Why the allowlist-absent path FAILS OPEN, deliberately:
 *
 * 1. No renderer-reachable path leads to a window without the argument:
 *    main.mjs is the only BrowserWindow creation site and always passes
 *    --pane-ipc-allowlist, and there is no <webview> usage anywhere, so
 *    no guest page loads this preload. The null case is reachable only
 *    from external dev tooling that loads preload.mjs directly — exactly
 *    the case where gating against a stale snapshot would break debugging.
 * 2. In the packaged app the argument is always present, so the gate is
 *    always enforced where it matters. If a secondary window is ever
 *    added, it MUST carry the same additionalArguments line — the
 *    allowlist is only as complete as the windows that carry it.
 */
const allowlist = readAllowlist();
const check = (channel) => {
  // Allowlist absent (e.g. direct preload load in dev tooling) fails OPEN
  // so local debugging still works; production windows always carry the
  // argument, so the check is always active where it matters.
  if (allowlist === null) return;
  if (!allowlist.has(channel)) {
    throw new Error(`IPC channel not allowed: ${String(channel).slice(0, 64)}`);
  }
};

contextBridge.exposeInMainWorld("electronAPI", {
  // Renderer→main calls are the privilege boundary: they reach main-process
  // handlers. Both directions below are checked against the registration
  // allowlist, so a compromised renderer cannot probe or reach handler
  // surface main never exposed.
  invoke: (channel, ...args) => {
    check(channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    check(channel);
    return ipcRenderer.send(channel, ...args);
  },
  // Main→renderer pushes (webContents.send) are main's own broadcast —
  // main already sends them to every window, so a listener grants no new
  // reach. These channels are never ipcMain-registered, so they cannot be
  // validated against the same allowlist and are intentionally ungated.
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
  // File.path on dropped files is undefined in sandboxed renderers (Electron
  // 32+). webUtils.getPathForFile is the supported replacement — a drop
  // handler receives the File synchronously, so it must be called immediately,
  // not stashed and resolved later.
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
