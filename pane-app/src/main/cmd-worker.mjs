/**
 * CMD Worker — executes shell commands in an isolated utility process.
 *
 * Lives in a separate V8 isolate via utilityProcess.fork(). Has its own
 * libuv event loop with a clean kqueue state, avoiding the EBADF issue
 * that plagues child_process.spawn/execSync in Electron 40's main process
 * (where Chromium-integrated kqueue conflicts with libuv's EVFILT_PROC).
 *
 * Known crash — "node.CrUtilityMain" SIGABRT during exit():
 *   Stack: ::exit() → __cxa_finalize_ranges → std::terminate() → abort()
 *   Root cause: Electron's C++ static destructors throw ObjC exceptions
 *   during clean exit(). Prevented by keeping the event loop alive so the
 *   process is killed by OS process-group signal (no exit() path).
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

// ── Crash prevention: keep event loop alive ─────────────────────────────
//
// When the event loop drains (parentPort disconnects), Node.js calls
// process.exit() → ::exit() → C++ static destructors. Electron's ObjC
// runtime throws during this destruction, causing std::terminate() →
// abort(). We prevent this by keeping a ref'd handle alive so the
// process is killed by the parent's process-group signal instead.
//
// Key tradeoff: the process never exits cleanly via exit(). Instead:
//   - During app quit, the parent process group is destroyed by the OS
//     and the worker receives SIGTERM/SIGKILL — no exit() path involved.
//   - During respawn (worker crash/restart), the old worker is killed
//     by the OS signal, new worker is forked.

// No-op interval keeps the event loop alive. Never fires — purely structural.
// NOT unref'd — must keep the loop alive.
const keepaliveTimer = setInterval(() => {}, 2 ** 31 - 1);

// When the parent disconnects (app quit or parent crash), clear the keepalive
// so the worker can exit. The exit() → static destructor crash may still
// happen during app quit, but that's harmless — the user is done using Pane.
// Without this, the worker becomes an orphan process.
process.parentPort.on("close", () => {
  clearInterval(keepaliveTimer);
});

// ── Error resilience ────────────────────────────────────────────────────
// Prevent JS errors from triggering process exit (which hits the same
// static-destructor crash path). Log and continue instead.

process.on("uncaughtException", (err) => {
  console.error("[cmd-worker] Uncaught exception:", err?.message || err);
});

process.on("unhandledRejection", (err) => {
  console.error("[cmd-worker] Unhandled rejection:", err?.message || err);
});

// ── Message handler ─────────────────────────────────────────────────────

process.parentPort.on("message", (msg) => {
  let data;
  try {
    data = msg.data;
    if (!data || typeof data !== "object") {
      throw new Error("Invalid message: expected object with data property");
    }
  } catch (destructureErr) {
    // Can't respond via postMessage (no id to correlate), so log and bail.
    console.error("[cmd-worker] Malformed message:", destructureErr.message);
    return;
  }

  const { id, command, cwd, env, timeout } = data;

  if (!id || typeof command !== "string") {
    try {
      process.parentPort.postMessage({
        type: "result",
        id: id || null,
        success: false,
        errorMessage: `Invalid command: ${typeof command}`,
      });
    } catch (_) {
      // parentPort may be closed — nothing we can do
    }
    return;
  }

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
