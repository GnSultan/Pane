// Claude CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
// Handles spawn, readline, JSON.parse so the main process never touches Claude data.

import { spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";

const activeProcesses = new Map();

function shellEscape(s) {
  if (s.length === 0) return "''";
  if (/^[a-zA-Z0-9\-_./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sendToMain(message) {
  process.parentPort.postMessage(message);
}

function handleSpawn({ projectId, prompt, workingDir, sessionId, model }) {
  const cmdParts = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns",
    "50",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    `For non-trivial tasks, present a brief plan FIRST and end with: "Ready to proceed — send 'go' to start." Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.`
  ];
  if (model) {
    // "opusplan" is a UI alias — pass the actual model name to the CLI
    const cliModel = model === "opusplan" ? "opus" : model;
    cmdParts.push("--model", cliModel);
  }
  if (sessionId) {
    cmdParts.push("--resume", sessionId);
  }

  const shellCmd = cmdParts.map((arg) => shellEscape(arg)).join(" ");
  const home = os.homedir();
  const fullCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null); [ -f "${home}/.zshrc" ] && source "${home}/.zshrc" 2>/dev/null; ${shellCmd}`;

  const child = spawn("/bin/zsh", ["-c", fullCmd], {
    cwd: workingDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    }
  });

  activeProcesses.set(projectId, child);

  sendToMain({
    type: "event",
    projectId,
    event: { event: "processStarted", data: null }
  });

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.trim().length === 0) return;

      // Size gate: prevent large messages from overwhelming the IPC pipeline.
      // During context compaction, the CLI dumps the conversation — dozens of
      // messages in a burst. Each goes through structured clone twice (worker→main,
      // main→renderer). Even 20-50KB messages cause noticeable jank in a burst.
      //
      // The renderer builds conversations from stream events — it doesn't need
      // full assistant/user message dumps. Stream events are always small (<1KB).
      if (line.length > 20480) {
        try {
          const typeMatch = line.match(/^.{0,50}"type"\s*:\s*"(\w+)"/);
          const msgType = typeMatch ? typeMatch[1] : null;

          if (msgType === "assistant") {
            // Renderer already has streamed content — send stub
            sendToMain({
              type: "event",
              projectId,
              event: { event: "message", data: { parsed: { type: "assistant", skipped: true } } }
            });
            return;
          }

          if (msgType === "user") {
            // User messages contain tool results — extract tool_use_ids
            // so the renderer can mark tools as completed, but skip the
            // large content (file dumps, search results, etc.)
            const toolUseIds = [];
            const idRegex = /"tool_use_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = idRegex.exec(line)) !== null) {
              toolUseIds.push(match[1]);
            }
            sendToMain({
              type: "event",
              projectId,
              event: {
                event: "message",
                data: {
                  parsed: {
                    type: "user",
                    message: {
                      role: "user",
                      content: toolUseIds.map(id => ({
                        type: "tool_result",
                        tool_use_id: id,
                        content: "(output too large to display)",
                      })),
                    },
                  },
                },
              },
            });
            return;
          }

          // result and system messages are critical and always small.
          // stream_event messages should never be >20KB.
          // If they somehow are, let them through — correctness over perf.
        } catch {
          // Regex/extraction failed — fall through to normal processing
        }
      }

      try {
        const parsed = JSON.parse(line);
        sendToMain({
          type: "event",
          projectId,
          event: { event: "message", data: { parsed } }
        });
      } catch {
        sendToMain({
          type: "event",
          projectId,
          event: { event: "message", data: { raw_json: line } }
        });
      }
    });
  }

  let stderrOutput = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
  }

  child.on("close", (code) => {
    if (code !== 0 && stderrOutput.trim().length > 0) {
      sendToMain({
        type: "event",
        projectId,
        event: { event: "error", data: { message: stderrOutput.trim() } }
      });
    }
    sendToMain({
      type: "event",
      projectId,
      event: { event: "processEnded", data: { exit_code: code } }
    });
    activeProcesses.delete(projectId);
  });

  child.on("error", (err) => {
    sendToMain({
      type: "event",
      projectId,
      event: {
        event: "error",
        data: { message: `Failed to spawn claude: ${err.message}. Is claude CLI installed and in PATH?` }
      }
    });
    sendToMain({
      type: "event",
      projectId,
      event: { event: "processEnded", data: { exit_code: null } }
    });
    activeProcesses.delete(projectId);
  });
}

function handleAbort({ projectId }) {
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }, 3000);
    activeProcesses.delete(projectId);
  }
}

function handleTerminate({ projectId }) {
  // Graceful session termination (preserves sessionId, just kills the process)
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
      console.log(`[claude-worker] Terminated idle session for project ${projectId}`);
    } catch (err) {
      console.error(`[claude-worker] Failed to terminate ${projectId}:`, err);
    }
    setTimeout(() => {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }, 2000);
    activeProcesses.delete(projectId);
  }
}

function handleShutdown() {
  for (const [, child] of activeProcesses) {
    try { process.kill(child.pid, "SIGKILL"); } catch {}
  }
  activeProcesses.clear();
  process.exit(0);
}

process.parentPort.on("message", ({ data }) => {
  switch (data.type) {
    case "spawn":     handleSpawn(data);     break;
    case "abort":     handleAbort(data);     break;
    case "terminate": handleTerminate(data); break;
    case "shutdown":  handleShutdown();      break;
  }
});
