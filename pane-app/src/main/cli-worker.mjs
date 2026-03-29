// CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
//
// Claude backend: @anthropic-ai/claude-agent-sdk (clean async API, no JSONL parsing)
// Gemini backend: spawn + readline (stream-json JSONL)

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compileContext, mergeState, generateHandoff, extractFromModelOutput, mergeExtractedIntoHandoff, readHandoff, writeHandoffWithHistory, updateLatestHandoff } from "./session-context.mjs";
import { extractWithLLM, countHighConfidence, recordCorrections } from "./extraction-tuning.mjs";

// Resolve the SDK's cli.js — works in both dev and production (asar).
// In production, cli-worker.mjs is inside app.asar/out/main/, so node_modules
// resolves to app.asar/node_modules/. We redirect to app.asar.unpacked/ where
// electron-builder extracts asarUnpack entries so they can be spawned.
function getClaudeCliPath() {
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(workerDir, "../..");
  const cliPath = path.join(
    appRoot,
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
  );
  return cliPath.replace(/app\.asar([/\\])/g, "app.asar.unpacked$1");
}

const CLAUDE_CLI_PATH = getClaudeCliPath();

const execAsync = promisify(exec);
const __dirname = import.meta.dirname;

// Claude: projectId -> AbortController (for graceful cancellation)
const activeControllers = new Map();
// Claude: projectId -> sessionId (for within-conversation continuity)
const activeClaudeSessionIds = new Map();
// Gemini: projectId -> child process
const activeProcesses = new Map();
// Per-request state (used by Gemini normalizer)
const requestStates = new Map();


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
    return;
  }

  if (!requestStates.has(requestId)) {
    requestStates.set(requestId, {
      lastText: "",
      lastThought: "",
      toolResults: new Map(),
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
      if (parsed.role !== "assistant") break;
      const currentFullText =
        typeof parsed.content === "string" ? parsed.content : "";

      if (parsed.delta === true) {
        let increment = "";
        if (currentFullText.startsWith(state.lastText)) {
          increment = currentFullText.slice(state.lastText.length);
        } else {
          increment = currentFullText;
        }
        state.lastText = currentFullText;
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
                  delta: { type: "text_delta", text: increment },
                },
              },
            },
          },
        });
      } else {
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
      // content_block_stop: signals the tool_use block is complete.
      // Without this, usePunk.ts never transitions the status from
      // "using X..." to "thinking..." between tool call and result.
      sendToMain({
        type: "event",
        projectId,
        requestId,
        event: {
          event: "message",
          data: {
            parsed: {
              type: "stream_event",
              event: { type: "content_block_stop" },
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
      let cachedTokens = 0;
      if (parsed.stats) {
        inputTokens = parsed.stats.input_tokens || 0;
        outputTokens = parsed.stats.output_tokens || 0;
        cachedTokens = parsed.stats.cached || 0;
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
              // Forward the real session_id so the renderer can resume the session
              session_id: parsed.session_id || "",
              result: "",
              error: errorMsg,
              total_cost_usd: 0,
              duration_ms: parsed.stats?.duration_ms || 0,
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read_input_tokens: cachedTokens,
              },
              num_turns: parsed.stats?.tool_calls || 1,
            },
          },
        },
      });
      break;
    }

    case "error": {
      // Gemini CLI emits this for loop detection, max turns exceeded, etc.
      // Forward as an error event so the renderer can surface it.
      const severity = parsed.severity || "error";
      const msg = parsed.message || "Gemini encountered an error";
      if (severity === "error") {
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: { event: "error", data: { message: msg } },
        });
      }
      // warnings are informational — they don't stop execution, skip forwarding
      break;
    }

    default:
      break;
  }
}

function sendToMain(message) {
  process.parentPort.postMessage(message);
}

// ============================================================================
// Claude backend via @anthropic-ai/claude-agent-sdk
// ============================================================================

// Message types the renderer knows how to handle
const RENDERER_MSG_TYPES = new Set([
  "system",
  "stream_event",
  "assistant",
  "user",
  "result",
]);

async function handleClaudeSpawn({
  projectId,
  requestId,
  prompt,
  workingDir,
  model,
  systemPrompt,
  historyLength,
  mcpServerDest,
  tools,
  maxTurns,
  noExec,
}) {
  const ac = new AbortController();
  const oldAc = activeControllers.get(projectId);
  if (oldAc) oldAc.abort();
  activeControllers.set(projectId, ac);

  sendToMain({
    type: "event",
    projectId,
    requestId,
    event: { event: "processStarted", data: null },
  });

  const options = {
    cwd: workingDir,
    model: model || undefined,
    appendSystemPrompt: systemPrompt || undefined,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    executable: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    permissionMode: "bypassPermissions",
    dangerouslySkipPermissions: true,
    maxTurns: maxTurns || 50,
    tools: tools || undefined,
    betas: ["context-1m-2025-08-07"],
    mcpServers: {
      pane: {
        type: "stdio",
        command: process.execPath,
        args: [mcpServerDest],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PANE_PROJECT_ID: projectId,
          PANE_PROJECT_ROOT: workingDir,
          ...(noExec ? { PANE_NO_EXEC: "1" } : {}),
        },
      },
    },
    abortController: ac,
  };

  // Accumulate full assistant text for handoff pattern extraction at session end
  let sessionText = "";

  // Auto-resume across error_max_turns: if the model hits its turn limit mid-task,
  // silently continue rather than surfacing an error. Capped at MAX_AUTO_RESUMES
  // to prevent infinite loops on genuinely stuck sessions.
  const MAX_AUTO_RESUMES = 10;
  // Resume within-conversation continuity if history exists; new conversations (historyLength=0) start fresh.
  // Pane context infrastructure handles project-level context; session resume handles conversation-level history.
  let resumeSessionId = historyLength > 0 ? (activeClaudeSessionIds.get(projectId) || null) : null;
  let autoResumes = 0;
  let sdkInfoEmitted = false;

  try {
    while (true) {
      let hitMaxTurns = false;
      let maxTurnsSessionId = null;

      const q = query({
        prompt: autoResumes > 0 ? "continue" : prompt,
        options: { ...options, resume: resumeSessionId || undefined },
      });

      for await (const msg of q) {
        // Capture session_id from init so we can resume on max_turns
        if (!sdkInfoEmitted && msg.type === "system" && msg.subtype === "init") {
          sdkInfoEmitted = true;
          if (msg.session_id) {
            resumeSessionId = msg.session_id;
            activeClaudeSessionIds.set(projectId, msg.session_id);
          }
          // Fire-and-forget: fetch SDK metadata (models + account) once per session
          Promise.all([
            q.supportedModels?.().catch(() => null),
            q.accountInfo?.().catch(() => null),
          ]).then(([models, account]) => {
            if (models || account) {
              sendToMain({
                type: "event",
                projectId,
                requestId,
                event: { event: "sdk_init_info", data: { models, account } },
              });
            }
          });
        }

        // Transparent max_turns resume — swallow the error, loop back with "continue"
        if (msg.type === "result" && msg.subtype === "error_max_turns") {
          hitMaxTurns = true;
          maxTurnsSessionId = msg.session_id || resumeSessionId;
          break;
        }

        // Accumulate text content for handoff pattern extraction
        if (msg.type === "assistant") {
          const blocks = msg.message?.content || [];
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              sessionText += (sessionText ? "\n\n" : "") + block.text;
            }
          }
        }

        if (RENDERER_MSG_TYPES.has(msg.type)) {
          sendToMain({
            type: "event",
            projectId,
            requestId,
            event: { event: "message", data: { parsed: msg } },
          });
        }
      }

      if (!hitMaxTurns) break;

      autoResumes++;
      if (autoResumes > MAX_AUTO_RESUMES) {
        // Surfaced as a soft message so the UI can show "send a message to continue"
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: {
            event: "message",
            data: {
              parsed: {
                type: "result",
                subtype: "error_max_turns",
                session_id: maxTurnsSessionId || "",
                result: "",
                error: `Reached max turns limit after ${autoResumes} continuations`,
                total_cost_usd: 0,
                duration_ms: 0,
                num_turns: autoResumes * 50,
              },
            },
          },
        });
        break;
      }

      resumeSessionId = maxTurnsSessionId;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      const msg = err?.message || String(err);
      const useful = msg
        .split("\n")
        .filter(
          (l) =>
            !l.startsWith("    at ") &&
            !l.includes("DeprecationWarning") &&
            l.trim().length > 0,
        )
        .join("\n")
        .slice(0, 600);
      if (useful) {
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: { event: "error", data: { message: useful } },
        });
      }
    }
  } finally {
    if (activeControllers.get(projectId) === ac) {
      activeControllers.delete(projectId);
    }

    // Refresh git status then write handoff — enables seamless model swaps FROM Claude Code
    try {
      const gitStatus = await getGitStatus(workingDir);
      if (gitStatus) mergeState(projectId, { gitStatus });
      const previousHandoff = readHandoff(projectId);
      let handoff = generateHandoff(projectId, { writeFile: false });
      if (sessionText) {
        const extracted = extractFromModelOutput(sessionText, projectId);
        handoff = mergeExtractedIntoHandoff(handoff, extracted);
        // Layer 5: record any model corrections against the previous handoff
        if (extracted.corrections?.length > 0) {
          recordCorrections(projectId, extracted.corrections, previousHandoff);
        }
        // Layer 4: LLM fallback when regex found too little — CLI workers pass null
        // (Claude Code output is well-structured; fallback adds little value here)
        // updateLatestHandoff used instead of writeHandoffWithHistory to avoid a
        // duplicate history entry (initial write happens below on the same session).
        if (countHighConfidence(extracted) < 2 && sessionText.length > 500) {
          extractWithLLM(sessionText, null).then(llmExtracted => {
            if (Object.keys(llmExtracted).length > 0) {
              const enriched = mergeExtractedIntoHandoff({ ...handoff }, llmExtracted);
              updateLatestHandoff(projectId, enriched);
            }
          }).catch(() => {});
        }
      }
      writeHandoffWithHistory(projectId, handoff);
    } catch (err) {
      console.warn("[cli-worker] Failed to write Claude handoff:", err.message);
    }

    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: { event: "processEnded", data: { exit_code: 0 } },
    });
    requestStates.delete(requestId);
  }
}

// ============================================================================
// Gemini backend via spawn + readline
// ============================================================================

function shellEscape(s) {
  if (s.length === 0) return "''";
  if (/^[a-zA-Z0-9\-_./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function handleGeminiSpawn({
  projectId,
  requestId,
  prompt,
  workingDir,
  model,
  systemPrompt,
  history,
  mcpServerDest,
}) {
  const home = os.homedir();
  const paneDir = path.join(home, ".pane");
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
              args: [mcpServerDest],
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
  } catch {}

  let historyPreamble = "";
  if (history && history.length > 0) {
    // History preamble is only needed on first-turn or when session cannot be resumed.
    // When resuming, Gemini loads full history from its session file — no limit, no preamble.
    const turns = history
      .filter((m) => m.type === "user" || m.type === "assistant")
      .slice(-20);
    if (turns.length > 0) {
      const lines = ["## Previous conversation\n"];
      for (const msg of turns) {
        const role = msg.type === "user" ? "User" : "Assistant";
        const textBlocks = msg.content.filter((b) => b.type === "text");
        const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");
        let messageParts = [];
        if (textBlocks.length > 0) {
          const fullText = textBlocks.map((b) => b.text).join("\n").trim();
          if (fullText) messageParts.push(fullText);
        }
        if (thinkingBlocks.length > 0) {
          const fullThinking = thinkingBlocks
            .map((b) => b.thinking)
            .join("\n")
            .trim();
          if (fullThinking)
            messageParts.push(`⟨thinking⟩\n${fullThinking}\n⟨/thinking⟩`);
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

  // Prompt is passed via stdin (not -p flag) to avoid shell arg length limits and
  // quoting fragility with large prompts containing code, JSON, or special characters.
  const cmdParts = ["gemini", "--output-format", "stream-json", "--yolo"];
  if (model && /gemini/i.test(model)) cmdParts.push("--model", model);

  const shellCmd = cmdParts.map((arg) => shellEscape(arg)).join(" ");
  const fullCmd = `eval $(/usr/libexec/path_helper -s 2>/dev/null); [ -f "${home}/.zshrc" ] && source "${home}/.zshrc" 2>/dev/null; ${shellCmd}`;

  const child = spawn("/bin/zsh", ["-c", fullCmd], {
    cwd: workingDir,
    stdio: ["pipe", "pipe", "pipe"], // stdin is piped so we can write the prompt
    detached: true,
    env: { ...getEnvWithPath() },
  });

  // Write prompt via stdin and close — gemini reads it as the user message.
  // Avoids shell-quoting the entire prompt as a CLI argument.
  if (child.stdin) {
    child.stdin.write(fullPrompt, "utf8");
    child.stdin.end();
  }

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
      handleGeminiLine(projectId, line, requestId);
    });
  }

  let stderrOutput = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
  }

  function filterStderr(output) {
    const quotaRegex =
      /(TerminalQuotaError: )?You have exhausted your capacity on this model\. Your quota will reset after \d+h\d+m\d+s\.?/i;
    const match = output.match(quotaRegex);
    if (match) return match[0].trim();
    const lines = output.split("\n");
    const quotaLines = lines.filter(
      (line) =>
        line.includes("exhausted your capacity") ||
        line.includes("quota will reset"),
    );
    return quotaLines.join("\n").trim();
  }

  child.on("close", (code) => {
    // Capture session text before state cleanup for handoff extraction
    const geminiSessionText = requestStates.get(requestId)?.lastText || "";

    if (code !== 0) {
      const filtered = filterStderr(stderrOutput);
      if (filtered.length > 0) {
        sendToMain({
          type: "event",
          projectId,
          requestId,
          event: { event: "error", data: { message: filtered } },
        });
      } else if (stderrOutput.trim()) {
        const useful = stderrOutput
          .trim()
          .split("\n")
          .filter(
            (l) =>
              !l.startsWith("    at ") &&
              !l.includes("DeprecationWarning") &&
              l.trim().length > 0,
          )
          .join("\n")
          .slice(0, 600);
        if (useful) {
          sendToMain({
            type: "event",
            projectId,
            requestId,
            event: { event: "error", data: { message: useful } },
          });
        }
      }
    }
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: { event: "processEnded", data: { exit_code: code } },
    });
    if (activeProcesses.get(projectId) === child) {
      activeProcesses.delete(projectId);
    }
    requestStates.delete(requestId);

    // Write handoff after cleanup — enables seamless model swaps FROM Gemini CLI
    ;(async () => {
      try {
        const gitStatus = await getGitStatus(workingDir);
        if (gitStatus) mergeState(projectId, { gitStatus });
        const previousHandoff = readHandoff(projectId);
        let handoff = generateHandoff(projectId, { writeFile: false });
        if (geminiSessionText) {
          const extracted = extractFromModelOutput(geminiSessionText, projectId);
          handoff = mergeExtractedIntoHandoff(handoff, extracted);
          // Layer 5: record any model corrections against the previous handoff
          if (extracted.corrections?.length > 0) {
            recordCorrections(projectId, extracted.corrections, previousHandoff);
          }
          // Layer 4: LLM fallback when regex found too little (null quickCallFn = skip)
          // updateLatestHandoff used — not writeHandoffWithHistory — to avoid a duplicate
          // history entry when the async enrichment overwrites the initial write below.
          if (countHighConfidence(extracted) < 2 && geminiSessionText.length > 500) {
            extractWithLLM(geminiSessionText, null).then(llmExtracted => {
              if (Object.keys(llmExtracted).length > 0) {
                const enriched = mergeExtractedIntoHandoff({ ...handoff }, llmExtracted);
                updateLatestHandoff(projectId, enriched);
              }
            }).catch(() => {});
          }
        }
        writeHandoffWithHistory(projectId, handoff);
      } catch (err) {
        console.warn("[cli-worker] Failed to write Gemini handoff:", err.message);
      }
    })();
  });

  child.on("error", (err) => {
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: {
        event: "error",
        data: { message: `Failed to spawn gemini: ${err.message}` },
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
    requestStates.delete(requestId);
  });
}

// ============================================================================
// Unified spawn dispatcher
// ============================================================================

async function handleSpawn({
  projectId,
  prompt,
  workingDir,
  model,
  intent,
  history,
  command: messageCommand,
  requestId,
  todos,
  tools,
  maxTurns,
  systemPromptOverride,
  escalationHint,
  noExec,
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
          message: `No CLI command specified. Service data: ${JSON.stringify(process.serviceData)}`,
        },
      },
    });
    return;
  }

  const historyLength = history ? history.length : 0;
  const gitStatus = await getGitStatus(workingDir);

  mergeState(projectId, {
    lastProvider: command === "claude" ? "claude-code" : "gemini",
    lastIntent: intent,
    turnCount: historyLength / 2 + 1,
    gitStatus,
    ...(todos ? { todos } : {}),
  });

  const backend = command === "claude" ? "claude-code" : "gemini";
  const context = compileContext(projectId, intent, historyLength, backend);
  const basePrompt = systemPromptOverride || context.full;
  const systemPrompt = escalationHint ? `${basePrompt}\n\n${escalationHint}` : basePrompt;

  const home = os.homedir();
  const paneDir = path.join(home, ".pane");

  // Extract MCP server to ~/.pane/ so external node can access it outside .asar
  const mcpServerSrc = path.join(__dirname, "pane-mcp-server.mjs");
  const mcpServerDest = path.join(paneDir, "pane-mcp-server.mjs");
  try {
    await fsp.mkdir(paneDir, { recursive: true });
    const mcpServerContent = await fsp.readFile(mcpServerSrc, "utf-8");
    await fsp.writeFile(mcpServerDest, mcpServerContent, "utf-8");
  } catch (err) {
    console.warn("[cli-worker] Failed to write MCP server:", err.message);
  }

  if (command === "claude") {
    await handleClaudeSpawn({
      projectId,
      requestId,
      prompt,
      workingDir,
      model,
      systemPrompt,
      historyLength,
      mcpServerDest,
      tools,
      maxTurns,
      noExec,
    });
  } else {
    await handleGeminiSpawn({
      projectId,
      requestId,
      prompt,
      workingDir,
      model,
      systemPrompt,
      history,
      mcpServerDest,
    });
  }
}

function handleAbort({ projectId }) {
  // Claude: abort via AbortController
  const ac = activeControllers.get(projectId);
  if (ac) {
    ac.abort();
    activeControllers.delete(projectId);
    return;
  }
  // Gemini: kill child process
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      try { child.kill("SIGTERM"); } catch {}
    }
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 2000);
    activeProcesses.delete(projectId);
  }
}

function handleTerminate({ projectId }) {
  // Claude: abort via AbortController
  const ac = activeControllers.get(projectId);
  if (ac) {
    ac.abort();
    activeControllers.delete(projectId);
    return;
  }
  // Gemini: kill child process
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 1500);
    activeProcesses.delete(projectId);
  }
}

function handleShutdown() {
  for (const [, ac] of activeControllers) {
    try { ac.abort(); } catch {}
  }
  activeControllers.clear();
  for (const [, child] of activeProcesses) {
    try { process.kill(child.pid, "SIGKILL"); } catch {}
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
