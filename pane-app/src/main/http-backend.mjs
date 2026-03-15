import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, console } = globalThis;

import { PunkBackend } from "./punk-backend.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import { compileContext, mergeState } from "./session-context.mjs";

// ============================================================================
// HTTP Backend (Kimi/DeepSeek/Anthropic/etc.)
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description: "Execute a shell command in the project directory. Use this for building, testing, or verifying changes.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          description: { type: "string", description: "A brief description of the command's purpose" },
          dir_path: { type: "string", description: "The directory to run the command in (defaults to project root)" },
          is_background: { type: "boolean", description: "Set to true to run the command in the background" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file" },
          start_line: { type: "number", description: "Optional: 1-based line number to start reading from" },
          end_line: { type: "number", description: "Optional: 1-based line number to end reading at" }
        },
        required: ["file_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write the full contents to a file. Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file" },
          content: { type: "string", description: "The complete content to write" }
        },
        required: ["file_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace",
      description: "Edit an existing file by replacing a block of lines with new content. Exact match for old_string is required.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file" },
          instruction: { type: "string", description: "A clear, semantic instruction for the code change" },
          old_string: { type: "string", description: "Exact lines to be replaced (can be multiple lines)" },
          new_string: { type: "string", description: "New lines to insert" },
          allow_multiple: { type: "boolean", description: "If true, replace all occurrences of old_string" }
        },
        required: ["file_path", "instruction", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory.",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Path to directory" }
        },
        required: ["dir_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "List files matching a glob pattern (e.g. 'src/**/*.ts').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern to search for" },
          dir_path: { type: "string", description: "Optional: The directory to search within" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search for a pattern in file contents (ripgrep-like).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regular expression pattern to search for" },
          dir_path: { type: "string", description: "Optional: Directory or file to search (defaults to project root)" },
          include_pattern: { type: "string", description: "Optional: Glob pattern to filter files (e.g., '*.ts')" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "google_web_search",
      description: "Performs a grounded Google Search to find information across the internet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Analyzes and extracts information from URLs.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A string containing the URL(s) and specific analysis instructions" }
        },
        required: ["prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_project_context",
      description: "Get project name, root path, git branch, and top-level file list. Use this to orient yourself in the project.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_open_files",
      description: "Get the file currently open in Pane's editor, including its full content and recent file history.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_recent_terminal",
      description: "Get recent terminal commands and their outputs from Pane's terminal.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_recall",
      description: "Search project memory for past decisions, lessons, patterns, errors, and file edits from previous sessions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms to filter memories. Leave empty for recent history." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_remember",
      description: "Save something to project memory for future sessions — a decision, lesson, pattern, or important observation.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "lesson", "pattern", "error_fix"],
            description: "Category of memory"
          },
          content: { type: "string", description: "What to remember — be specific and include context" }
        },
        required: ["type", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_recall_all",
      description: "Search memory across ALL projects — find patterns, decisions, and lessons from other projects that may be relevant here.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms to find across all projects." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_brief",
      description: "Read the project's accumulated memory brief — decisions, lessons, frequently modified files, and last session summary.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_checkpoints",
      description: "List available file checkpoints for this project. Each checkpoint is a snapshot of file state before a Claude edit.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_knowledge_graph",
      description: "View the project's knowledge graph — nodes (decisions, patterns, lessons, errors) and their connections, including cross-project pattern links.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_cross_project",
      description: "Find patterns, decisions, and lessons from OTHER projects that are relevant to the current work.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for across other projects." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_profile",
      description: "View the user's profile — learned preferences, explicit rules, design philosophy, and known anti-patterns.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_set_rule",
      description: "Add an explicit rule to the user's profile. Rules override observed preferences.",
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The rule to add, e.g. 'always use bun instead of npm' or 'never auto-commit'" }
        },
        required: ["rule"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pane_set_philosophy",
      description: "Update the user's design philosophy.",
      parameters: {
        type: "object",
        properties: {
          philosophy: { type: "string", description: "The full design philosophy text (replaces existing)" }
        },
        required: ["philosophy"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the project's TODO list. Use this to track progress and plan future steps.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "The task description" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status" },
                activeForm: { type: "string", description: "Optional: A shorter 'ing' form for the status bar (e.g. 'writing tests')" }
              },
              required: ["content", "status"]
            }
          }
        },
        required: ["todos"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Task",
      description: "Set the active task that you are currently working on. This is displayed in the Pane status bar.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task description (e.g. 'Fixing login bug')" }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "activate_skill",
      description: "Activates a specialized agent skill by name. Returns the skill's instructions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the skill to activate" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Persists global preferences or facts across ALL future sessions. Use this for recurring instructions like coding styles or personal facts. Do NOT use for session-specific context.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "A concise, global fact or preference (e.g., 'I prefer using tabs')" }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "codebase_investigator",
      description: "Delegate complex codebase analysis, architectural mapping, or bug root-cause investigation to a specialized sub-agent.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "A comprehensive description of the research goal" }
        },
        required: ["objective"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generalist",
      description: "Delegate repetitive batch tasks or high-volume data processing to a general-purpose sub-agent.",
      parameters: {
        type: "object",
        properties: {
          request: { type: "string", description: "The task or question for the generalist agent" }
        },
        required: ["request"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cli_help",
      description: "Answers questions about Gemini CLI features, documentation, and configuration.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question about Gemini CLI" }
        },
        required: ["question"]
      }
    }
  }
];

const ANTHROPIC_TOOLS = TOOL_DEFINITIONS.map(td => ({
  name: td.function.name,
  description: td.function.description,
  input_schema: td.function.parameters
}));

export class HttpBackend extends PunkBackend {
  constructor(onEvent) {
    super(onEvent);
    this.activeRequests = new Map(); // projectId -> AbortController
    this.requestStates = new Map(); // projectId -> { accumulated: string, toolUses: Map }
    this.paneDir = path.join(os.homedir(), ".pane");
    this.toolExecutors = new Map(); // projectId -> ToolExecutor
  }

  getToolExecutor(projectId, projectRoot) {
    let executor = this.toolExecutors.get(projectId);
    if (!executor) {
      executor = new ToolExecutor(projectId, projectRoot, (ev) =>
        this.onEvent(projectId, ev),
      );
      this.toolExecutors.set(projectId, executor);
    }
    return executor;
  }

  /**
   * Load API config for a given provider from settings.json.
   */
  async getApiConfig(providerOverride = null) {
    try {
      const content = await fs.readFile(
        path.join(this.paneDir, "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);

      const provider = providerOverride || settings.http_provider || "deepseek";

      // Multi-key map takes precedence; fall back to legacy single key
      let apiKey = "";
      if (settings.http_api_keys?.[provider]) {
        apiKey = settings.http_api_keys[provider];
      } else if (settings.http_api_key) {
        apiKey = settings.http_api_key;
      }

      let baseUrl;
      if (settings.http_base_urls?.[provider]) {
        baseUrl = settings.http_base_urls[provider];
      } else if (settings.http_base_url) {
        baseUrl = settings.http_base_url;
      }

      return { provider, apiKey, baseUrl };
    } catch {
      return {
        provider: providerOverride || "deepseek",
        apiKey: "",
        baseUrl: undefined,
      };
    }
  }

  validateApiConfig(config) {
    if (!config.apiKey) {
      throw new Error(
        `No API key configured. Open settings (\u2318,) and add a key under API Keys.`,
      );
    }
    return true;
  }

  normalizeMessages(messages, provider) {
    const isAnthropic = provider === "anthropic";
    const isGemini = provider === "gemini";
    const isOpenAI = provider === "deepseek" || provider === "kimi";

    const normalized = [];

    for (const msg of messages) {
      const { role, content } = msg;

      if (role === "system") {
        normalized.push(msg);
        continue;
      }

      if (role === "user") {
        if (typeof content === "string") {
          normalized.push(msg);
          continue;
        }

        if (Array.isArray(content)) {
          // Canonical content is an array of text, tool_result, etc.
          const textBlocks = content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const toolResults = content.filter(c => c.type === "tool_result");

          if (isOpenAI) {
            // OpenAI: tool results must be separate messages with role: "tool"
            // If there's text, send it as a user message first (or combine)
            if (textBlocks) {
              normalized.push({ role: "user", content: textBlocks });
            }
            for (const tr of toolResults) {
              normalized.push({
                role: "tool",
                tool_call_id: tr.tool_use_id,
                content: tr.content
              });
            }
          } else if (isGemini) {
            // Gemini: tool results MUST immediately follow the model message with tool calls.
            // All tool results for the same model turn must be in ONE message.
            if (toolResults.length > 0) {
              normalized.push({
                role: "tool",
                tool_results: toolResults.map(tr => ({
                  name: tr.name,
                  content: tr.content,
                  is_error: tr.is_error
                }))
              });
            }
            if (textBlocks) {
              normalized.push({ role: "user", content: textBlocks });
            }
          } else if (isAnthropic) {
            // Anthropic: can handle text and tool_results in the same user message
            normalized.push({
              role: "user",
              content: content.map(c => {
                if (c.type === "text") return { type: "text", text: c.text };
                if (c.type === "tool_result") {
                  return {
                    type: "tool_result",
                    tool_use_id: c.tool_use_id,
                    content: c.content,
                    is_error: c.is_error
                  };
                }
                return c;
              })
            });
          } else {
            // Default (Gemini or others)
            normalized.push({ role: "user", content: textBlocks || "(tool results)" });
          }
        }
      } else if (role === "assistant") {
        if (typeof content === "string") {
          normalized.push(msg);
          continue;
        }

        if (Array.isArray(content)) {
          const textBlocks = content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const thinkingBlocks = content.filter(c => c.type === "thinking").map(c => c.thinking).join("\n");
          const toolUses = content.filter(c => c.type === "tool_use");

          if (isOpenAI) {
            const assistantMsg = { role: "assistant", content: textBlocks || null };
            if (toolUses.length > 0) {
              assistantMsg.tool_calls = toolUses.map(tu => ({
                id: tu.id,
                type: "function",
                function: {
                  name: tu.name,
                  arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input)
                }
              }));
            }
            normalized.push(assistantMsg);
          } else if (isGemini) {
            const assistantMsg = { role: "assistant", content: textBlocks || null, thinking: thinkingBlocks || null };
            if (toolUses.length > 0) {
              assistantMsg.tool_calls = toolUses.map(tu => ({
                id: tu.id,
                name: tu.name,
                input: tu.input
              }));
            }
            normalized.push(assistantMsg);
          } else if (isAnthropic) {
            const anthropicContent = [];
            if (thinkingBlocks) anthropicContent.push({ type: "thinking", thinking: thinkingBlocks });
            if (textBlocks) anthropicContent.push({ type: "text", text: textBlocks });
            for (const tu of toolUses) {
              anthropicContent.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input
              });
            }
            normalized.push({ role: "assistant", content: anthropicContent });
          } else {
            normalized.push({ role: "assistant", content: textBlocks });
          }
        }
      } else if (role === "tool" && isOpenAI) {
        normalized.push(msg);
      }
    }

    return normalized;
  }

  getHistoryPreamble(history) {
    if (!history || history.length === 0) return "";

    const turns = history
      .filter((m) => m.type === "user" || m.type === "assistant")
      .slice(-10);
    
    if (turns.length === 0) return "";

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
    return lines.join("\n");
  }

  async getGitStatus(workingDir) {
    try {
      const { stdout: branchOut } = await execAsync("git symbolic-ref --short HEAD || git rev-parse --abbrev-ref HEAD", { cwd: workingDir });
      const branch = branchOut.trim();
      const { stdout: statusOut } = await execAsync("git status --porcelain=v1 -unormal", { cwd: workingDir });
      return { branch, summary: statusOut.trim() || "(clean)" };
    } catch {
      return null;
    }
  }

  async spawn(request) {
    const abortController = new AbortController();
    this.activeRequests.set(request.projectId, abortController);

    this.onEvent(request.projectId, { event: "processStarted", data: null }, request.requestId);

    try {
      const apiConfig = await this.getApiConfig(request.provider || null);
      this.validateApiConfig(apiConfig);

      const gitStatus = await this.getGitStatus(request.workingDir);

      const historyLength = request.history ? request.history.length : 0;
      
      // Update session state before compileContext
      mergeState(request.projectId, {
        lastProvider: apiConfig.provider,
        lastIntent: request.intent,
        turnCount: (historyLength / 2) + 1,
        gitStatus
      });

      const context = compileContext(request.projectId, request.intent, historyLength);
      let systemPrompt = context.full;

      if (apiConfig.provider === "gemini") {
        const preamble = this.getHistoryPreamble(request.history);
        if (preamble) {
          systemPrompt = `${systemPrompt}\n\n${preamble}`;
        }
      }

      // Emit synthetic init event after config is validated
      this.onEvent(request.projectId, {
        event: "message",
        data: {
          parsed: {
            type: "system",
            subtype: "init",
            session_id: request.sessionId || `http-${Date.now()}`,
            tools: TOOL_DEFINITIONS,
            model: request.model || this.getDefaultModel(apiConfig.provider),
          },
        },
      }, request.requestId);

      const messages = [{ role: "system", content: systemPrompt }];

      if (request.history) {
        for (const msg of request.history) {
          if (msg.type === "user") {
            messages.push({
              role: "user",
              content: msg.content
            });
          } else if (msg.type === "assistant") {
            messages.push({ role: "assistant", content: msg.content });
          }
        }
      }

      messages.push({ role: "user", content: [{ type: "text", text: request.prompt }] });

      let turn = 0;
      const maxTurns = 10;

      while (turn < maxTurns) {
        turn++;
        const state = {
          accumulated: "",
          toolUses: new Map(),
        };
        this.requestStates.set(request.projectId, state);

        const body = {
          model: this.mapModelName(apiConfig.provider, request.model),
          messages: this.normalizeMessages(messages, apiConfig.provider),
          stream: true,
          max_tokens: 4096,
        };

        if (apiConfig.provider === "deepseek" || apiConfig.provider === "kimi") {
          body.tools = TOOL_DEFINITIONS;
        } else if (apiConfig.provider === "anthropic") {
          body.tools = ANTHROPIC_TOOLS;
        }

        if (request.thinking && apiConfig.provider === "kimi") {
          body.temperature = 1;
          body.max_tokens = 8192;
        }

        const { url, headers, finalBody } = this.prepareRequest(apiConfig, body, request);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(finalBody || body),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response
            .text()
            .catch(() => response.statusText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        if (!response.body) throw new Error("Response body is null");

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let hasEmittedContent = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") break;

            try {
              const parsed = JSON.parse(data);
              const emitted = this.handleStreamEvent(
                request.projectId,
                parsed,
                apiConfig.provider,
                request.requestId
              );
              if (emitted) hasEmittedContent = true;
            } catch (err) {
              console.error("[punk] Failed to parse SSE data:", err, data);
            }
          }
        }

        const finalContent = [];
        if (state.accumulated) {
          finalContent.push({ type: "text", text: state.accumulated });
        }
        for (const tool of state.toolUses.values()) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tool.input);
          } catch {
            parsedInput = tool.input;
          }
          finalContent.push({
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: parsedInput,
          });
        }

        // Final assistant message for this turn
        this.onEvent(request.projectId, {
          event: "message",
          data: {
            parsed: {
              type: "assistant",
              message: { content: finalContent },
            },
          },
        }, request.requestId);

        messages.push({ role: "assistant", content: finalContent });

        // If no tools, we're done
        if (state.toolUses.size === 0) break;

        // Execute tools
        const executor = this.getToolExecutor(request.projectId, request.workingDir);
        const toolResults = [];

        for (const tool of state.toolUses.values()) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tool.input);
          } catch {
            parsedInput = tool.input;
          }

          const result = await executor.executeTool(tool.id, tool.name, parsedInput);
          const isError = !result.success;
          const content = result.output || result.error || "";

          // Emit tool_result as a "user" message to match CLI worker
          this.onEvent(request.projectId, {
            event: "message",
            data: {
              parsed: {
                type: "user",
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: tool.id,
                      name: tool.name,
                      content,
                      is_error: isError,
                    },
                  ],
                },
              },
            },
          }, request.requestId);

          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            name: tool.name,
            content,
            is_error: isError,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      this.onEvent(request.projectId, {
        event: "processEnded",
        data: { exit_code: 0 },
      }, request.requestId);
    } catch (error) {
      if (error.name === "AbortError") {
        this.onEvent(request.projectId, {
          event: "processEnded",
          data: { exit_code: null },
        }, request.requestId);
      } else {
        this.onEvent(request.projectId, {
          event: "error",
          data: { message: error.message },
        }, request.requestId);
        this.onEvent(request.projectId, {
          event: "processEnded",
          data: { exit_code: 1 },
        }, request.requestId);
      }
    } finally {
      this.activeRequests.delete(request.projectId);
      this.requestStates.delete(request.projectId);
    }
  }

  prepareRequest(apiConfig, body, request = {}) {
    let url, headers;
    let finalBody = null;

    switch (apiConfig.provider) {
      case "deepseek":
        url =
          apiConfig.baseUrl || "https://api.deepseek.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        break;
      case "kimi":
        url =
          apiConfig.baseUrl || "https://api.moonshot.cn/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        break;
      case "gemini": {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:streamGenerateContent`;
        headers = { "Content-Type": "application/json" };
        // Gemini has no separate API key header, it's in the URL
        url += `?key=${apiConfig.apiKey}`;

        // Gemini uses a different body structure and needs history
        const contents = [];
        // Gemini uses "user" and "model" roles
        const normalized = this.normalizeMessages(body.messages, "gemini");
        for (const msg of normalized) {
          if (msg.role === "user") {
            contents.push({
              role: "user",
              parts: [{ text: msg.content }]
            });
          } else if (msg.role === "assistant") {
            const parts = [];
            if (msg.thinking) parts.push({ thought: msg.thinking });
            if (msg.content) parts.push({ text: msg.content });
            if (msg.tool_calls) {
              for (const tu of msg.tool_calls) {
                parts.push({
                  functionCall: {
                    name: tu.name,
                    args: typeof tu.input === "string" ? JSON.parse(tu.input) : tu.input
                  }
                });
              }
            }
            contents.push({ role: "model", parts });
          } else if (msg.role === "tool") {
            contents.push({
              role: "function",
              parts: msg.tool_results.map(tr => ({
                functionResponse: {
                  name: tr.name,
                  response: { content: tr.content, is_error: tr.is_error }
                }
              }))
            });
          }
        }

          finalBody = {
            contents,
            tools: [
              {
                functionDeclarations: TOOL_DEFINITIONS.map((td) => ({
                  name: td.function.name,
                  description: td.function.description,
                  parameters: td.function.parameters,
                })),
              },
            ],
            systemInstruction: {
              parts: body.messages
                .filter((m) => m.role === "system")
                .map((m) => ({ text: m.content })),
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
            ],
            generationConfig: {
              temperature: 0,
              topP: 0.95,
              topK: 64,
              maxOutputTokens: 16384,
              responseMimeType: "text/plain",
            },
          };
          break;
        }
      case "anthropic":
        url = apiConfig.baseUrl || "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiConfig.apiKey,
          "anthropic-version": "2023-06-01",
        };
        const sysMsg = body.messages.find(m => m.role === "system");
        finalBody = { ...body };
        finalBody.messages = body.messages.filter((m) => m.role !== "system");
        if (sysMsg) {
          finalBody.system = sysMsg.content;
        }
        break;
      default:
        throw new Error(`Unsupported provider: ${apiConfig.provider}`);
    }

    return { url, headers, finalBody };
  }

  getDefaultModel(provider) {
    switch (provider) {
      case "gemini":
        return "gemini-flash-latest";
      case "deepseek":
        return "deepseek-v3.2";
      case "kimi":
        return "moonshot-v1-128k";
      case "anthropic":
        return "claude-3-5-sonnet-20241022";
      default:
        return "gpt-4";
    }
  }

  mapModelName(provider, model) {
    if (!model) return this.getDefaultModel(provider);

    if (provider === "gemini") {
      const map = {
        "auto-gemini-3": "gemini-3-flash-preview",
        "gemini_flash": "gemini-flash-latest",
        "gemini_pro": "gemini-pro-latest",
      };
      return map[model.toLowerCase()] || model;
    }

    if (model.includes("-") && /(\d|v\d)/.test(model)) return model;

    if (provider === "anthropic") {
      const map = {
        opus: "claude-3-opus-20240229",
        opusplan: "claude-3-opus-20240229",
        sonnet: "claude-3-5-sonnet-20241022",
        haiku: "claude-3-haiku-20240307",
      };
      return map[model.toLowerCase()] || this.getDefaultModel(provider);
    }

    return model;
  }

  handleStreamEvent(projectId, event, provider, requestId) {
    const state = this.requestStates.get(projectId);
    if (!state) return false;

    let content = "";
    let thinking = "";
    let finishReason = null;
    let toolUse = null;
    let toolDelta = null;

    switch (provider) {
      case "deepseek":
      case "kimi":
        if (event.choices?.[0]?.delta?.content)
          content = event.choices[0].delta.content;
        
        // Support for reasoning_content (DeepSeek R1 reasoning)
        if (event.choices?.[0]?.delta?.reasoning_content)
          thinking = event.choices[0].delta.reasoning_content;

        if (event.choices?.[0]?.delta?.tool_calls) {
          const tc = event.choices[0].delta.tool_calls[0];
          if (tc) {
            const toolId = tc.id;
            const toolName = tc.function?.name || "";
            const toolArgs = tc.function?.arguments || "";

            if (toolId) {
              // Start of a new tool call
              this.onEvent(projectId, {
                event: "message",
                data: {
                  parsed: {
                    type: "stream_event",
                    event: {
                      type: "content_block_start",
                      index: state.toolUses.size + 1,
                      content_block: {
                        type: "tool_use",
                        id: toolId,
                        name: toolName,
                        input: {},
                      },
                    },
                  },
                },
              }, requestId);
              state.toolUses.set(toolId, { id: toolId, name: toolName, input: "" });
            }

            if (toolArgs) {
              // Find the active tool (OpenAI-style APIs usually send one tool call at a time in a stream)
              // If toolId wasn't provided in this chunk, use the last one we saw
              const activeToolId = toolId || Array.from(state.toolUses.keys()).pop();
              if (activeToolId) {
                const tool = state.toolUses.get(activeToolId);
                tool.input += toolArgs;
                toolDelta = { id: activeToolId, partial_json: toolArgs };
              }
            }
          }
        }
        finishReason = event.choices?.[0]?.finish_reason;
        break;

      case "gemini":
        if (event.candidates?.[0]?.content?.parts) {
          for (const part of event.candidates[0].content.parts) {
            if (part.text) {
              content = part.text;
            } else if (part.thought) {
              thinking = part.thought;
            } else if (part.functionCall) {
              const fc = part.functionCall;
              const toolId = `gemini_${Date.now()}`; // Gemini doesn't always provide tool ID
              const toolName = fc.name;
              const toolArgs = JSON.stringify(fc.args || {});

              // Start of tool call
              this.onEvent(projectId, {
                event: "message",
                data: {
                  parsed: {
                    type: "stream_event",
                    event: {
                      type: "content_block_start",
                      index: state.toolUses.size + 1,
                      content_block: {
                        type: "tool_use",
                        id: toolId,
                        name: toolName,
                        input: {},
                      },
                    },
                  },
                },
              }, requestId);

              // Gemini usually sends the whole tool call at once in a candidate part
              // So we can just emit it as one chunk
              state.toolUses.set(toolId, { id: toolId, name: toolName, input: toolArgs });
              toolDelta = { id: toolId, partial_json: toolArgs };
            }
          }
        }
        finishReason = event.candidates?.[0]?.finishReason;
        break;

      case "anthropic":
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        )
          content = event.delta.text;

        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "thinking_delta"
        )
          thinking = event.delta.thinking;

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          const tb = event.content_block;
          this.onEvent(projectId, {
            event: "message",
            data: {
              parsed: {
                type: "stream_event",
                event: {
                  type: "content_block_start",
                  index: event.index,
                  content_block: {
                    type: "tool_use",
                    id: tb.id,
                    name: tb.name,
                    input: {},
                  },
                },
              },
            },
          }, requestId);
          state.toolUses.set(tb.id, { id: tb.id, name: tb.name, input: "" });
        }

        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta"
        ) {
          // Anthropic streams tool input here
          const activeToolId = Array.from(state.toolUses.keys()).pop();
          if (activeToolId) {
            const tool = state.toolUses.get(activeToolId);
            tool.input += event.delta.partial_json;
            toolDelta = { id: activeToolId, partial_json: event.delta.partial_json };
          }
        }

        if (event.type === "message_stop") finishReason = "stop";
        break;
    }

    let emitted = false;

    if (toolDelta) {
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0, // index doesn't strictly matter for our UI
              delta: {
                type: "partial_json_delta",
                partial_json: toolDelta.partial_json,
              },
            },
          },
        },
      }, requestId);
      emitted = true;
    }

    if (thinking) {
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: thinking },
            },
          },
        },
      }, requestId);
      emitted = true;
    }

    if (content) {
      state.accumulated += content;
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: content },
            },
          },
        },
      }, requestId);
      emitted = true;
    }

    if (finishReason && (state.accumulated || state.toolUses.size > 0)) {
      const finalContent = [];
      if (state.accumulated) {
        finalContent.push({ type: "text", text: state.accumulated });
      }
      for (const tool of state.toolUses.values()) {
        let parsedInput = {};
        try {
          parsedInput = JSON.parse(tool.input);
        } catch {
          parsedInput = tool.input;
        }
        finalContent.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: parsedInput,
        });
      }

      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "assistant",
            message: { content: finalContent },
          },
        },
      }, requestId);
      emitted = true;
    }

    return emitted;
  }

  async abort(projectId) {
    const controller = this.activeRequests.get(projectId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(projectId);
    }
    this.requestStates.delete(projectId);
  }

  async terminate(projectId) {
    await this.abort(projectId);
  }

  async shutdown() {
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    this.requestStates.clear();
  }
}
