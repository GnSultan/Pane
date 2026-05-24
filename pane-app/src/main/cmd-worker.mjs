/**
 * CMD Worker — executes shell commands in an isolated utility process.
 *
 * Lives in a separate V8 isolate via utilityProcess.fork(). Has its own
 * libuv event loop with a clean kqueue state, avoiding the EBADF issue
 * that plagues child_process.spawn/execSync in Electron 40's main process
 * (where Chromium-integrated kqueue conflicts with libuv's EVFILT_PROC).
 *
 * Protocol:
 *   Main → Worker: { id, command, cwd?, timeout?, env? }
 *   Worker → Main: { type: "result", id, success, stdout, exitCode }
 *   Worker → Main: { type: "result", id, success: false, stdout, stderr, exitCode, errorMessage }
 */

import { execSync } from "node:child_process";

function getEnvWithPath() {
  // This worker runs inside Electron's bundled Node.js — no need to find
  // external `node` on PATH. Only prepend homebrew paths so the user's
  // system-installed tools (npm, eslint, etc.) are discoverable.
  const existing = process.env.PATH || "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const combined = [...extra, ...existing.split(":")].filter(Boolean).join(":");
  return { ...process.env, PATH: combined };
}

process.parentPort.on("message", ({ data }) => {
  const { id, command, cwd, env, timeout } = data;

  try {
    const stdout = execSync(command, {
      cwd: cwd || process.cwd(),
      env: { ...getEnvWithPath(), ...(env || {}) },
      encoding: "utf-8",
      timeout: (timeout || 120) * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ["pipe", "pipe", "pipe"],
    });

    process.parentPort.postMessage({
      type: "result",
      id,
      success: true,
      stdout: stdout || "",
      exitCode: 0,
    });
  } catch (error) {
    process.parentPort.postMessage({
      type: "result",
      id,
      success: false,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
      exitCode: error.status !== undefined ? error.status : -1,
      errorMessage: error.message,
    });
  }
});
