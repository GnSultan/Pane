// CLI UtilityProcess worker.
// Runs in a separate V8 isolate — no access to BrowserWindow, ipcMain, or webContents.
//
// Claude backend: @anthropic-ai/claude-agent-sdk (clean async API, no JSONL parsing)
// Gemini backend: spawn + readline (stream-json JSONL)

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { compileContext, mergeState, generateHandoff, extractFromModelOutput, mergeExtractedIntoHandoff, readHandoff, writeHandoffWithHistory, updateLatestHandoff, MODEL_CONTEXT_LIMITS } from "./pane-system-prompt.mjs";
import { orchestrateContext } from "./context-orchestrator.mjs";
import { estimateConversationTokens, getModelLimit } from "./token-budget.mjs";
import { extractWithLLM, countHighConfidence, recordCorrections } from "./extraction-tuning.mjs";
import { calculateCost } from "./pricing.mjs";

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

const __dirname = import.meta.dirname;

// Claude: projectId -> AbortController (for graceful cancellation)
const activeControllers = new Map();
// CLI session IDs: projectId -> sessionId (for within-conversation continuity)
// Populated from init events, persisted to SQLite via main process.
const activeSessionIds = new Map(); // unified for both Claude and Gemini
// Gemini: projectId -> child process
const activeProcesses = new Map();
// Intentional aborts: projectId -> boolean
const abortedProjects = new Set();
// Per-request state (used by Gemini normalizer)
const requestStates = new Map();


function getGitStatus(workingDir) {
  try {
    const branch = execSync(
      "git symbolic-ref --short HEAD || git rev-parse --abbrev-ref HEAD",
      { cwd: workingDir, encoding: "utf-8" },
    ).trim();
    const summary = execSync(
      "git status --porcelain=v1 -unormal",
      { cwd: workingDir, encoding: "utf-8" },
    ).trim() || "(clean)";
    return { branch, summary };
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
    // Robustness: gemini CLI might print status messages (non-JSON) on the same line
    // as a JSON event. Try to find the start of the JSON object.
    const braceIdx = line.indexOf('{');
    if (braceIdx !== -1) {
      try {
        parsed = JSON.parse(line.slice(braceIdx));
      } catch {
        return;
      }
    } else {
      return;
    }
  }

  if (!requestStates.has(requestId)) {
    requestStates.set(requestId, {
      lastText: "",
      lastThought: "",
      toolResults: new Map(),
      // Maps Gemini's tool_id → { id: generatedId, name: toolName }
      // Ensures tool_result blocks always reference the same ID that was put in
      // the tool_use block, even when Gemini omits tool_id in one of the events.
      toolIdMap: new Map(),
      lastToolId: null,   // fallback for single-tool turns with no tool_id
      lastToolName: null,
    });
  }
  const state = requestStates.get(requestId);

  try {
    switch (parsed.type) {
      case "init": {
      const sessionId = parsed.session_id || `gemini-${Date.now()}`;
      // Track session ID for resume (mirrors Claude's pattern)
      if (parsed.session_id) {
        activeSessionIds.set(projectId, parsed.session_id);
        sendToMain({ type: "persist_session_id", projectId, sessionId: parsed.session_id, backend: "gemini" });
      }
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
              model: parsed.model || "gemini-3-flash-preview",
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
                  index: 0,
                  delta: { type: "text_delta", text: increment },
                },              },
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
                  index: 0,
                  delta: { type: "thinking_delta", thinking: increment },
                },              },
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
                  index: 0,
                  content_block: {
                    type: "thinking",
                    thinking: currentFullThinking,
                  },
                },              },
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
      // Track so tool_result can recover the same ID and name even if tool_id is absent
      if (parsed.tool_id) state.toolIdMap.set(parsed.tool_id, { id: toolId, name: toolName });
      state.lastToolId = toolId;
      state.lastToolName = toolName;

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
                index: 0,
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
                index: 0,
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
              event: { type: "content_block_stop", index: 0 },
            },
          },
        },
      });
      break;
    }

    case "tool_result": {
      // Recover the exact ID that was placed in the tool_use block.
      // Without this, a missing or mismatched tool_id produces an empty string
      // that never matches the tool_use block's id, so toolResult stays undefined
      // in the renderer and expanded tool panels show nothing.
      const toolEntry = parsed.tool_id ? state.toolIdMap.get(parsed.tool_id) : null;
      const toolId = toolEntry?.id || parsed.tool_id || state.lastToolId || "";
      const toolName = toolEntry?.name || state.lastToolName || "";
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
                      name: toolName,
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
                      name: toolName,
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

      // Emit token_usage event
      const cost = calculateCost({
        model: parsed.model || "gemini-3-flash-preview",
        provider: "gemini",
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedTokens,
      });

      sendToMain({
        type: "event",
        projectId,
        requestId,
        event: {
          event: "token_usage",
          data: {
            provider: "gemini",
            activity_type: "conversation",
            model: parsed.model || "gemini-3-flash-preview",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cachedTokens,
            cost_usd: cost,
            duration_ms: parsed.stats?.duration_ms || 0,
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

    }
  } catch (err) {
    console.error(`[cli-worker] Error processing Gemini line: ${err.message}`, line);
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: {
        event: "error",
        data: { message: `Gemini parsing error: ${err.message}` },
      },
    });
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

// Resolve SDK model aliases to actual model names for analytics
// Resolve SDK model aliases to canonical names for analytics.
// The SDK and CLI use short names; analytics should show one consistent name per model.
const SDK_MODEL_ALIASES = {
  "default": "claude-opus-4-6",
  "opusplan": "claude-opus-4-6",
  "opus": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "sonnet[1m]": "claude-sonnet-4-6",
  "haiku": "claude-haiku-4-5",
  "claude-3-5-sonnet": "claude-sonnet-4-6",
  "claude-3-5-haiku": "claude-haiku-4-5",
  "claude-3-opus": "claude-opus-4-6",
};

async function handleClaudeSpawn({
  projectId,
  requestId,
  prompt,
  workingDir,
  model: rawModel,
  systemPrompt,
  historyLength,
  mcpServerDest,
  tools,
  maxTurns,
  noExec,
  conversationId,
}) {
  // Resolve aliases: "default" → "claude-opus-4-6", "opusplan" → "claude-opus-4-6"
  // The SDK accepts aliases but analytics should show the real model name.
  const model = SDK_MODEL_ALIASES[rawModel?.toLowerCase()] || rawModel;

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

  // ── Write Pane section to CLAUDE.md so Claude SDK uses MCP tools effectively ──
  // Phase directive goes at the top of CLAUDE.md — it's the strongest behavioral
  // contract for Claude SDK. Without this, the agent ignores lean context phase
  // guidance and defaults to "be helpful, start building."
  // Marked with delimiters so user content is never touched.
  try {
    const claudeMdPath = path.join(workingDir, "CLAUDE.md");
    const PANE_START = "<!-- PANE:START -->";
    const PANE_END = "<!-- PANE:END -->";

    // Inject current phase directive at the top of CLAUDE.md
    let phaseDirective = "";
    try {
      const { getPhaseContext } = await import("./workflow-manager.mjs");
      const phaseCtx = getPhaseContext(projectId);
      if (phaseCtx.phase && phaseCtx.phase !== "idle") {
        phaseDirective = `## CURRENT PHASE: ${phaseCtx.phase.toUpperCase()}

${phaseCtx.guidance}

---

`;
      }
    } catch {}

    const paneSection = `${PANE_START}
# Pane Workspace

${phaseDirective}This project is managed by Pane. You have pane_ MCP tools that are faster than manual exploration.

## Tool Priority (follow this order)

1. **explore** — start here for any new area. One query returns files, functions, relationships. Replaces grep→read cycles.
2. **pane_find_symbol** — find any function, class, type by name. Instant. Never use Grep for symbol names.
3. **pane_read_files** — batch read multiple files at once. Never read one at a time when you need several.
4. **pane_codebase_navigator** — dependency map for a file. Never trace imports manually.
5. **pane_find_references** — every usage of a symbol across the codebase.
6. Use Grep only for content pattern matching (regex), not for locating definitions.

## Project Intelligence

- **pane_project_context** — project name, branch, file structure
- **pane_brief** — project decisions, lessons, session history
- **pane_recall** — search project memory for past decisions and context
- **pane_architecture_brief** — locked decisions and patterns for a subsystem
- **pane_ui_constraints** — design rules for component types
- **pane_run_in_terminal** — run tests to verify, don't guess

## Workflow Tools

- **pane_roadmap** — Read or update the project roadmap. Actions: read, create, set_kickoff_field, populate_steps, update_step, add_decision, update_verification, complete_milestone, log_session, skip_milestone, add_milestone, reorder_milestones
  - **set_kickoff_field**: Save a discovery field from the conversation. Call this silently as you learn things — do not mention it to the user. If you call 'create' before you have enough context, the tool will tell you exactly what's still missing.
  - **create**: Create the roadmap with milestones. Will be rejected if required kickoff fields are missing.
- **pane_clarify** — Ask the user a product decision question and pause until they respond. Use for genuine ambiguity only.
- **pane_verify** — Run verification checks (typescript, lint, build, audit) and return structured results.

## Quality Standards

- Never add @ts-nocheck, @ts-ignore, eslint-disable, or 'as any' to suppress errors. Fix root causes.
- Pane's quality gates scan every write and will flag violations.
- Follow existing patterns in the codebase. Don't invent abstractions for one-time operations.
${PANE_END}`;

    let existing = "";
    try { existing = await fsp.readFile(claudeMdPath, "utf-8"); } catch {}

    if (existing.includes(PANE_START)) {
      // Replace existing Pane section, preserve user content
      const before = existing.slice(0, existing.indexOf(PANE_START));
      const after = existing.slice(existing.indexOf(PANE_END) + PANE_END.length);
      await fsp.writeFile(claudeMdPath, before + paneSection + after, "utf-8");
    } else if (existing) {
      // Append Pane section to existing user CLAUDE.md
      await fsp.writeFile(claudeMdPath, existing + "\n\n" + paneSection, "utf-8");
    } else {
      // No CLAUDE.md exists — create with Pane section only
      await fsp.writeFile(claudeMdPath, paneSection + "\n", "utf-8");
    }
  } catch (err) {
    console.warn("[cli-worker] Failed to write CLAUDE.md:", err.message);
  }

  const options = {
    cwd: workingDir,
    model: rawModel || undefined,  // Pass original to SDK (accepts aliases like "default")
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

  // Track tool calls for state hygiene — when the session ends (or resumes),
  // Pane updates session state to reflect what actually happened.
  let hadFileEdits = false;
  let hadVerification = false;

  // Auto-resume across error_max_turns: if the model hits its turn limit mid-task,
  // silently continue rather than surfacing an error. Capped at MAX_AUTO_RESUMES
  // to prevent infinite loops on genuinely stuck sessions.
  const MAX_AUTO_RESUMES = 50;
  // Always attempt to resume a stored session — the SDK server holds the full
  // conversation state for a generous window (24h+). The historyLength gate was
  // causing a race condition: history loads async after mount, so the first
  // message after restart always saw historyLength=0 and dropped the session ID.
  // Genuinely new conversations have no entry in activeSessionIds, so they start
  // fresh naturally. Expired sessions are caught below ("No conversation found")
  // and retried as fresh — no silent failure.
  let resumeSessionId = activeSessionIds.get(projectId) || null;
  let autoResumes = 0;
  let sdkInfoEmitted = false;

  try {
    while (true) {
      let hitMaxTurns = false;
      let maxTurnsSessionId = null;
      let hitStaleSession = false;

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
            activeSessionIds.set(projectId, msg.session_id);
            // Persist to SQLite via main process (survives app restarts)
            sendToMain({ type: "persist_session_id", projectId, sessionId: msg.session_id, backend: "claude" });
          }
          // Fire-and-forget: fetch SDK metadata (models + account) once per session
          Promise.all([
            q.supportedModels?.().catch(() => null),
            q.accountInfo?.().catch(() => null),
          ]).then(([models, account]) => {
            // Always send sdk_init_info on session start — even if models/account are null.
            // This signals a new session started so handleEvent can clear stale rate limit state.
            // The pane-sdk-auth broadcast in handleBackendEvent only fires when account is present.
            sendToMain({
              type: "event",
              projectId,
              requestId,
              event: { event: "sdk_init_info", data: { models, account } },
            });
          });
        }

        // Surface rate limit warnings to the UI
        if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
          sendToMain({
            type: "event",
            projectId,
            requestId,
            event: {
              event: "rate_limit",
              data: msg.rate_limit_info,
            },
          });
        }

        // Transparent max_turns resume — swallow the error, loop back with "continue"
        if (msg.type === "result" && msg.subtype === "error_max_turns") {
          hitMaxTurns = true;
          maxTurnsSessionId = msg.session_id || resumeSessionId;
          break;
        }

        // Stale session ID — the Claude session expired on Anthropic's servers.
        // Clear the stored ID, suppress the error from the renderer, and retry
        // the same prompt as a fresh session. Context arrives via the handoff.
        if (
          msg.type === "result" &&
          msg.subtype === "error" &&
          resumeSessionId &&
          typeof msg.error === "string" &&
          msg.error.includes("No conversation found")
        ) {
          activeSessionIds.delete(projectId);
          resumeSessionId = null;
          // Overwrite the persisted session ID with null so it isn't restored on restart
          sendToMain({ type: "persist_session_id", projectId, sessionId: null, backend: "claude" });
          hitStaleSession = true;
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

          if (msg.message?.usage) {
            const usage = msg.message.usage;
            const cost = calculateCost({
              model: model || "claude-sonnet-4-6",
              provider: "anthropic",
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.cache_read_input_tokens || 0,
              cacheWriteTokens: usage.cache_creation_input_tokens || 0,
            });
            sendToMain({
              type: "event",
              projectId,
              requestId,
              event: {
                event: "token_usage",
                data: {
                  provider: "anthropic",
                  activity_type: "conversation",
                  model: model || "claude-sonnet-4-6",
                  // Anthropic reports input_tokens as non-cached — add cache_read for raw total
                  input_tokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0),
                  output_tokens: usage.output_tokens || 0,
                  cache_creation_input_tokens:
                    usage.cache_creation_input_tokens || 0,
                  cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                  cost_usd: cost,
                  duration_ms: 0,
                },
              },
            });
          }
        }

        // Track tool calls for session state hygiene
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              const name = block.name || "";
              if (name === "Write" || name === "Edit" || name === "write_file" || name === "edit_file"
                  || name === "pane_run_in_terminal") {
                hadFileEdits = true;
              }
            }
          }
        }
        if (msg.type === "user" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result" && !block.is_error) {
              // Check if a test/build command succeeded (crude but effective)
              const output = typeof block.content === "string" ? block.content : "";
              if (output.includes("passed") || output.includes("✓") || output.includes("success")
                  || output.includes("Build complete") || output.includes("0 errors")) {
                hadVerification = true;
              }
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

      // Stale session: retry the same prompt without a session ID
      if (hitStaleSession) continue;

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

    // ── State hygiene: update session state from what actually happened ───
    // Without this, the "continue" problem occurs: session state says todos
    // are pending when the model already completed them, causing the next
    // prompt to re-inject stale objectives.
    try {
      const currentState = readState(projectId);
      const todos = currentState.todos || [];
      if (todos.length > 0 && (hadFileEdits || hadVerification)) {
        let updated = todos.map(t => ({ ...t }));
        let changed = false;

        // Mark in_progress items as completed if the model did real work
        if (hadFileEdits) {
          updated = updated.map(t => {
            if (t.status === "in_progress") {
              changed = true;
              return { ...t, status: "completed" };
            }
            return t;
          });
        }

        // If verification passed, advance: complete current, start next
        if (hadVerification) {
          const inProgress = updated.findIndex(t => t.status === "in_progress");
          if (inProgress !== -1) {
            updated[inProgress] = { ...updated[inProgress], status: "completed" };
            changed = true;
          }
          const nextPending = updated.findIndex(t => t.status === "pending");
          if (nextPending !== -1) {
            updated[nextPending] = { ...updated[nextPending], status: "in_progress" };
            changed = true;
          }
        }

        // If all todos completed, clear activeTask too
        if (updated.every(t => t.status === "completed")) {
          mergeState(projectId, { todos: updated, activeTask: null });
          changed = false; // already written
        }

        if (changed) {
          mergeState(projectId, { todos: updated });
        }
      }
    } catch (err) {
      console.warn("[cli-worker] State hygiene failed (non-fatal):", err.message);
    }

    // ── Turn Sentinel: independently verify the SDK's work ─────────────
    // Runs tsc + eslint on changed files. Quality metric recording happens
    // in punk-engine (main process) when it receives the arbiter_verdict event,
    // because UtilityProcess workers cannot access pane-db.mjs (SQLite).
    if (hadFileEdits) {
      try {
        const { runTurnSentinel } = await import("./code-arbiter.mjs");
        // git diff --name-only (no HEAD) catches both staged and unstaged changes
        const stdout = execSync(
          'git diff --name-only 2>/dev/null || echo ""',
          { cwd: workingDir, encoding: "utf-8", timeout: 5000 },
        );
        const changedFiles = stdout.trim().split("\n").filter(Boolean);
        if (changedFiles.length > 0) {
          const verdict = await runTurnSentinel(projectId, workingDir, changedFiles, { conversationId: conversationId || null });

          sendToMain({
            type: "event",
            projectId,
            requestId,
            event: {
              event: "arbiter_verdict",
              data: { ...verdict, model, provider: "anthropic" },
            },
          });
        }
      } catch (err) {
        console.warn("[cli-worker] Turn sentinel failed:", err.message);
      }
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
      event: {
        event: "processEnded",
        data: {
          exit_code: ac.signal.aborted ? null : 0,
          aborted: ac.signal.aborted,
        },
      },
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
  conversationId,
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
              // Use system node — the MCP server only needs standard Node builtins
              // (fs, path, os, readline, child_process). better-sqlite3 is loaded
              // optionally and degrades gracefully if unavailable.
              command: "node",
              args: [mcpServerDest],
              env: {
                PANE_PROJECT_ID: projectId,
                PANE_PROJECT_ROOT: workingDir,
                HOME: process.env.HOME || os.homedir(),
                PATH: process.env.PATH || "",
              },
              trust: true,
            },
          },
        },
        null,
        2,
      ),
    );
  } catch {}

  // ── Write Pane section to GEMINI.md so Gemini CLI uses MCP tools effectively ──
  try {
    const geminiMdPath = path.join(workingDir, "GEMINI.md");
    const PANE_START = "<!-- PANE:START -->";
    const PANE_END = "<!-- PANE:END -->";

    // Same phase directive as CLAUDE.md
    let geminiPhaseDirective = "";
    try {
      const { getPhaseContext } = await import("./workflow-manager.mjs");
      const phaseCtx = getPhaseContext(projectId);
      if (phaseCtx.phase && phaseCtx.phase !== "idle") {
        geminiPhaseDirective = `## CURRENT PHASE: ${phaseCtx.phase.toUpperCase()}

${phaseCtx.guidance}

---

`;
      }
    } catch {}

    const paneSection = `${PANE_START}
# Pane Workspace

${geminiPhaseDirective}This project is managed by Pane. You have pane_ MCP tools that are faster than manual exploration.

## Tool Priority (follow this order)

1. **explore** — start here for any new area. One query returns files, functions, relationships. Replaces grep→read cycles.
2. **pane_find_symbol** — find any function, class, type by name. Instant. Never grep for symbol names.
3. **pane_read_files** — batch read multiple files at once. Never read one at a time when you need several.
4. **pane_codebase_navigator** — dependency map for a file. Never trace imports manually.
5. **pane_find_references** — every usage of a symbol across the codebase.
6. Use grep only for content pattern matching (regex), not for locating definitions.

## Project Intelligence

- **pane_project_context** — project name, branch, file structure
- **pane_brief** — project decisions, lessons, session history
- **pane_recall** — search project memory for past decisions and context
- **pane_architecture_brief** — locked decisions and patterns for a subsystem
- **pane_ui_constraints** — design rules for component types
- **pane_run_in_terminal** — run tests to verify, don't guess

## Workflow Tools

- **pane_roadmap** — Read or update the project roadmap. Actions: read, create, set_kickoff_field, populate_steps, update_step, add_decision, update_verification, complete_milestone, log_session, skip_milestone, add_milestone, reorder_milestones
  - **set_kickoff_field**: Save a discovery field from the conversation. Call this silently as you learn things — do not mention it to the user. If you call 'create' before you have enough context, the tool will tell you exactly what's still missing.
  - **create**: Create the roadmap with milestones. Will be rejected if required kickoff fields are missing.
- **pane_clarify** — Ask the user a product decision question and pause until they respond. Use for genuine ambiguity only.
- **pane_verify** — Run verification checks (typescript, lint, build, audit) and return structured results.

## Quality Standards

- Never add @ts-nocheck, @ts-ignore, eslint-disable, or 'as any' to suppress errors. Fix root causes.
- Pane's quality gates scan every write and will flag violations.
- Follow existing patterns in the codebase. Don't invent abstractions for one-time operations.
${PANE_END}`;

    let existing = "";
    try { existing = await fsp.readFile(geminiMdPath, "utf-8"); } catch {}

    if (existing.includes(PANE_START)) {
      const before = existing.slice(0, existing.indexOf(PANE_START));
      const after = existing.slice(existing.indexOf(PANE_END) + PANE_END.length);
      await fsp.writeFile(geminiMdPath, before + paneSection + after, "utf-8");
    } else if (existing) {
      await fsp.writeFile(geminiMdPath, existing + "\n\n" + paneSection, "utf-8");
    } else {
      await fsp.writeFile(geminiMdPath, paneSection + "\n", "utf-8");
    }
  } catch (err) {
    console.warn("[cli-worker] Failed to write GEMINI.md:", err.message);
  }

  // ── Session resume: use Gemini's native --resume when session exists ──
  // When resuming, Gemini loads full history from its session file — no
  // preamble needed, just the new prompt. Saves tokens and avoids stale history.
  const geminiResumeId = activeSessionIds.get(projectId) || null;

  let historyPreamble = "";
  if (!geminiResumeId && history && history.length > 0) {
    // No session to resume — manually reconstruct history as preamble (fallback)
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

  // When resuming, send just the prompt — Gemini already has the conversation
  const fullPrompt = geminiResumeId
    ? (systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt)
    : (systemPrompt ? `${systemPrompt}\n\n---\n\n${historyPreamble}${prompt}` : `${historyPreamble}${prompt}`);

  // Prompt is passed via stdin (not -p flag) to avoid shell arg length limits and
  // quoting fragility with large prompts containing code, JSON, or special characters.
  const cmdParts = [
    "gemini",
    "--output-format",
    "stream-json",
    "--approval-mode=yolo",
    "--allowed-mcp-server-names",
    "pane",
  ];
  if (geminiResumeId) cmdParts.push("--resume", geminiResumeId);
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
    // ── Turn Sentinel for Gemini (before processEnded so routing can adjust) ──
    ;(async () => {
      try {
        const { runTurnSentinel } = await import("./code-arbiter.mjs");
        const stdout = execSync(
          'git diff --name-only 2>/dev/null || echo ""',
          { cwd: workingDir, encoding: "utf-8", timeout: 5000 },
        );
        const changedFiles = stdout.trim().split("\n").filter(Boolean);
        if (changedFiles.length > 0) {
          const verdict = await runTurnSentinel(projectId, workingDir, changedFiles, { conversationId: conversationId || null });
          sendToMain({
            type: "event",
            projectId,
            requestId,
            event: {
              event: "arbiter_verdict",
              data: { ...verdict, model, provider: "gemini" },
            },
          });
        }
      } catch (err) {
        console.warn("[cli-worker] Gemini turn sentinel failed:", err.message);
      }

      const wasAborted = abortedProjects.has(projectId);
      if (wasAborted) abortedProjects.delete(projectId);

      // Signal completion after sentinel so routing can use the verdict
      sendToMain({
        type: "event",
        projectId,
        requestId,
        event: {
          event: "processEnded",
          data: { exit_code: wasAborted ? null : code, aborted: wasAborted },
        },
      });
      if (activeProcesses.get(projectId) === child) {
        activeProcesses.delete(projectId);
      }
      requestStates.delete(requestId);

      // Write handoff — enables seamless model swaps FROM Gemini CLI
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
  sqliteChanges,
  conversationId,
}) {
  const command =
    messageCommand || process.env.PANE_CLI_COMMAND;
  if (!command) {
    sendToMain({
      type: "event",
      projectId,
      requestId,
      event: {
        event: "error",
        data: {
          message: `No CLI command specified. Environment: ${process.env.PANE_CLI_COMMAND}`,
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
  }, conversationId);

  const backend = command === "claude" ? "claude-code" : "gemini";

  // ── Context assembly: lean for CLI backends, full for HTTP ──────────────
  // CLI backends (Claude SDK, Gemini CLI) are complete agents with their own
  // tools, context management, and session resumption. They get minimal context
  // (rules + identity + arbiter) and pull project intelligence via MCP tools.
  // HTTP backends need Pane to manage everything — they get the full assembly.
  let context;
  let budgetInfo = null;

  const isCli = command === "claude" || command === "gemini";

  if (isCli) {
    // Lean mode: ~500 tokens instead of 5000. MCP tools provide the rest.
    // Use activeSessionIds as the source of truth — historyLength can be 0
    // on first message after restart (async load race) even with a valid session.
    const isResume = activeSessionIds.has(projectId);
    try {
      context = orchestrateContext(projectId, {
        mode: "lean",
        isResume,
        intent,
        backend,
        conversationId,
      });
      budgetInfo = context.budget;
      console.log(`[cli-worker] Lean context: ${budgetInfo.systemUsed} tokens (resume=${isResume})`);
    } catch (err) {
      console.warn(`[cli-worker] Lean context failed, falling back to full: ${err.message}`);
      context = compileContext(projectId, intent, historyLength, backend, sqliteChanges, conversationId);
    }
  } else {
    // Full mode: budget-aware assembly for HTTP-style backends
    try {
      const conversationTokens = estimateConversationTokens(history || []);
      const result = orchestrateContext(projectId, {
        intent,
        historyLength,
        backend,
        model,
        sqliteChanges,
        conversationTokens,
        conversationId,
      });
      context = result;
      budgetInfo = result.budget;

      if (budgetInfo.layersDropped > 0) {
        console.log(`[cli-worker] Context budget: ${budgetInfo.systemUsed}/${budgetInfo.systemBudget} tokens (${budgetInfo.layersIncluded} layers, dropped: ${budgetInfo.droppedNames.join(", ")})`);
      }
    } catch (err) {
      console.warn(`[cli-worker] Orchestrator failed, falling back to compileContext: ${err.message}`);
      context = compileContext(projectId, intent, historyLength, backend, sqliteChanges, conversationId);
    }
  }

  const basePrompt = systemPromptOverride || context.full;
  const systemPrompt = escalationHint ? `${basePrompt}\n\n${escalationHint}` : basePrompt;

  const home = os.homedir();
  const paneDir = path.join(home, ".pane");

  // Extract MCP server and its dependencies to ~/.pane/ so external node can
  // access them outside .asar. find-references.mjs is a static import inside
  // pane-mcp-server.mjs — it must live alongside it.
  const mcpServerSrc = path.join(__dirname, "pane-mcp-server.mjs");
  const mcpServerDest = path.join(paneDir, "pane-mcp-server.mjs");
  const findRefSrc = path.join(__dirname, "find-references.mjs");
  const findRefDest = path.join(paneDir, "find-references.mjs");
  try {
    await fsp.mkdir(paneDir, { recursive: true });
    const mcpServerContent = await fsp.readFile(mcpServerSrc, "utf-8");
    await fsp.writeFile(mcpServerDest, mcpServerContent, "utf-8");
    const findRefContent = await fsp.readFile(findRefSrc, "utf-8");
    await fsp.writeFile(findRefDest, findRefContent, "utf-8");
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
      conversationId,
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
      conversationId,
    });
  }
}

function handleAbort({ projectId }) {
  // Claude: abort via AbortController
  const ac = activeControllers.get(projectId);
  if (ac) {
    abortedProjects.add(projectId);
    ac.abort();
    activeControllers.delete(projectId);
    return;
  }
  // Gemini: kill child process
  const child = activeProcesses.get(projectId);
  if (child?.pid) {
    abortedProjects.add(projectId);
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
    // Kill entire process group (negative PID) since Gemini CLI spawns with
    // detached: true — killing just the shell orphans the actual CLI process.
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
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
        // Always send processEnded so completionPromise in backend.spawn() resolves.
        // Without this the send_to_punk IPC invoke hangs forever when handleSpawn throws
        // before handleClaudeSpawn/handleGeminiSpawn (which have their own finally blocks).
        sendToMain({
          type: "event",
          projectId: data.projectId,
          requestId: data.requestId,
          event: { event: "processEnded", data: { exit_code: 1, aborted: false } },
        });
      });
      break;
    case "restore_session_id":
      // Main process sends stored session IDs on worker startup
      if (data.projectId && data.sessionId) {
        activeSessionIds.set(data.projectId, data.sessionId);
      }
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
    case "start_login":
      handleStartLogin().catch((err) => {
        sendToMain({ type: "login_result", success: false, error: err.message });
      });
      break;
    case "prefetch_models":
      handlePrefetchModels().catch((err) => {
        console.error("[cli-worker] prefetch_models error:", err.message);
      });
      break;
    case "prefetch_gemini_models":
      handlePrefetchGeminiModels().catch((err) => {
        console.error("[cli-worker] prefetch_gemini_models error:", err.message);
      });
      break;
  }
});

/**
 * Prefetch Gemini models by reading the Gemini CLI's own model configuration.
 * No auth needed — reads from @google/gemini-cli-core's installed models.js.
 */
/**
 * Find the @google/gemini-cli-core package by resolving the `gemini` binary.
 * Returns the package directory path, or null if not found.
 */
async function findGeminiCliCore() {
  try {
    const stdout = execSync("which gemini", { encoding: "utf-8" });
    const binPath = stdout.trim();
    if (!binPath) return null;
    // Resolve symlink: gemini -> ../lib/node_modules/@google/gemini-cli/dist/index.js
    const realBin = fs.realpathSync(binPath);
    // Walk up to the gemini-cli package root, then into node_modules/@google/gemini-cli-core
    const geminiCliRoot = realBin.replace(/\/dist\/.*$/, "");
    const corePath = path.join(geminiCliRoot, "node_modules/@google/gemini-cli-core");
    if (fs.existsSync(corePath)) return corePath;
    return null;
  } catch {
    return null;
  }
}

async function handlePrefetchGeminiModels() {
  try {
    // Resolve the Gemini CLI's core package from its global install location.
    // The CLI worker knows the gemini binary path — resolve its node_modules.
    const geminiCliDir = await findGeminiCliCore();
    if (!geminiCliDir) return;
    const modelsModule = await import(path.join(geminiCliDir, "dist/src/config/models.js"));

    // Read VALID_GEMINI_MODELS set and model constants
    const validModels = modelsModule.VALID_GEMINI_MODELS;
    if (!validModels || validModels.size === 0) return;

    // Context windows for Gemini model families
    const contextFor = (id) => {
      if (id.includes("3.1") || id.includes("3-pro") || id.includes("3-flash")) return 2000000;
      if (id.includes("2.5")) return 1000000;
      return 1000000;
    };

    const displayName = (id) => {
      return id.replace(/^gemini-/, "Gemini ").replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace("Preview", "(Preview)")
        .replace("Customtools", "(Custom Tools)");
    };

    const models = [...validModels]
      .filter((id) => !id.startsWith("auto-")) // Skip auto-routing aliases
      .map((id) => ({
        id,
        name: displayName(id),
        context_length: contextFor(id),
        provider: "Google",
        tier: id.includes("pro") ? 1 : id.includes("flash-lite") ? 3 : 2,
        input_cost: null,
        output_cost: null,
      }))
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return (b.context_length || 0) - (a.context_length || 0);
      });

    if (models.length > 0) {
      sendToMain({
        type: "event",
        projectId: "__prefetch__",
        requestId: "__prefetch__",
        event: { event: "gemini_models", data: { models } },
      });
    }
  } catch (err) {
    console.warn("[cli-worker] prefetch gemini models error:", err.message);
  }
}

/**
 * Initiate Claude OAuth login flow.
 * Starts a minimal session with forceLoginMethod: "claudeai" so the SDK
 * triggers its browser-based auth flow. Streams auth_status messages back
 * to the main process so the renderer can show progress (URL to visit, etc.).
 * Resolves when auth completes or fails.
 */
async function handleStartLogin() {
  const ac = new AbortController();

  const q = query({
    prompt: "hi",
    options: {
      cwd: os.tmpdir(),
      maxTurns: 1,
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      executable: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      permissionMode: "bypassPermissions",
      dangerouslySkipPermissions: true,
      forceLoginMethod: "claudeai",
      abortController: ac,
    },
  });

  try {
    for await (const msg of q) {
      // Forward auth_status messages so renderer can show the login URL/progress
      if (msg.type === "auth_status") {
        sendToMain({
          type: "login_status",
          isAuthenticating: msg.isAuthenticating,
          output: msg.output || [],
          error: msg.error || null,
        });

        // Auth finished (success or failure)
        if (!msg.isAuthenticating) {
          if (msg.error) {
            ac.abort();
            sendToMain({ type: "login_result", success: false, error: msg.error });
            return;
          }
          // Auth complete — fetch account info and report success
          const account = await q.accountInfo?.().catch(() => null);
          ac.abort();
          sendToMain({ type: "login_result", success: true, account: account || null });
          return;
        }
      }

      // If we get system init without needing auth (already authenticated), done
      if (msg.type === "system" && msg.subtype === "init") {
        const account = await q.accountInfo?.().catch(() => null);
        if (account?.email) {
          ac.abort();
          sendToMain({ type: "login_result", success: true, account });
          return;
        }
      }

      if (msg.type === "result") break;
    }
    // Fell through without a result — treat as cancelled
    sendToMain({ type: "login_result", success: false, error: "Login cancelled" });
  } catch (err) {
    if (err.name !== "AbortError") {
      sendToMain({ type: "login_result", success: false, error: err.message });
    }
  }
}

/**
 * Prefetch SDK supported models without starting a real conversation.
 * Starts a minimal query, grabs supportedModels() + accountInfo(), aborts immediately.
 */
async function handlePrefetchModels() {
  const ac = new AbortController();
  const tmpDir = os.tmpdir();

  const q = query({
    prompt: "hi",
    options: {
      cwd: tmpDir,
      maxTurns: 1,
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      executable: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      permissionMode: "bypassPermissions",
      dangerouslySkipPermissions: true,
      abortController: ac,
    },
  });

  try {
    // Wait for init message then immediately fetch models and abort
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        const [models, account] = await Promise.all([
          q.supportedModels?.().catch(() => null),
          q.accountInfo?.().catch(() => null),
        ]);
        ac.abort();
        if (models || account) {
          sendToMain({
            type: "event",
            projectId: "__prefetch__",
            requestId: "__prefetch__",
            event: { event: "sdk_init_info", data: { models, account } },
          });
        }
        break;
      }
      // Abort on any non-init message (shouldn't happen with maxTurns:1)
      if (msg.type === "result") break;
    }
  } catch (err) {
    // AbortError is expected — we intentionally abort after getting models
    if (err.name !== "AbortError") {
      console.error("[cli-worker] prefetch_models query error:", err.message);
    }
  }
}
