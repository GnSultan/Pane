/**
 * CMD Worker — executes shell commands in an isolated utility process.
 *
 * Lives in a separate V8 isolate via utilityProcess.fork(). Has its own
 * libuv event loop with a clean kqueue state, avoiding the EBADF issue
 * that plagues child_process.spawn/execSync in Electron 40's main process
 * (where Chromium-integrated kqueue conflicts with libuv's EVFILT_PROC).
 *
 * **Concurrent execution:** Up to MAX_CONCURRENT (5) commands run in
 * parallel via spawn(). Excess commands queue in a backlog and drain
 * as slots free up. This eliminates the serial bottleneck from execSync.
 *
 * **Buffer limits:** Each command's combined stdout/stderr is capped at
 * MAX_BUFFER (512KB). If exceeded, the process is SIGKILL'd and output
 * truncated. Prevents OOM from infinite-output commands like `cat /dev/urandom`.
 *
 * **Immediate drain on timeout:** When a command times out, the concurrency
 * slot is freed immediately (running--, drain()) instead of waiting 3s
 * for SIGTERM → SIGKILL. Keeps backlog moving during slow commands.
 *
 * Protocol:
 *   Main → Worker: { id, command, cwd?, timeout?, env? }
 *   Main → Worker: { type: "shutdown" }
 *   Worker → Main: { type: "result", id, success, stdout, exitCode }
 *   Worker → Main: { type: "result", id, success: false, stdout, stderr, exitCode, errorMessage }
 */

import { spawn } from "node:child_process";

const MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT_S = 120;
const MAX_BUFFER = 512 * 1024; // 512KB — kill command if output exceeds this

let running = 0;
const backlog = [];
const activeChildren = new Map();

function getEnvWithPath() {
  // This worker runs inside Electron's bundled Node.js — no need to find
  // external `node` on PATH. Only prepend homebrew paths so the user's
  // system-installed tools (npm, eslint, etc.) are discoverable.
  const existing = process.env.PATH || "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const combined = [...extra, ...existing.split(":")].filter(Boolean).join(":");
  return { ...process.env, PATH: combined };
}

/**
 * Run a single command via spawn. Posts result back to parent on completion.
 *
 * shell: true means Node.js runs `/bin/sh -c <command>`, so the entire
 * string is passed directly — no regex parsing of args needed. This avoids
 * edge cases with nested quotes, backslash escapes, and heredocs.
 */
function runCommand({ id, command, cwd, env, timeout }) {
  const child = spawn(command, [], {
    cwd: cwd || process.cwd(),
    env: { ...getEnvWithPath(), ...(env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  activeChildren.set(id, child);

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killedByOverflow = false;

  const onStdout = (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_BUFFER) {
      killedByOverflow = true;
      child.kill("SIGKILL");
      stdout = stdout.substring(0, MAX_BUFFER) + "\n...[BUFFER OVERFLOW — process killed]";
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
    }
  };
  const onStderr = (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_BUFFER) {
      killedByOverflow = true;
      child.kill("SIGKILL");
      stderr = stderr.substring(0, MAX_BUFFER) + "\n...[BUFFER OVERFLOW — process killed]";
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
    }
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);

  const timer = setTimeout(() => {
    timedOut = true;
    // Free concurrency slot immediately — don't wait 3s for SIGKILL
    running--;
    drain();
    child.kill("SIGTERM");
    // Give it 3s to respond to SIGTERM, then SIGKILL
    setTimeout(() => {
      if (activeChildren.has(id)) {
        child.kill("SIGKILL");
      }
    }, 3000);
  }, (timeout || DEFAULT_TIMEOUT_S) * 1000);

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    activeChildren.delete(id);
    // If already timed-out, the slot was freed in the timeout handler above
    if (!timedOut) {
      running--;
      drain();
    }

    if (killedByOverflow) {
      process.parentPort.postMessage({
        type: "result",
        id,
        success: false,
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: -1,
        errorMessage: "Command output exceeded 512KB buffer limit",
      });
    } else if (timedOut) {
      process.parentPort.postMessage({
        type: "result",
        id,
        success: false,
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: -1,
        errorMessage: `Command timed out after ${timeout || DEFAULT_TIMEOUT_S}s`,
      });
    } else {
      process.parentPort.postMessage({
        type: "result",
        id,
        success: exitCode === 0,
        stdout: stdout || "",
        stderr: exitCode !== 0 ? stderr : "",
        exitCode: exitCode !== null ? exitCode : -1,
        errorMessage: exitCode !== 0 ? `Exit code ${exitCode}: ${stderr.trim()}` : undefined,
      });
    }
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    activeChildren.delete(id);
    if (!timedOut) {
      running--;
      drain();
    }

    process.parentPort.postMessage({
      type: "result",
      id,
      success: false,
      stdout: "",
      stderr: err.message,
      exitCode: -1,
      errorMessage: err.message,
    });
  });
}

/**
 * Drain the backlog: start queued commands while slots are available.
 */
function drain() {
  while (running < MAX_CONCURRENT && backlog.length > 0) {
    const entry = backlog.shift();
    running++;
    runCommand(entry);
  }
}

/**
 * Kill all active children (used during shutdown).
 */
function killAll() {
  for (const [id, child] of activeChildren) {
    try { child.kill("SIGKILL"); } catch {
      // Process may already have exited — no action needed
    }
  }
  activeChildren.clear();
}

// ── Message handler ────────────────────────────────────────────────────────

process.parentPort.on("message", ({ data }) => {
  if (data.type === "shutdown") {
    killAll();
    backlog.length = 0;
    process.exit(0);
    return;
  }

  // Normal command execution
  if (running < MAX_CONCURRENT) {
    running++;
    runCommand(data);
  } else {
    backlog.push(data);
  }
});
