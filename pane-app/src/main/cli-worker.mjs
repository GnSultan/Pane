// CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
// Handles spawn, readline, JSON.parse so the main process never touches CLI tool data.

// Debug: Log service data on startup
console.log("[cli-worker] Starting with serviceData:", process.serviceData);

import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { promisify } from "node:util";
import { compileContext, mergeState } from "./session-context.mjs";

const execAsync = promisify(exec);
const __dirname = import.meta.dirname;

const activeProcesses = new Map();
const requestStates = new Map(); // requestId -> { lastText: "", lastThought: "" }

async function getGitStatus(workingDir) {
  try {
    const { stdout: branchOut } = await execAsync(
      "git symbolic-ref --short HEAD || git rev-parse --abbrev-ref HEAD",
      { cwd: workingDir },
    );
    const branch = branchOut.trim();
    const { stdout: statusOut } = await execAsync(
      "git status --porcelain=v1 -unormal",
      { cwd: workingDir },
    );
    return { branch, summary: statusOut.trim() || "(clean)" };
  } catch {
    return null;
  }
}

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
// ============================================================================

function handleGeminiLine(projectId, line, requestId) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // ignore non-JSON (e.g. blank lines, debug output)
  }

  if (!requestStates.has(requestId)) {
    requestStates.set(requestId, {
      lastText: "",
      lastThought: "",
      toolResults: new Map(), // tool_id -> content
    });
  }
  const state = requestStates.get(requestId);

  switch (parsed.type) {
    case "init": {
      const sessionId = parsed.session_id || `gemini-${Date.now()}`;
      sendToMain({
        type: "event",
        projectId,
        requestId,
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
      const currentFullText =
        typeof parsed.content === "string" ? parsed.content : "";

      if (parsed.delta === true) {
        // Smart Delta Logic: Gemini CLI might send cumulative OR incremental chunks
        let increment = "";

        if (currentFullText.startsWith(state.lastText)) {
          // Cumulative chunk detected — slice off the part we already have
          increment = currentFullText.slice(state.lastText.length);
        } else {
          // Non-cumulative chunk — treat the whole content as the delta
          increment = currentFullText;
        }

        // Update tracking state regardless of which branch we took
        // (If cumulative, lastText grows. If incremental, it's replaced by the latest chunk)
        state.lastText = currentFullText;

        if (!increment) break; // skip empty or duplicate chunks

        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: increment },
                },
              },
            },
          },
        });
      } else {
        // Final assistant message
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "assistant",
                message: { content: [{ type: "text", text: currentFullText }] },
              },
            },
          },
        });
      }
      break;
    }

    case "thought": {
      const currentFullThinking =
        typeof parsed.content === "string" ? parsed.content : "";
      if (parsed.delta === true) {
        // Smart Delta Logic for Thoughts
        let increment = "";

        if (currentFullThinking.startsWith(state.lastThought)) {
          increment = currentFullThinking.slice(state.lastThought.length);
        } else {
          increment = currentFullThinking;
        }

        state.lastThought = currentFullThinking;

        if (!increment) break;

        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "thinking_delta", thinking: increment },
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
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_start",
                  content_block: {
                    type: "thinking",
                    thinking: currentFullThinking,
                  },
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
      const toolName = parsed.tool_name || "unknown";
      const toolInput = parsed.parameters || {};
      const toolInputJson = JSON.stringify(toolInput);

      // Start event with empty input
      sendToMain({
        type: "event",
        projectId,
        requestId,
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
                  name: toolName,
                  input: {},
                },
              },
            },
          },
        },
      });

      // Follow-up delta with full input to trigger renderer-side incremental parsing/UI updates
      sendToMain({
        type: "event",
        projectId,
        requestId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: {
                  type: "partial_json_delta",
                  partial_json: toolInputJson,
                },
              },
            },
          },
        },
      });
      break;
    }

    case "tool_result": {
      const toolId = parsed.tool_id || "";
      const isError = parsed.status === "error" || parsed.status === "failure";
      const rawOutput = parsed.output;
      const currentFullOutput =
        typeof rawOutput === "string"
          ? rawOutput
          : JSON.stringify(rawOutput ?? "");

      if (parsed.delta === true) {
        const lastOutput = state.toolResults.get(toolId) || "";
        let increment = "";

        if (currentFullOutput.startsWith(lastOutput)) {
          increment = currentFullOutput.slice(lastOutput.length);
        } else {
          increment = currentFullOutput;
        }

        state.toolResults.set(toolId, currentFullOutput);

        if (!increment) break;

        // Note: Renderer-side tool_result streaming is simplified — we send a single block
        // that gets updated. This keeps the UI logic unified with Claude.
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "user",
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolId,
                      content: currentFullOutput,
                      is_error: isError,
                    },
                  ],
                },
              },
            },
          },
        });
      } else {
        // Final tool result
        state.toolResults.set(toolId, currentFullOutput);
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "user",
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolId,
                      content: currentFullOutput,
                      is_error: isError,
                    },
                  ],
                },
              },
            },
          },
        });
      }
      break;
    }

    case "result": {
      const isSuccess = parsed.status === "success" && !parsed.error;
      let errorMsg = undefined;
      if (parsed.error) {
        errorMsg =
          typeof parsed.error === "object"
            ? parsed.error.message || JSON.stringify(parsed.error)
            : String(parsed.error);
      }
      let inputTokens = 0;
      let outputTokens = 0;
      if (parsed.stats) {
        inputTokens = parsed.stats.input_tokens || 0;
        outputTokens = parsed.stats.output_tokens || 0;
      }
      sendToMain({
        type: "event",
        projectId,
        requestId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "result",
              subtype: isSuccess ? "success" : "error",
              session_id: "",
              result: "",
              error: errorMsg,
              total_cost_usd: 0,
              duration_ms: parsed.stats?.duration_ms || 0,
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              num_turns: 1,
            },
          },
        },
      });
      break;
    }

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

async function handleSpawn({
  projectId,
  prompt,
  workingDir,
  sessionId,
  model,
  intent,
  history,
  command: messageCommand,
  requestId,
  todos,
}) {
  const command =
    messageCommand || (process.serviceData && process.serviceData.command);
  if (!command) {
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: {
        event: "error",
        data: {
          message: `No CLI command specified for backend. Service data: ${JSON.stringify(process.serviceData)}`,
        },
      },
    });
    return;
  }

  const historyLength = history ? history.length : 0;
  const gitStatus = await getGitStatus(workingDir);

  // Update session state before compileContext
  const stateUpdate = {
    lastProvider: command === "claude" ? "claude-cli" : "gemini-cli",
    lastIntent: intent,
    turnCount: historyLength / 2 + 1,
    gitStatus,
  };
  if (todos) {
    stateUpdate.todos = todos;
  }
  mergeState(projectId, stateUpdate);

  const context = compileContext(projectId, intent, historyLength);
  const systemPrompt = context.full;

  const home = os.homedir();
  const paneDir = path.join(home, ".pane");

  // Generate MCP config
  const mcpServerPath = path.join(__dirname, "pane-mcp-server.mjs");
  const mcpConfigPath = path.join(paneDir, `mcp-config-${projectId}.json`);
  try {
    await fsp.mkdir(paneDir, { recursive: true });
    await fsp.writeFile(
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
  } catch (err) {}

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
      const cliModel = model === "opusplan" ? "opus" : model;
      cmdParts.push("--model", cliModel);
    }
    if (sessionId) {
      cmdParts.push("--resume", sessionId);
    }
  } else if (command === "gemini") {
    const geminiConfigDir = path.join(workingDir, ".gemini");
    const geminiSettingsPath = path.join(geminiConfigDir, "settings.json");
    try {
      await fsp.mkdir(geminiConfigDir, { recursive: true });
      let existingSettings = {};
      try {
        const data = await fsp.readFile(geminiSettingsPath, "utf-8");
        existingSettings = JSON.parse(data);
      } catch {}
      await fsp.writeFile(
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
    } catch (err) {}

    let historyPreamble = "";
    if (history && history.length > 0) {
      // History is already sliced to 10 turns in renderer, but we'll double check
      const turns = history
        .filter((m) => m.type === "user" || m.type === "assistant")
        .slice(-10);
      if (turns.length > 0) {
        const lines = ["## Previous conversation\n"];
        for (const msg of turns) {
          const role = msg.type === "user" ? "User" : "Assistant";

          // Extract both text and thinking blocks, with appropriate truncation per type
          const textBlocks = msg.content.filter((b) => b.type === "text");
          const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");

          let messageParts: string[] = [];

          // Add text blocks (truncated more aggressively)
          if (textBlocks.length > 0) {
            const fullText = textBlocks.map((b) => b.text).join("\n").trim();
            if (fullText) {
              const capped = fullText.length > 600 ? fullText.slice(0, 600) + "…" : fullText;
              messageParts.push(capped);
            }
          }

          // Add thinking blocks (also truncated, but slightly more generous)
          if (thinkingBlocks.length > 0) {
            const fullThinking = thinkingBlocks.map((b) => b.thinking).join("\n").trim();
            if (fullThinking) {
              const capped = fullThinking.length > 800 ? fullThinking.slice(0, 800) + "…" : fullThinking;
              // Format thinking distinctly
              messageParts.push(`⟨thinking⟩\n${capped}\n⟨/thinking⟩`);
            }
          }

          if (messageParts.length === 0) continue;

          lines.push(`${role}: ${messageParts.join("\n\n")}`);
        }
        lines.push("\n---\n");
        historyPreamble = lines.join("\n");
      }
    }

    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${historyPreamble}${prompt}`
      : `${historyPreamble}${prompt}`;

    cmdParts.push("-p", fullPrompt, "--output-format", "stream-json", "--yolo");
    if (model && /gemini/i.test(model)) {
      cmdParts.push("--model", model);
    }
  }

  const shellCmd = cmdParts.map((arg) => shellEscape(arg)).join(" ");
  const fullCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null); [ -f "${home}/.zshrc" ] && source "${home}/.zshrc" 2>/dev/null; ${shellCmd}`;

  const child = spawn("/bin/zsh", ["-c", fullCmd], {
    cwd: workingDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...getEnvWithPath(),
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-3-opus-latest",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-3-5-sonnet-latest",
    },
  });

  // Ensure old process for this project is dead before tracking new one
  const oldChild = activeProcesses.get(projectId);
  if (oldChild && !oldChild.killed) {
    try {
      process.kill(-oldChild.pid, "SIGKILL");
    } catch {}
  }
  activeProcesses.set(projectId, child);

  sendToMain({
    type: "event",
    projectId,
    requestId,
    event: { event: "processStarted", data: null },
  });

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.trim().length === 0) return;
      if (command === "gemini") {
        handleGeminiLine(projectId, line, requestId);
        return;
      }
      if (line.length > 20480) {
        try {
          const typeMatch = line.match(/^.{0,50}"type"\s*:\s*"(\w+)"/);
          const msgType = typeMatch ? typeMatch[1] : null;
          if (msgType === "assistant") {
            sendToMain({
              type: "event",
              projectId,
              requestId,
              event: {
                event: "message",
                data: { parsed: { type: "assistant", skipped: true } },
              },
            });
            return;
          }
          if (msgType === "user") {
            const toolUseIds = [];
            const idRegex = /"tool_use_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = idRegex.exec(line)) !== null) {
              toolUseIds.push(match[1]);
            }
            sendToMain({
              type: "event",
              projectId,
              requestId,
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
        } catch {}
      }
      try {
        const parsed = JSON.parse(line);
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: { event: "message", data: { parsed } },
        });
      } catch {
        sendToMain({
          type: "event",
          projectId,
          requestId,
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

  function filterStderr(output) {
    // Look for the quota exhaustion message and extract only that
    const quotaRegex =
      /(TerminalQuotaError: )?You have exhausted your capacity on this model\. Your quota will reset after \d+h\d+m\d+s\.?/i;
    const match = output.match(quotaRegex);
    if (match) {
      return match[0].trim();
    }
    // Fallback to simple line filtering for other quota-related messages
    const lines = output.split("\n");
    const quotaLines = lines.filter(
      (line) =>
        line.includes("exhausted your capacity") ||
        line.includes("quota will reset"),
    );
    return quotaLines.join("\n").trim();
  }

  child.on("close", (code) => {
    if (code !== 0) {
      const filtered = filterStderr(stderrOutput);
      if (filtered.length > 0) {
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "error",
            data: { message: filtered },
          },
        });
      }
    }
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: { event: "processEnded", data: { exit_code: code } },
    });
    // Only delete if it's the SAME child we're tracking
    if (activeProcesses.get(projectId) === child) {
      activeProcesses.delete(projectId);
    }
    // Clean up state
    requestStates.delete(requestId);
  });

  child.on("error", (err) => {
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: {
        event: "error",
        data: {
          message: `Failed to spawn ${command}: ${err.message}`,
        },
      },
    });
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: { event: "processEnded", data: { exit_code: null } },
    });
    if (activeProcesses.get(projectId) === child) {
      activeProcesses.delete(projectId);
    }
    // Clean up state
    requestStates.delete(requestId);
  });
}

function handleAbort({ projectId }) {
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
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
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {}
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
      handleSpawn(data).catch((err) => {
        sendToMain({
          type: "event",
          projectId: data.projectId,
          requestId: data.requestId,
          event: {
            event: "error",
            data: { message: `Spawn error: ${err.message}` },
          },
        });
      });
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
