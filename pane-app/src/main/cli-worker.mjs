// CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
// Handles spawn, readline, JSON.parse so the main process never touches CLI tool data.

// Debug: Log service data on startup
console.log("[cli-worker] Starting with serviceData:", process.serviceData);

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const __dirname = import.meta.dirname;

const activeProcesses = new Map();

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

// ============================================================================
// Gemini stream-json → Claude stream-json normalizer
//
// Gemini emits JSONL events like:
//   {"type":"init","session_id":"abc","model":"auto-gemini-3"}
//   {"type":"message","role":"assistant","content":"text","delta":true}
//   {"type":"message","role":"assistant","content":"text","delta":false}
//   {"type":"tool_use","tool_name":"Bash","tool_id":"t-1","parameters":{...}}
//   {"type":"tool_result","tool_id":"t-1","status":"success","output":"..."}
//   {"type":"result","status":"success","stats":{...}}
//
// We translate each to the equivalent Claude stream-json shape so the rest of
// the stack (handleClaudeMessage, usePunk, MessageBubble) requires zero changes.
// ============================================================================

function handleGeminiLine(projectId, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // ignore non-JSON (e.g. blank lines, debug output)
  }

  switch (parsed.type) {
    case "init": {
      const sessionId = parsed.session_id || `gemini-${Date.now()}`;
      sendToMain({
        type: "event",
        projectId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              model: parsed.model || "auto-gemini-3",
              tools: [],
            },
          },
        },
      });
      break;
    }

    case "message": {
      if (parsed.role !== "assistant") break; // skip user echoes
      const text = typeof parsed.content === "string" ? parsed.content : "";

      if (parsed.delta === true) {
        // Streaming chunk → text_delta stream event
        sendToMain({
          type: "event",
          projectId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text },
                },
              },
            },
          },
        });
      } else {
        // Final assistant message — triggers updateLastAssistantContent,
        // merging with any streamed text blocks already in the store.
        sendToMain({
          type: "event",
          projectId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "assistant",
                message: { content: [{ type: "text", text }] },
              },
            },
          },
        });
      }
      break;
    }

    case "thought": {
      const thinking = typeof parsed.content === "string" ? parsed.content : "";
      if (parsed.delta === true) {
        sendToMain({
          type: "event",
          projectId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "thinking_delta", thinking },
                },
              },
            },
          },
        });
      } else {
        // Final thought block
        sendToMain({
          type: "event",
          projectId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_start",
                  content_block: { type: "thinking", thinking },
                },
              },
            },
          },
        });
      }
      break;
    }

    case "tool_use": {
      const toolId = parsed.tool_id || `tool-${Date.now()}`;
      // Emit as content_block_start so the existing tool rendering path
      // in handleClaudeMessage picks it up and adds it to the assistant message.
      sendToMain({
        type: "event",
        projectId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "stream_event",
              event: {
                type: "content_block_start",
                content_block: {
                  type: "tool_use",
                  id: toolId,
                  name: parsed.tool_name || "unknown",
                  input: parsed.parameters || {},
                },
              },
            },
          },
        },
      });
      break;
    }

    case "tool_result": {
      const isError = parsed.status === "error" || parsed.status === "failure";
      const content =
        typeof parsed.output === "string"
          ? parsed.output
          : JSON.stringify(parsed.output ?? "");
      // Emit as a user message with a tool_result block — this is what
      // handleClaudeMessage's "user" case expects, stored as type:"system".
      sendToMain({
        type: "event",
        projectId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: parsed.tool_id || "",
                    content,
                    is_error: isError,
                  },
                ],
              },
            },
          },
        },
      });
      break;
    }

    case "result": {
      const isSuccess = parsed.status === "success" && !parsed.error;
      // Convert error object to string for the renderer
      let errorMsg = undefined;
      if (parsed.error) {
        errorMsg =
          typeof parsed.error === "object"
            ? parsed.error.message || JSON.stringify(parsed.error)
            : String(parsed.error);
      }
      // Aggregate tokens from stats
      let inputTokens = 0;
      let outputTokens = 0;
      if (parsed.stats) {
        inputTokens = parsed.stats.input_tokens || 0;
        outputTokens = parsed.stats.output_tokens || 0;
      }
      sendToMain({
        type: "event",
        projectId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "result",
              subtype: isSuccess ? "success" : "error",
              session_id: "",
              result: "",
              error: errorMsg,
              total_cost_usd: 0, // Gemini free tier
              duration_ms: parsed.stats?.duration_ms || 0,
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              num_turns: 1,
            },
          },
        },
      });
      break;
    }

    // "user" echo messages and unknowns — skip
    default:
      break;
  }
}

function shellEscape(s) {
  if (s.length === 0) return "''";
  if (/^[a-zA-Z0-9\-_./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sendToMain(message) {
  process.parentPort.postMessage(message);
}

function handleSpawn({
  projectId,
  prompt,
  workingDir,
  sessionId,
  model,
  intent,
  history,
  command: messageCommand,
}) {
  const command =
    messageCommand || (process.serviceData && process.serviceData.command);
  if (!command) {
    sendToMain({
      type: "event",
      projectId,
      event: {
        event: "error",
        data: {
          message: `No CLI command specified for backend. Service data: ${JSON.stringify(process.serviceData)}`,
        },
      },
    });
    return;
  }
  const home = os.homedir();
  const paneDir = path.join(home, ".pane");

  // --- Intelligence Layer: Read brief + generate MCP config ---

  // Read project brief (if it exists) to inject into system prompt
  let brief = "";
  try {
    brief = fs
      .readFileSync(
        path.join(paneDir, "memory", projectId, "brief.md"),
        "utf-8",
      )
      .trim();
  } catch {}

  // Read contextual memories from brain engine (proactive injection)
  let contextualMemories = "";
  try {
    const contextPath = path.join(
      paneDir,
      "brain",
      "context",
      `${projectId}.json`,
    );
    const raw = fs.readFileSync(contextPath, "utf-8");
    const contextData = JSON.parse(raw);
    if (contextData.memories?.length > 0) {
      const memParts = ["## Relevant past experience"];
      for (const m of contextData.memories.slice(0, 5)) {
        memParts.push(
          `- [${m.type}] (confidence: ${(m.confidence || 0.5).toFixed(1)}) ${m.content}`,
        );
      }
      if (contextData.tensions?.length > 0) {
        memParts.push("\n## Potential tensions with past decisions");
        for (const t of contextData.tensions.slice(0, 2)) {
          memParts.push(
            `- Past: "${t.pastDecision}" (confidence ${t.pastConfidence.toFixed(2)})`,
          );
          memParts.push(`  Current: "${t.newDecision}"`);
          memParts.push(`  Consider whether the past decision still applies.`);
        }
      }
      if (contextData.crossProjectInsights?.length > 0) {
        memParts.push("\n## Insights from other projects");
        for (const cp of contextData.crossProjectInsights.slice(0, 3)) {
          memParts.push(
            `- [${cp.project}] [${cp.type}] (confidence: ${cp.confidence.toFixed(1)}) ${cp.content}`,
          );
        }
      }
      contextualMemories = memParts.join("\n");
    }
  } catch {}

  // Read user profile (learned preferences + explicit rules)
  let profileSection = "";
  try {
    const profileExport = fs
      .readFileSync(path.join(paneDir, "profile", "profile-export.md"), "utf-8")
      .trim();
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
      if (lastSection > 200)
        cappedProfile = cappedProfile.slice(0, lastSection);
    }
    systemPrompt += cappedProfile + "\n\n";
  }
  if (brief) {
    // Section-aware truncation: cap at 3500 chars, break at last ### boundary
    let cappedBrief = brief;
    if (brief.length > 3500) {
      const truncated = brief.slice(0, 3500);
      const lastSection = truncated.lastIndexOf("\n###");
      cappedBrief =
        lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
    }
    systemPrompt += cappedBrief + "\n\n";
  }
  if (contextualMemories) {
    systemPrompt += contextualMemories + "\n\n";
  }

  if (intent === "execute") {
    systemPrompt += `You are in EXECUTION mode. Just do what is requested directly and efficiently. Skip planning or asking for permission unless absolutely necessary for safety or clarity.`;
  } else if (intent === "plan") {
    systemPrompt += `You are in PLANNING mode. Think deeply and reason carefully. Explore the architecture space, consider tradeoffs, and surface tensions with past decisions before recommending a direction. Present your reasoning transparently. End architectural proposals with a clear recommendation and ask the user to confirm before any implementation begins.`;
  } else if (intent === "explain") {
    systemPrompt += `You are in EXPLANATION mode. Your goal is to help the user understand the codebase. Provide clear, detailed, and accurate explanations. Use code examples where appropriate to illustrate your points.`;
  } else {
    systemPrompt += `For non-trivial tasks, present a brief plan FIRST and end with: "Ready to proceed — send 'go' to start." Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.`;
  }

  // Generate MCP config for the Pane MCP server
  const mcpServerPath = path.join(__dirname, "pane-mcp-server.mjs");
  const mcpConfigPath = path.join(paneDir, `mcp-config-${projectId}.json`);
  try {
    fs.mkdirSync(paneDir, { recursive: true });
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
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
      }),
    );
  } catch (err) {
    console.error(
      `[cli-worker] Failed to write MCP config for ${command}:`,
      err.message,
    );
  }

  let cmdParts = [command];

  if (command === "claude") {
    cmdParts.push(
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
    );
    if (model) {
      // "opusplan" is a UI alias — pass the actual model name to the CLI
      const cliModel = model === "opusplan" ? "opus" : model;
      cmdParts.push("--model", cliModel);
    }
    if (sessionId) {
      cmdParts.push("--resume", sessionId);
    }
  } else if (command === "gemini") {
    // Write MCP config to <workingDir>/.gemini/settings.json — the standard
    // project-level config location Gemini CLI reads on startup.
    const geminiConfigDir = path.join(workingDir, ".gemini");
    const geminiSettingsPath = path.join(geminiConfigDir, "settings.json");
    try {
      fs.mkdirSync(geminiConfigDir, { recursive: true });
      // Preserve any existing user settings, just inject/overwrite mcpServers
      let existingSettings = {};
      try {
        existingSettings = JSON.parse(
          fs.readFileSync(geminiSettingsPath, "utf-8"),
        );
      } catch {}
      fs.writeFileSync(
        geminiSettingsPath,
        JSON.stringify(
          {
            ...existingSettings,
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
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error(
        `[cli-worker] Failed to write Gemini MCP config:`,
        err.message,
      );
    }

    // Reconstruct conversation history as a text preamble.
    // Gemini CLI is stateless (no --resume), so we inline the last N turns.
    let historyPreamble = "";
    if (history && history.length > 0) {
      const turns = history
        .filter((m) => m.type === "user" || m.type === "assistant")
        .slice(-10); // last 5 pairs
      if (turns.length > 0) {
        const lines = ["## Previous conversation\n"];
        for (const msg of turns) {
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (!text) continue;
          const role = msg.type === "user" ? "User" : "Assistant";
          const capped = text.length > 600 ? text.slice(0, 600) + "…" : text;
          lines.push(`${role}: ${capped}`);
        }
        lines.push("\n---\n");
        historyPreamble = lines.join("\n");
      }
    }

    // Gemini has no --append-system-prompt or --system-prompt flag.
    // Inject context (system prompt + history) as a preamble to the prompt.
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${historyPreamble}${prompt}`
      : `${historyPreamble}${prompt}`;

    cmdParts.push(
      "-p",
      fullPrompt,
      "--output-format",
      "stream-json",
      "--yolo", // auto-approve all tool calls (= --dangerously-skip-permissions)
    );
    if (model) {
      // Filter out common incompatible model names from HTTP providers
      const isGeminiModel = /gemini/i.test(model);
      if (isGeminiModel) {
        cmdParts.push("--model", model);
      }
    }
    // Note: no --resume — Gemini CLI sessions are stateless.
    // History is handled by the preamble above.
  } else {
    sendToMain({
      type: "event",
      projectId,
      event: {
        event: "error",
        data: { message: `Unknown CLI command: ${command}` },
      },
    });
    return;
  }

  const shellCmd = cmdParts.map((arg) => shellEscape(arg)).join(" ");
  const fullCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null); [ -f "${home}/.zshrc" ] && source "${home}/.zshrc" 2>/dev/null; ${shellCmd}`;

  console.log(`[cli-worker] Spawning ${command}: ${shellCmd}`);

  const child = spawn("/bin/zsh", ["-c", fullCmd], {
    cwd: workingDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // Create a process group for easier termination
    env: {
      ...getEnvWithPath(),
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-3-opus-latest",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-3-5-sonnet-latest",
    },
  });

  activeProcesses.set(projectId, child);

  sendToMain({
    type: "event",
    projectId,
    event: { event: "processStarted", data: null },
  });

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.trim().length === 0) return;

      // Gemini emits a different JSON schema — normalize to Claude's format
      // so the renderer stack requires zero changes.
      if (command === "gemini") {
        handleGeminiLine(projectId, line);
        return;
      }

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
              event: {
                event: "message",
                data: { parsed: { type: "assistant", skipped: true } },
              },
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
                      content: toolUseIds.map((id) => ({
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
          event: { event: "message", data: { parsed } },
        });
      } catch {
        sendToMain({
          type: "event",
          projectId,
          event: { event: "message", data: { raw_json: line } },
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
        event: { event: "error", data: { message: stderrOutput.trim() } },
      });
    }
    sendToMain({
      type: "event",
      projectId,
      event: { event: "processEnded", data: { exit_code: code } },
    });
    activeProcesses.delete(projectId);
  });

  child.on("error", (err) => {
    sendToMain({
      type: "event",
      projectId,
      event: {
        event: "error",
        data: {
          message: `Failed to spawn ${command}: ${err.message}. Is ${command} CLI installed and in PATH?`,
        },
      },
    });
    sendToMain({
      type: "event",
      projectId,
      event: { event: "processEnded", data: { exit_code: null } },
    });
    activeProcesses.delete(projectId);
  });
}

function handleAbort({ projectId }) {
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      // Kill the whole process group since we use detached: true
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      // Fallback if PGID kill fails
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 2000);
    activeProcesses.delete(projectId);
  }
}
function handleTerminate({ projectId }) {
  // Graceful session termination (preserves sessionId, just kills the process)
  const command = process.serviceData && process.serviceData.command;
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      console.log(
        `[punk] Terminated idle ${command} session for project ${projectId}`,
      );
    } catch (err) {
      console.error(
        `[punk] Failed to terminate ${command} for ${projectId}:`,
        err,
      );
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 1500);
    activeProcesses.delete(projectId);
  }
}

function handleShutdown() {
  for (const [, child] of activeProcesses) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  }
  activeProcesses.clear();
  process.exit(0);
}

process.parentPort.on("message", ({ data }) => {
  switch (data.type) {
    case "spawn":
      handleSpawn(data);
      break;
    case "abort":
      handleAbort(data);
      break;
    case "terminate":
      handleTerminate(data);
      break;
    case "shutdown":
      handleShutdown();
      break;
  }
});
