// Claude CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
// Handles spawn, readline, JSON.parse so the main process never touches Claude data.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const __dirname = import.meta.dirname;

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
  const home = os.homedir();
  const paneDir = path.join(home, ".pane");

  // --- Intelligence Layer: Read brief + generate MCP config ---

  // Read project brief (if it exists) to inject into system prompt
  let brief = "";
  try { brief = fs.readFileSync(path.join(paneDir, "memory", projectId, "brief.md"), "utf-8").trim(); }
  catch {}

  // Read contextual memories from brain engine (proactive injection)
  let contextualMemories = "";
  try {
    const contextPath = path.join(paneDir, "brain", "context", `${projectId}.json`);
    const raw = fs.readFileSync(contextPath, "utf-8");
    const contextData = JSON.parse(raw);
    if (contextData.memories?.length > 0) {
      const memParts = ["## Relevant past experience"];
      for (const m of contextData.memories.slice(0, 5)) {
        memParts.push(`- [${m.type}] (confidence: ${(m.confidence || 0.5).toFixed(1)}) ${m.content}`);
      }
      if (contextData.tensions?.length > 0) {
        memParts.push("\n## Potential tensions with past decisions");
        for (const t of contextData.tensions.slice(0, 2)) {
          memParts.push(`- Past: "${t.pastDecision}" (confidence ${t.pastConfidence.toFixed(2)})`);
          memParts.push(`  Current: "${t.newDecision}"`);
          memParts.push(`  Consider whether the past decision still applies.`);
        }
      }
      if (contextData.crossProjectInsights?.length > 0) {
        memParts.push("\n## Insights from other projects");
        for (const cp of contextData.crossProjectInsights.slice(0, 3)) {
          memParts.push(`- [${cp.project}] [${cp.type}] (confidence: ${cp.confidence.toFixed(1)}) ${cp.content}`);
        }
      }
      contextualMemories = memParts.join("\n");
    }
  } catch {}

  // Read user profile (learned preferences + explicit rules)
  let profileSection = "";
  try {
    const profileExport = fs.readFileSync(path.join(paneDir, "profile", "profile-export.md"), "utf-8").trim();
    if (profileExport.length > 30) {
      profileSection = profileExport;
    }
  } catch {}

  // Build system prompt: profile + brief + contextual memories + plan-first instruction
  let systemPrompt = "";
  if (profileSection) {
    // Profile goes first — it's the user's identity and preferences
    let cappedProfile = profileSection;
    if (profileSection.length > 2000) {
      cappedProfile = profileSection.slice(0, 2000);
      const lastSection = cappedProfile.lastIndexOf("\n##");
      if (lastSection > 200) cappedProfile = cappedProfile.slice(0, lastSection);
    }
    systemPrompt += cappedProfile + "\n\n";
  }
  if (brief) {
    // Section-aware truncation: cap at 3500 chars, break at last ### boundary
    let cappedBrief = brief;
    if (brief.length > 3500) {
      const truncated = brief.slice(0, 3500);
      const lastSection = truncated.lastIndexOf("\n###");
      cappedBrief = lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
    }
    systemPrompt += cappedBrief + "\n\n";
  }
  if (contextualMemories) {
    systemPrompt += contextualMemories + "\n\n";
  }
  systemPrompt += `For non-trivial tasks, present a brief plan FIRST and end with: "Ready to proceed — send 'go' to start." Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.`;

  // Generate MCP config for the Pane MCP server
  const mcpServerPath = path.join(__dirname, "pane-mcp-server.mjs");
  const mcpConfigPath = path.join(paneDir, `mcp-config-${projectId}.json`);
  try {
    fs.mkdirSync(paneDir, { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        pane: {
          command: "node",
          args: [mcpServerPath],
          env: {
            PANE_PROJECT_ID: projectId,
            PANE_PROJECT_ROOT: workingDir,
          },
        },
      },
    }));
  } catch (err) {
    console.error("[claude-worker] Failed to write MCP config:", err.message);
  }

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
    "--mcp-config",
    mcpConfigPath,
    "--append-system-prompt",
    systemPrompt,
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
