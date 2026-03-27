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
import { compileContext, mergeState, readState, getContextLimit, generateHandoff, extractFromModelOutput, mergeExtractedIntoHandoff, writeHandoffWithHistory, updateLatestHandoff, readHandoff } from "./session-context.mjs";
import { extractWithLLM, countHighConfidence, recordCorrections } from "./extraction-tuning.mjs";
import contextManager from "./context-manager.mjs";

// ============================================================================
// HTTP Backend (Kimi/DeepSeek/Anthropic/etc.)
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description:
        "Execute a shell command in the project directory. Use this for building, testing, or verifying changes.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          description: {
            type: "string",
            description: "A brief description of the command's purpose",
          },
          dir_path: {
            type: "string",
            description:
              "The directory to run the command in (defaults to project root)",
          },
          is_background: {
            type: "boolean",
            description: "Set to true to run the command in the background",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate_js",
      description:
        "Evaluate a JavaScript expression in the context of the backend. Use this for diagnostic tasks or testing internal logic.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The JS code to evaluate" },
        },
        required: ["code"],
      },
    },
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
          start_line: {
            type: "number",
            description: "Optional: 1-based line number to start reading from",
          },
          end_line: {
            type: "number",
            description: "Optional: 1-based line number to end reading at",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write the full contents to a file. Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file" },
          content: {
            type: "string",
            description: "The complete content to write",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace",
      description:
        "Edit an existing file by replacing a block of lines with new content. Exact match for old_string is required.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file" },
          instruction: {
            type: "string",
            description: "A clear, semantic instruction for the code change",
          },
          old_string: {
            type: "string",
            description: "Exact lines to be replaced (can be multiple lines)",
          },
          new_string: { type: "string", description: "New lines to insert" },
          allow_multiple: {
            type: "boolean",
            description: "If true, replace all occurrences of old_string",
          },
        },
        required: ["file_path", "instruction", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory.",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Path to directory" },
        },
        required: ["dir_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "List files matching a glob pattern (e.g. 'src/**/*.ts').",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The glob pattern to search for",
          },
          dir_path: {
            type: "string",
            description: "Optional: The directory to search within",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search for a pattern in file contents (ripgrep-like).",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The regular expression pattern to search for",
          },
          dir_path: {
            type: "string",
            description:
              "Optional: Directory or file to search (defaults to project root)",
          },
          include_pattern: {
            type: "string",
            description:
              "Optional: Glob pattern to filter files (e.g., '*.ts')",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_web_search",
      description:
        "Performs a grounded Google Search to find information across the internet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Analyzes and extracts information from URLs.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "A string containing the URL(s) and specific analysis instructions",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_project_context",
      description:
        "Get project name, root path, git branch, and top-level file list. Use this to orient yourself in the project.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_open_files",
      description:
        "Get the file currently open in Pane's editor, including its full content and recent file history.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_recent_terminal",
      description:
        "Get recent terminal commands and their outputs from Pane's terminal.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_run_in_terminal",
      description:
        "Run a shell command and return its output. Use this for builds, tests, git operations, installing packages, or any shell task. Commands run in the project directory with the user's full shell environment including nvm, homebrew, and local tools.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_recall",
      description:
        "Search project memory for past decisions, lessons, patterns, errors, and file edits from previous sessions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search terms to filter memories. Leave empty for recent history.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_remember",
      description:
        "Save something to project memory for future sessions — a decision, lesson, pattern, or important observation.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "lesson", "pattern", "error_fix"],
            description: "Category of memory",
          },
          content: {
            type: "string",
            description: "What to remember — be specific and include context",
          },
        },
        required: ["type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_recall_all",
      description:
        "Search memory across ALL projects — find patterns, decisions, and lessons from other projects that may be relevant here.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms to find across all projects.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_brief",
      description:
        "Read the project's accumulated memory brief — decisions, lessons, frequently modified files, and last session summary.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_checkpoints",
      description:
        "List available file checkpoints for this project. Each checkpoint is a snapshot of file state before a Claude edit.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_change_history",
      description:
        "List the history of file changes made during this session. Shows the file, old content, new content, and timestamp for each change.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_search_changes",
      description:
        "Search for specific changes in the change history. Find changes by file path, content, or description.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to find changes (matches file, content, or description)",
          },
          file_path: {
            type: "string",
            description: "Filter changes to a specific file path",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_revert_change",
      description:
        "Revert a specific change from the change history. This will restore the old content and remove the change from history.",
      parameters: {
        type: "object",
        properties: {
          change_id: {
            type: "string",
            description: "The ID of the change to revert (use pane_change_history to find IDs)",
          },
        },
        required: ["change_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_knowledge_graph",
      description:
        "View the project's knowledge graph — nodes (decisions, patterns, lessons, errors) and their connections, including cross-project pattern links.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_cross_project",
      description:
        "Find patterns, decisions, and lessons from OTHER projects that are relevant to the current work.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for across other projects.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_profile",
      description:
        "View the user's profile — learned preferences, explicit rules, design philosophy, and known anti-patterns.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_set_rule",
      description:
        "Add an explicit rule to the user's profile. Rules override observed preferences.",
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description:
              "The rule to add, e.g. 'always use bun instead of npm' or 'never auto-commit'",
          },
        },
        required: ["rule"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_set_philosophy",
      description: "Update the user's design philosophy.",
      parameters: {
        type: "object",
        properties: {
          philosophy: {
            type: "string",
            description: "The full design philosophy text (replaces existing)",
          },
        },
        required: ["philosophy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_set_why",
      description: "Set this project's foundational purpose — what it is trying to be, who it serves, what problem it solves, and where it is headed. Per-project. Call this once you have understood the project's core purpose through conversation.",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "The project's foundational purpose — a concise narrative covering what it is, who it's for, what problem it solves, and its direction",
          },
        },
        required: ["why"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description:
        "Update the project's TODO list. Use this to track progress and plan future steps.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "The task description",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current status",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Optional: A shorter 'ing' form for the status bar (e.g. 'writing tests')",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Task",
      description:
        "Set the active task that you are currently working on. This is displayed in the Pane status bar.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task description (e.g. 'Fixing login bug')",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_skill",
      description:
        "Activates a specialized agent skill by name. Returns the skill's instructions.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to activate",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "Persists global preferences or facts across ALL future sessions. Use this for recurring instructions like coding styles or personal facts. Do NOT use for session-specific context.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "A concise, global fact or preference (e.g., 'I prefer using tabs')",
          },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_investigator",
      description:
        "Delegate complex codebase analysis, architectural mapping, or bug root-cause investigation to a specialized sub-agent.",
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "A comprehensive description of the research goal",
          },
        },
        required: ["objective"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generalist",
      description:
        "Delegate repetitive batch tasks or high-volume data processing to a general-purpose sub-agent.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The task or question for the generalist agent",
          },
        },
        required: ["request"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cli_help",
      description:
        "Answers questions about Gemini CLI features, documentation, and configuration.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question about Gemini CLI",
          },
        },
        required: ["question"],
      },
    },
  },
];

// ── Phase-based tool lists ─────────────────────────────────────────────────
// planning  — reads + exploration only: model cannot modify files during planning
// execution — all tools: model implements the plan
const WRITE_TOOL_NAMES = new Set([
  "run_shell_command", "write_file", "replace",
  "pane_revert_change", "pane_remember", "pane_set_rule", "pane_set_philosophy", "pane_set_why",
  "TodoWrite", "Task", "activate_skill", "codebase_investigator", "generalist",
  "cli_help", "save_memory",
]);

function getToolsForPhase(phase) {
  if (phase === "planning") {
    // Read/explore only — model cannot modify files during planning
    return TOOL_DEFINITIONS.filter(t => !WRITE_TOOL_NAMES.has(t.function.name));
  }
  // execution — all tools
  return TOOL_DEFINITIONS;
}

function getAnthropicToolsForPhase(phase) {
  return getToolsForPhase(phase).map((td) => ({
    name: td.function.name,
    description: td.function.description,
    input_schema: td.function.parameters,
  }));
}

const ANTHROPIC_TOOLS = TOOL_DEFINITIONS.map((td) => ({
  name: td.function.name,
  description: td.function.description,
  input_schema: td.function.parameters,
}));

// ---------------------------------------------------------------------------
// Auto Todo Advancement — Pane drives status, model just sets content
// ---------------------------------------------------------------------------

const VERIFY_COMMANDS = /\b(jest|vitest|pytest|mocha|karma|test|tsc|build|lint|eslint|check|cargo\s+check|go\s+vet|go\s+build|make)\b/i;

/**
 * Advance todo statuses based on what Pane actually knows happened.
 *
 * Called after each significant tool result. Reads session state, mutates
 * statuses, persists, and emits todos_updated — without the model needing
 * to call TodoWrite.
 *
 * @param {string} projectId
 * @param {'write'|'verify_pass'|'turn_end'} trigger
 * @param {Function} onEvent  — backend event emitter
 * @param {string} requestId
 */
function autoAdvanceTodos(projectId, trigger, onEvent, requestId) {
  const state = readState(projectId);
  const todos = state.todos;
  if (!todos || todos.length === 0) return;

  const hasPending    = todos.some(t => t.status === "pending");
  const hasInProgress = todos.some(t => t.status === "in_progress");
  const allDone       = todos.every(t => t.status === "completed");

  if (allDone) return;

  let updated = todos.map(t => ({ ...t })); // shallow clone
  let changed = false;

  switch (trigger) {
    case "turn_start": {
      // Turn is beginning. If nothing is in_progress, start the first pending.
      // This gives immediate UI feedback that work is happening.
      if (!hasInProgress) {
        const firstPending = updated.findIndex(t => t.status === "pending");
        if (firstPending !== -1) {
          updated[firstPending] = { ...updated[firstPending], status: "in_progress" };
          changed = true;
        }
      }
      break;
    }

    case "write": {
      // A real file change just happened.
      // If nothing is in_progress, start the first pending.
      // If something IS in_progress and a DIFFERENT file is being worked on,
      // complete the current one and advance — heuristic: each write = one todo step.
      if (!hasInProgress) {
        const firstPending = updated.findIndex(t => t.status === "pending");
        if (firstPending !== -1) {
          updated[firstPending] = { ...updated[firstPending], status: "in_progress" };
          changed = true;
        }
      }
      break;
    }

    case "verify_pass": {
      // A verification command (test/build/tsc) just succeeded.
      // The current in_progress step is done — complete it and start the next.
      const inProgressIdx = updated.findIndex(t => t.status === "in_progress");
      if (inProgressIdx !== -1) {
        updated[inProgressIdx] = { ...updated[inProgressIdx], status: "completed" };
        changed = true;
        // Advance to next pending
        const nextPending = updated.findIndex(t => t.status === "pending");
        if (nextPending !== -1) {
          updated[nextPending] = { ...updated[nextPending], status: "in_progress" };
        }
      }
      break;
    }

    case "turn_end": {
      // Turn completed successfully. Mark all in_progress as completed —
      // if the model finished the turn without errors, the work is done.
      let anyCompleted = false;
      updated = updated.map(t => {
        if (t.status === "in_progress") {
          anyCompleted = true;
          return { ...t, status: "completed" };
        }
        return t;
      });
      changed = anyCompleted;
      break;
    }
  }

  if (!changed) return;

  mergeState(projectId, { todos: updated });
  onEvent(
    projectId,
    { event: "todos_updated", data: { todos: updated } },
    requestId,
  );
}

// ============================================================================
// OpenRouter model curation — Pane-aware filter + normalizer
// ============================================================================
//
// Pane is a coding agent. We only want models that are:
//   1. Tool-capable  — agentic tasks require function calling
//   2. Context-adequate — < 16k tokens can't hold a meaningful codebase
//   3. From a coding-capable family — known providers with strong code performance
//   4. Not vision/multimodal-only — those families don't run code tools
//
// Everything else (story generators, image captioners, tiny chat models,
// "free" models with no tool support) is noise for Pane's model picker.
//

// Families known to perform well at coding + agentic tasks.
// Format: [id-prefix, display-provider-name, tier (1=frontier, 2=balanced, 3=fast)]
const CODING_FAMILIES = [
  // Tier 1 — frontier
  ["anthropic/claude-opus",          "Anthropic",  1],
  ["openai/o3",                       "OpenAI",     1],
  ["openai/o4",                       "OpenAI",     1],
  ["openai/gpt-4o",                   "OpenAI",     1],
  ["google/gemini-2.5-pro",           "Google",     1],
  ["google/gemini-2.0-pro",           "Google",     1],
  ["deepseek/deepseek-r1",            "DeepSeek",   1],
  ["x-ai/grok-3",                     "xAI",        1],
  // Tier 2 — balanced
  ["anthropic/claude-sonnet",         "Anthropic",  2],
  ["openai/gpt-4",                    "OpenAI",     2],
  ["openai/o3-mini",                  "OpenAI",     2],
  ["openai/o1",                       "OpenAI",     2],
  ["google/gemini-2.0-flash",         "Google",     2],
  ["google/gemini-2.5-flash",         "Google",     2],
  ["deepseek/deepseek-v3",            "DeepSeek",   2],
  ["deepseek/deepseek-chat",          "DeepSeek",   2],
  ["meta-llama/llama-4",              "Meta",       2],
  ["meta-llama/llama-3.3",            "Meta",       2],
  ["meta-llama/llama-3.1-405",        "Meta",       2],
  ["qwen/qwen3",                      "Qwen",       2],
  ["qwen/qwq",                        "Qwen",       2],
  ["qwen/qwen2.5-coder",              "Qwen",       2],
  ["mistralai/codestral",             "Mistral",    2],
  ["mistralai/mistral-large",         "Mistral",    2],
  ["mistralai/devstral",              "Mistral",    2],
  ["x-ai/grok-2",                     "xAI",        2],
  ["cohere/command-r-plus",           "Cohere",     2],
  // Tier 3 — fast / cheap
  ["anthropic/claude-haiku",          "Anthropic",  3],
  ["openai/gpt-4o-mini",              "OpenAI",     3],
  ["google/gemini-2.0-flash-lite",    "Google",     3],
  ["google/gemini-flash",             "Google",     3],
  ["meta-llama/llama-3.1-70",         "Meta",       3],
  ["meta-llama/llama-3.2",            "Meta",       3],
  ["qwen/qwen2.5-72",                 "Qwen",       3],
  ["mistralai/mistral-small",         "Mistral",    3],
  ["microsoft/phi-4",                 "Microsoft",  3],
];

function _familyFor(modelId) {
  const lower = modelId.toLowerCase();
  for (const [prefix, provider, tier] of CODING_FAMILIES) {
    if (lower.startsWith(prefix)) return { provider, tier };
  }
  return null;
}

function _isPaneModel(m) {
  const params = m.supported_parameters || [];
  const hasTools = params.includes("tools") || params.includes("tool_choice");
  if (!hasTools) return false;
  if ((m.context_length ?? 0) < 16_384) return false;
  return _familyFor(m.id) !== null;
}

function _normalizeModel(m) {
  const family  = _familyFor(m.id);
  // Strip OpenRouter noise from display names: "(self-moderated)", "(extended)",
  // ":nitro", ":floor", ":free" suffixes, and trailing date stamps like " 2024-11"
  const name = (m.name ?? m.id)
    .replace(/\s*\(self-moderated\)/gi, "")
    .replace(/\s*\(extended\)/gi, "")
    .replace(/\s*\(preview\)/gi, " preview")
    .replace(/:\w+$/,             "")   // :nitro, :free, :floor
    .replace(/\s+\d{4}-\d{2}$/,  "")   // trailing " 2024-11" date stamps
    .trim();

  // Pricing in $/Mtok (OpenRouter uses per-token strings like "0.000003")
  const inputMtok  = m.pricing?.prompt   ? parseFloat(m.pricing.prompt)  * 1_000_000 : null;
  const outputMtok = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : null;

  return {
    id:             m.id,
    name,
    context_length: m.context_length,
    provider:       family.provider,
    tier:           family.tier,
    input_cost:     inputMtok  != null ? +inputMtok.toFixed(4)  : null,
    output_cost:    outputMtok != null ? +outputMtok.toFixed(4) : null,
  };
}

function _byRelevance(a, b) {
  // Tier ascending (1 first), then context descending (larger wins ties)
  if (a.tier !== b.tier) return a.tier - b.tier;
  return (b.context_length ?? 0) - (a.context_length ?? 0);
}

export { ApiBackend as HttpBackend }; // backward compat alias

export class ApiBackend extends PunkBackend {
  get supportsToolCalling() { return true; }

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

      let apiKey = settings.http_api_keys?.[provider] || "";

      const baseUrl = settings.http_base_urls?.[provider];

      console.log(
        `[http] getApiConfig: provider=${provider}, hasKey=${!!apiKey}, baseUrl=${baseUrl}`,
      );
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
    const isOpenAI =
      provider === "deepseek" ||
      provider === "kimi" ||
      provider === "openrouter";

    const preFiltered = [];
    // COLLAPSE CONSECUTIVE USER MESSAGES (Retry inflation fix)
    for (const msg of messages) {
      const last = preFiltered[preFiltered.length - 1];
      if (msg.role === "user" && last?.role === "user") {
        preFiltered[preFiltered.length - 1] = msg; // Keep the newest one
      } else {
        preFiltered.push(msg);
      }
    }

    const normalized = [];
    const pendingToolCallIds = new Set();

    for (const msg of preFiltered) {
      const { role, content } = msg;

      if (role === "system") {
        normalized.push(msg);
        continue;
      }

      // --- 1. HANDLE ASSISTANT MESSAGES ---
      if (role === "assistant") {
        if (typeof content === "string") {
          normalized.push(msg);
        } else if (Array.isArray(content)) {
          if (isOpenAI) {
            const text = content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            const toolUses = content.filter((c) => c.type === "tool_use");
            const assistantMsg = { role: "assistant", content: text || "" };

            if (toolUses.length > 0 || msg.tool_calls) {
              const calls =
                msg.tool_calls ||
                toolUses.map((tu) => ({
                  id: tu.id,
                  type: "function",
                  function: {
                    name: tu.name,
                    arguments:
                      typeof tu.input === "string"
                        ? tu.input
                        : JSON.stringify(tu.input),
                  },
                }));
              assistantMsg.tool_calls = calls;
              calls.forEach((tc) => pendingToolCallIds.add(tc.id));
            }
            normalized.push(assistantMsg);
          } else {
            normalized.push(msg);
          }
        }
        continue;
      }

      // --- 2. HANDLE TOOL RESULTS (Strict Sequence Check) ---
      if (
        role === "tool" ||
        (role === "user" &&
          Array.isArray(content) &&
          content.some((c) => c.type === "tool_result"))
      ) {
        const results = [];
        if (role === "tool" && !Array.isArray(content)) {
          results.push(msg);
        } else if (Array.isArray(content)) {
          content.forEach((c) => {
            if (c.type === "tool_result") {
              results.push({
                role: "tool",
                tool_call_id: c.tool_use_id,
                name: c.name,
                content:
                  typeof c.content === "string"
                    ? c.content
                    : JSON.stringify(c.content),
                is_error: c.is_error,
              });
            }
          });
        }

        if (isOpenAI) {
          // OpenAI: MUST be individual messages with 'tool' role
          // and MUST follow assistant tool_calls
          for (const res of results) {
            if (pendingToolCallIds.has(res.tool_call_id)) {
              normalized.push(res);
              pendingToolCallIds.delete(res.tool_call_id);
            } else {
              console.warn(
                `[http] Pruning orphaned tool result for ${res.tool_call_id}`,
              );
            }
          }
        } else {
          normalized.push(msg);
        }
        continue;
      }

      // --- 3. HANDLE USER MESSAGES ---
      if (role === "user") {
        if (typeof content === "string") {
          normalized.push(msg);
        } else if (Array.isArray(content)) {
          const text = content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (isOpenAI) {
            if (text) normalized.push({ role: "user", content: text });
          } else {
            normalized.push(msg);
          }
        }
        continue;
      }
    }

    // --- 4. AUTO-HEAL: Close orphaned tool calls ---
    if (isOpenAI && pendingToolCallIds.size > 0) {
      console.warn(
        `[http] history sequence error: ${pendingToolCallIds.size} tool calls missing results. Healing...`,
      );
      for (const id of pendingToolCallIds) {
        normalized.push({
          role: "tool",
          tool_call_id: id,
          content:
            "Error: Turn was interrupted before tool result could be processed.",
          is_error: true,
        });
      }
    }

    return normalized;
  }

  async getGitStatus(workingDir) {
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

  async spawn(request) {
    const abortController = new AbortController();
    this.activeRequests.set(request.projectId, abortController);

    this.onEvent(
      request.projectId,
      { event: "processStarted", data: null },
      request.requestId,
    );

    // Auto-start: mark first pending todo as in_progress when turn begins
    autoAdvanceTodos(request.projectId, "turn_start", this.onEvent.bind(this), request.requestId);

    try {
      const apiConfig = await this.getApiConfig(request.provider || null);
      console.log(
        `[http] spawn: request.provider=${request.provider}, resolved.provider=${apiConfig.provider}, model=${request.model}, hasKey=${!!apiConfig.apiKey}, prefix=${apiConfig.apiKey?.slice(0, 10)}`,
      );
      this.validateApiConfig(apiConfig);

      const gitStatus = await this.getGitStatus(request.workingDir);

      const historyLength = request.history ? request.history.length : 0;

      // Update session state before compileContext
      const stateUpdate = {
        lastProvider: apiConfig.provider,
        lastIntent: request.intent,
        turnCount: historyLength / 2 + 1,
        gitStatus,
      };
      if (request.todos) {
        stateUpdate.todos = request.todos;
      }
      mergeState(request.projectId, stateUpdate);

      const context = compileContext(
        request.projectId,
        request.intent,
        historyLength,
      );
      let systemPrompt = request.systemPromptOverride
        || (request._systemPrepend ? request._systemPrepend + "\n\n" + context.full : context.full);
      if (request.escalationHint) systemPrompt += `\n\n${request.escalationHint}`;

      // Emit synthetic init event after config is validated
      this.onEvent(
        request.projectId,
        {
          event: "message",
          data: {
            parsed: {
              type: "system",
              subtype: "init",
              session_id: request.sessionId || `http-${Date.now()}`,
              tools: getToolsForPhase(request.phase || "execution"),
              model: request.model || this.getDefaultModel(apiConfig.provider),
            },
          },
        },
        request.requestId,
      );

      const messages = [{ role: "system", content: systemPrompt }];

      if (request.history) {
        for (const msg of request.history) {
          if (msg.type === "user") {
            messages.push({
              role: "user",
              content: msg.content,
            });
          } else if (msg.type === "assistant") {
            messages.push({ role: "assistant", content: msg.content });
          } else if (msg.type === "system") {
            // In Pane history, 'system' role is used for tool results (from local workers)
            messages.push({ role: "tool", content: msg.content });
          }
        }
      }

      console.log(
        `[http] Loaded ${messages.length} messages from history (roles: ${messages.map((m) => m.role).join(", ")})`,
      );

      // Auto-compact conversation if context pressure is high
      const compactionCheck = contextManager.shouldAutoCompact(messages, request.model);
      if (compactionCheck.shouldCompact) {
        console.log(
          `[http] Auto-compacting conversation: ${compactionCheck.reason}, strategy: ${compactionCheck.strategy}`
        );
        
        // Notify frontend that compaction is starting
        this.onEvent(request.projectId, {
          event: "compaction_start",
          data: {
            reason: compactionCheck.reason,
            strategy: compactionCheck.strategy,
          },
        });
        
        const compactedMessages = await contextManager.compactConversation(
          messages,
          request.model,
          compactionCheck.strategy
        );
        
        const stats = contextManager.getStats();
        console.log(
          `[http] Compaction result: ${messages.length} → ${compactedMessages.length} messages ` +
          `(saved ~${stats.tokensSaved} tokens, total compactions: ${stats.totalCompactions})`
        );
        
        // Send compaction completion event
        this.onEvent(request.projectId, {
          event: "compaction_complete",
          data: {
            originalCount: messages.length,
            compactedCount: compactedMessages.length,
            tokensSaved: stats.tokensSaved,
            totalCompactions: stats.totalCompactions,
          },
        });
        
        // Replace messages with compacted version
        messages.splice(0, messages.length, ...compactedMessages);
      }

      messages.push({
        role: "user",
        content: [{ type: "text", text: request.prompt }],
      });

      let turn = 0;
      const maxTurns = 100;
      let sessionOutput = ""; // Accumulate all model text for pattern extraction

      while (turn < maxTurns) {
        turn++;

        const state = {
          accumulated: "",
          toolUses: new Map(),
          finishReason: null,
        };
        this.requestStates.set(request.projectId, state);

        const body = {
          model: this.mapModelName(apiConfig.provider, request.model),
          messages: this.normalizeMessages(messages, apiConfig.provider),
          stream: true,
          max_tokens: 4096,
        };

        if (apiConfig.provider === "openrouter") {
          body.repetition_penalty = 1.1;
        }

        // Phase-based tool filtering — planning phase gets Plan tool, discovery gets read-only
        const phase = request.phase || "execution";
        if (
          apiConfig.provider === "deepseek" ||
          apiConfig.provider === "kimi" ||
          apiConfig.provider === "openrouter"
        ) {
          body.tools = getToolsForPhase(phase);
        } else if (apiConfig.provider === "anthropic") {
          body.tools = getAnthropicToolsForPhase(phase);
        }

        if (request.thinking && apiConfig.provider === "kimi") {
          body.temperature = 1;
          body.max_tokens = 8192;
        }

        if (request.thinking && apiConfig.provider === "openrouter") {
          // OpenRouter standard reasoning toggle
          body.include_reasoning = true;
        }

        const { url, headers, finalBody } = this.prepareRequest(
          apiConfig,
          body,
          request,
        );

        // --- RETRY LOOP FOR TRANSIENT ERRORS ---
        let response;
        let attempt = 0;
        const maxAttempts = 3;

        while (attempt <= maxAttempts) {
          try {
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(finalBody || body),
              signal: abortController.signal,
            });

            // If it's a transient error (5xx or 429), retry
            if (
              !response.ok &&
              (response.status >= 500 || response.status === 429) &&
              attempt < maxAttempts
            ) {
              const delay = Math.pow(2, attempt) * 1000;
              console.warn(
                `[http] Transient error ${response.status}. Retrying in ${delay}ms (Attempt ${attempt + 1}/${maxAttempts})...`,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              attempt++;
              continue;
            }

            // Not a transient error, or we're out of attempts
            break;
          } catch (err) {
            if (err.name === "AbortError") throw err;
            if (attempt < maxAttempts) {
              const delay = Math.pow(2, attempt) * 1000;
              console.warn(
                `[http] Fetch failed: ${err.message}. Retrying in ${delay}ms...`,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              attempt++;
              continue;
            }
            throw err;
          }
        }
        // --- END RETRY LOOP ---

        if (!response.ok) {
          const errorText = await response
            .text()
            .catch(() => response.statusText);
          console.error(`[http] API Error: ${response.status} - ${errorText}`);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        if (!response.body) throw new Error("Response body is null");

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

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
                request.requestId,
              );
              if (emitted) {
                // Content was emitted
              }
            } catch (err) {
              console.error("[punk] Failed to parse SSE data:", err, data);
            }
          }
        }

        const finalContent = [];
        if (state.accumulated) {
          finalContent.push({ type: "text", text: state.accumulated });
          // Accumulate text for pattern extraction in handoff
          sessionOutput += (sessionOutput ? "\n\n" : "") + state.accumulated;
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
        this.onEvent(
          request.projectId,
          {
            event: "message",
            data: {
              parsed: {
                type: "assistant",
                message: { content: finalContent },
              },
            },
          },
          request.requestId,
        );

        messages.push({ role: "assistant", content: finalContent });

        // LOOP CONTROL
        const hasTools = state.toolUses.size > 0;
        const hasContent = state.accumulated.trim().length > 0;
        const isLengthLimited = state.finishReason === "length";
        const isToolCalls = state.finishReason === "tool_calls";

        // If no reason to continue, break
        if (!hasTools && !isLengthLimited && !isToolCalls) break;

        // If it was just a length limit without tools, we continue immediately
        // BUT ONLY IF we actually got some content, otherwise we are likely in a loop
        if (isLengthLimited && !hasTools) {
          if (!hasContent) {
            console.warn(
              `[http] Stopping turn ${turn} - length limit hit but no content or tools produced.`,
            );
            break;
          }
          console.log(
            `[http] Auto-continuing turn ${turn} due to length limit`,
          );
          continue;
        }

        // Execute tools
        const executor = this.getToolExecutor(
          request.projectId,
          request.workingDir,
        );
        const toolResults = [];

        for (const tool of state.toolUses.values()) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tool.input);
          } catch {
            parsedInput = tool.input;
          }

          let result;
          if (tool.name === "evaluate_js") {
            try {
              const fn = new Function(
                "getContextLimit",
                "TOOL_DEFINITIONS",
                `return (${parsedInput.code})`,
              );
              const val = fn(getContextLimit, TOOL_DEFINITIONS);
              result = { success: true, output: JSON.stringify(val, null, 2) };
            } catch (err) {
              result = { success: false, error: err.message };
            }
          } else {
            result = await executor.executeTool(
              tool.id,
              tool.name,
              parsedInput,
            );
          }
          const isError = !result.success;
          const content = result.output || result.error || "";

          if (
            !isError &&
            [
              "run_shell_command",
              "write_file",
              "replace",
              "bash",
              "TodoWrite",
              "Task",
            ].includes(tool.name)
          ) {
            if (tool.name === "TodoWrite" && parsedInput.todos) {
              // Normalize todos format - handle both string[] and Todo[] formats
              let normalizedTodos;
              if (Array.isArray(parsedInput.todos)) {
                if (typeof parsedInput.todos[0] === "string") {
                  // Convert string array to Todo objects with default status
                  normalizedTodos = parsedInput.todos.map((content) => ({
                    content,
                    status: "pending",
                    activeForm: content.split(" ").slice(0, 2).join(" ") + "...",
                  }));
                } else {
                  // Already in correct format
                  normalizedTodos = parsedInput.todos;
                }
              } else {
                normalizedTodos = parsedInput.todos;
              }
              
              mergeState(request.projectId, { todos: normalizedTodos });
              // Send updated todos to frontend
              this.onEvent(
                request.projectId,
                {
                  event: "todos_updated",
                  data: { todos: normalizedTodos },
                },
                request.requestId,
              );
            }
            if (
              tool.name === "Task" &&
              (parsedInput.task || parsedInput.description)
            ) {
              mergeState(request.projectId, {
                activeTask: {
                  description: parsedInput.task || parsedInput.description,
                },
              });
              // Send updated activeTask to frontend
              this.onEvent(
                request.projectId,
                {
                  event: "activeTask_updated",
                  data: { activeTask: { description: parsedInput.task || parsedInput.description } },
                },
                request.requestId,
              );
            }

            // ── Auto-advance todos based on what actually happened ─────────
            // write_file / replace: real work happened → advance first pending
            if (!isError && (tool.name === "write_file" || tool.name === "replace")) {
              autoAdvanceTodos(request.projectId, "write", this.onEvent.bind(this), request.requestId);
            }

            // run_shell_command: if it's a verify command and it passed → complete current step
            if (!isError && tool.name === "run_shell_command") {
              const cmd = (parsedInput.command || "").toLowerCase();
              if (VERIFY_COMMANDS.test(cmd)) {
                autoAdvanceTodos(request.projectId, "verify_pass", this.onEvent.bind(this), request.requestId);
              }
            }
          }

          // Emit tool_result as a "user" message to match CLI worker
          this.onEvent(
            request.projectId,
            {
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
            },
            request.requestId,
          );

          // --- PUSH AS CANONICAL TOOL ROLE ---
          messages.push({
            role: "tool",
            tool_call_id: tool.id,
            name: tool.name,
            content,
            is_error: isError,
          });
        }

        // Always refresh context after tool execution — ensures every turn has fresh state
        // (git status, working set, recent actions, session state, etc.)
        const gitStatus = await this.getGitStatus(request.workingDir);
        mergeState(request.projectId, { gitStatus });

        // Re-compile context to get updated system prompt for the next turn
        const context = compileContext(
          request.projectId,
          request.intent,
          messages.length, // use current length (now includes assistant response + tool results)
        );
        if (messages.length > 0 && messages[0].role === "system") {
          messages[0].content = context.full;
        }
      }

      // Turn completed cleanly — mark all in_progress todos as done
      autoAdvanceTodos(request.projectId, "turn_end", this.onEvent.bind(this), request.requestId);

      // Build handoff document then enrich with pattern extraction — single write at the end.
      // Layer 3: extracted items carry confidence scores.
      // Layer 4: LLM fallback fires when regex found < 2 high-confidence items.
      // Layer 5: model corrections recorded against the previous session's handoff.
      const previousHandoff = readHandoff(request.projectId);
      let handoff = generateHandoff(request.projectId, { writeFile: false });
      if (sessionOutput.length > 0) {
        const extracted = extractFromModelOutput(sessionOutput, request.projectId);
        handoff = mergeExtractedIntoHandoff(handoff, extracted);
        // Layer 5: record corrections now, before writing the new handoff
        if (extracted.corrections?.length > 0) {
          recordCorrections(request.projectId, extracted.corrections, previousHandoff);
        }
        // Layer 4: async LLM fallback when regex yielded too little
        if (countHighConfidence(extracted) < 2 && sessionOutput.length > 500) {
          const quickCallFn = (sys, usr) => {
            const cheapReq = { provider: null, model: null, thinking: false };
            return this.planningCall(sys, usr, cheapReq);
          };
          // Fire-and-forget — initial handoff written below, LLM enrichment replaces it in-place
          // via updateLatestHandoff (not writeHandoffWithHistory) to avoid a duplicate history entry
          extractWithLLM(sessionOutput, quickCallFn).then(llmExtracted => {
            if (Object.keys(llmExtracted).length > 0) {
              const enriched = mergeExtractedIntoHandoff({ ...handoff }, llmExtracted);
              updateLatestHandoff(request.projectId, enriched);
            }
          }).catch(() => {});
        }
      }
      try {
        writeHandoffWithHistory(request.projectId, handoff);
      } catch (err) {
        console.warn(`[http] Failed to write handoff: ${err.message}`);
      }

      this.onEvent(
        request.projectId,
        {
          event: "processEnded",
          data: { exit_code: 0 },
        },
        request.requestId,
      );
    } catch (error) {
      if (error.name === "AbortError") {
        this.onEvent(
          request.projectId,
          {
            event: "processEnded",
            data: { exit_code: null },
          },
          request.requestId,
        );
      } else {
        this.onEvent(
          request.projectId,
          {
            event: "error",
            data: { message: error.message },
          },
          request.requestId,
        );
        this.onEvent(
          request.projectId,
          {
            event: "processEnded",
            data: { exit_code: 1 },
          },
          request.requestId,
        );
      }
    } finally {
      this.activeRequests.delete(request.projectId);
      this.requestStates.delete(request.projectId);
    }
  }

  prepareRequest(apiConfig, body) {
    let url, headers;
    let finalBody = body;

    switch (apiConfig.provider) {
      case "openrouter":
        url =
          apiConfig.baseUrl || "https://openrouter.ai/api/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
          "HTTP-Referer": "https://pane.app",
          "X-Title": "Pane IDE",
        };
        // Disable default OpenRouter transforms (like middle-out) to avoid prompt manipulation
        // and explicitly allow data collection to bypass restrictive 404 guardrails on free models.
        finalBody = {
          ...body,
          transforms: [],
          data_collection: "allow",
          zdr: false,
        };
        break;

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

      case "anthropic": {
        url = apiConfig.baseUrl || "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiConfig.apiKey,
          "anthropic-version": "2023-06-01",
        };
        const sysMsg = body.messages.find((m) => m.role === "system");
        const anthropicBody = { ...body };
        anthropicBody.messages = body.messages.filter(
          (m) => m.role !== "system",
        );
        if (sysMsg) {
          anthropicBody.system = sysMsg.content;
        }
        finalBody = anthropicBody;
        break;
      }

      case "gemini": {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:streamGenerateContent?alt=sse`;
        headers = { "Content-Type": "application/json" };
        url += `&key=${apiConfig.apiKey}`;

        const contents = [];
        const normalized = this.normalizeMessages(body.messages, "gemini");
        for (const msg of normalized) {
          if (msg.role === "user") {
            contents.push({ role: "user", parts: [{ text: msg.content }] });
          } else if (msg.role === "assistant") {
            const parts = [];
            if (msg.thinking) parts.push({ thought: msg.thinking });
            if (msg.content) parts.push({ text: msg.content });
            if (msg.tool_calls) {
              for (const tu of msg.tool_calls) {
                parts.push({
                  functionCall: {
                    name: tu.name,
                    args:
                      typeof tu.input === "string"
                        ? JSON.parse(tu.input)
                        : tu.input,
                  },
                });
              }
            }
            contents.push({ role: "model", parts });
          } else if (msg.role === "tool") {
            contents.push({
              role: "function",
              parts: msg.tool_results.map((tr) => ({
                functionResponse: {
                  name: tr.name,
                  response: { content: tr.content, is_error: tr.is_error },
                },
              })),
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
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_NONE",
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_NONE",
            },
            {
              category: "HARM_CATEGORY_CIVIC_INTEGRITY",
              threshold: "BLOCK_NONE",
            },
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

      default:
        throw new Error(`Unsupported provider: ${apiConfig.provider}`);
    }

    return { url, headers, finalBody };
  }

  getDefaultModel(provider) {
    switch (provider) {
      case "gemini":
        return "gemini-3-flash-preview";
      case "deepseek":
        return "deepseek-chat";
      case "kimi":
        return "moonshot-v1-128k";
      case "anthropic":
        return "claude-sonnet-4-6";
      case "openrouter":
        return "stepfun/step-3.5-flash:free";
      default:
        return "gpt-4";
    }
  }

  mapModelName(provider, model) {
    if (!model) return this.getDefaultModel(provider);

    if (provider === "openrouter") return model;

    if (provider === "gemini") {
      const map = {
        "auto-gemini-3": "gemini-3-flash-preview",
        gemini_flash: "gemini-flash-latest",
        gemini_pro: "gemini-pro-latest",
      };
      return map[model.toLowerCase()] || model;
    }

    if (provider === "deepseek") {
      const map = {
        "deepseek-v3": "deepseek-chat",
        "deepseek-v3.2": "deepseek-chat",
        "deepseek-v3.2-speciale": "deepseek-reasoner",
      };
      return map[model.toLowerCase()] || model;
    }

    if (model.includes("-") && /(\d|v\d)/.test(model)) return model;

    if (provider === "anthropic") {
      const map = {
        opus: "claude-opus-4-6",
        opusplan: "claude-opus-4-6",
        sonnet: "claude-sonnet-4-6",
        haiku: "claude-haiku-4-5-20251001",
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
    let toolDelta = null;
    let emitted = false;

    switch (provider) {
      case "openrouter":
      case "deepseek":
      case "kimi":
        if (event.choices?.[0]?.delta?.content)
          content = event.choices[0].delta.content;

        // Support for reasoning_content (DeepSeek R1 reasoning)
        if (event.choices?.[0]?.delta?.reasoning_content)
          thinking = event.choices[0].delta.reasoning_content;

        // Support for reasoning (OpenRouter standard)
        if (event.choices?.[0]?.delta?.reasoning)
          thinking = event.choices[0].delta.reasoning;

        if (event.choices?.[0]?.delta?.tool_calls) {
          const tc = event.choices[0].delta.tool_calls[0];
          if (tc) {
            const toolId = tc.id;
            const toolName = tc.function?.name || "";
            const toolArgs = tc.function?.arguments || "";

            if (toolId) {
              // Start of a new tool call
              this.onEvent(
                projectId,
                {
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
                },
                requestId,
              );
              state.toolUses.set(toolId, {
                id: toolId,
                name: toolName,
                input: "",
              });
            }

            if (toolArgs) {
              // Find the active tool (OpenAI-style APIs usually send one tool call at a time in a stream)
              // If toolId wasn't provided in this chunk, use the last one we saw
              const activeToolId =
                toolId || Array.from(state.toolUses.keys()).pop();
              if (activeToolId) {
                const tool = state.toolUses.get(activeToolId);
                tool.input += toolArgs;
                toolDelta = { id: activeToolId, partial_json: toolArgs };
              }
            }
          }
        }
        finishReason = event.choices?.[0]?.finish_reason || null;
        if (finishReason) state.finishReason = finishReason;
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
              // Generate unique ID per tool call to prevent collisions within a chunk
              const toolId = `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              const toolName = fc.name;
              const toolArgs = JSON.stringify(fc.args || {});

              // Emit start event immediately
              this.onEvent(
                projectId,
                {
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
                },
                requestId,
              );

              state.toolUses.set(toolId, {
                id: toolId,
                name: toolName,
                input: toolArgs,
              });

              // Emit delta immediately for the whole tool call (Gemini usually sends complete tool calls)
              this.onEvent(
                projectId,
                {
                  event: "message",
                  data: {
                    parsed: {
                      type: "stream_event",
                      event: {
                        type: "content_block_delta",
                        index: 0,
                        delta: {
                          type: "partial_json_delta",
                          partial_json: toolArgs,
                        },
                      },
                    },
                  },
                },
                requestId,
              );
              emitted = true;
            }
          }
        }
        finishReason = event.candidates?.[0]?.finishReason || null;
        if (finishReason) state.finishReason = finishReason;
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
          this.onEvent(
            projectId,
            {
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
            },
            requestId,
          );
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
            toolDelta = {
              id: activeToolId,
              partial_json: event.delta.partial_json,
            };
          }
        }

        if (event.type === "message_stop") {
          state.finishReason = "stop";
          finishReason = "stop";
        }
        break;
    }

    if (toolDelta) {
      this.onEvent(
        projectId,
        {
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
        },
        requestId,
      );
      emitted = true;
    }

    if (thinking) {
      this.onEvent(
        projectId,
        {
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
        },
        requestId,
      );
      emitted = true;
    }

    if (content) {
      state.accumulated += content;
      this.onEvent(
        projectId,
        {
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
        },
        requestId,
      );
      emitted = true;
    }

    if (finishReason && (state.accumulated || state.toolUses.size > 0)) {
      const finalContent = [];
      if (state.accumulated) {
        finalContent.push({ type: "text", text: state.accumulated });
      }
      for (const tool of state.toolUses.values()) {
        // Parse tool input if it's JSON
        let parsedInput = tool.input;
        try {
          if (typeof tool.input === "string") {
            parsedInput = JSON.parse(tool.input);
          }
        } catch {
          // Keep as-is if not valid JSON
        }
        finalContent.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: parsedInput,
        });
      }

      this.onEvent(
        projectId,
        {
          event: "message",
          data: {
            parsed: {
              type: "assistant",
              message: { content: finalContent },
            },
          },
        },
        requestId,
      );
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

  async getOpenRouterModels() {
    const apiConfig = await this.getApiConfig("openrouter");
    if (!apiConfig.apiKey) return [];

    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiConfig.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return [];

      const json = await response.json();
      if (!json.data) return [];

      return json.data.filter(_isPaneModel).map(_normalizeModel).sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch OpenRouter models:", err);
      return [];
    }
  }

// ==========================================================================
// Task Runner Support — Planning Call & Step Execution (class methods)
// ==========================================================================

  /**
   * Make a lightweight API call with no tools — used for task decomposition.
   * Returns the raw text response from the model.
   */
  async planningCall(systemPrompt, userPrompt, request, onChunk) {
    const apiConfig = await this.getApiConfig(request.provider || null);
    this.validateApiConfig(apiConfig);

    const model = this.mapModelName(apiConfig.provider, request.model);

    const body = {
      model,
      messages: this.normalizeMessages([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], apiConfig.provider),
      stream: true,
      // No tools — pure text generation for planning
    };

    const { url, headers, finalBody } = this.prepareRequest(apiConfig, body, request);

    const cleanBody = { ...(finalBody || body), stream: true };
    delete cleanBody.tools;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(cleanBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Planning call failed: HTTP ${response.status}: ${errorText}`);
    }

    // Stream the response — extract text deltas and call onChunk as they arrive
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        let delta = "";
        if (apiConfig.provider === "anthropic") {
          // Anthropic: content_block_delta with text_delta
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
            delta = parsed.delta.text || "";
          }
        } else {
          // OpenAI-compatible (DeepSeek, OpenRouter, Kimi, etc.)
          delta = parsed.choices?.[0]?.delta?.content || "";
        }

        if (delta) {
          fullText += delta;
          if (onChunk) onChunk(delta);
        }
      }
    }

    return fullText;
  }

  /**
   * Multi-turn conversation call (no tools) — used for discovery phase.
   * Takes a full messages array instead of a single user message.
   * Returns the raw text response from the model.
   */
  async conversationCall(systemPrompt, messages, request) {
    const apiConfig = await this.getApiConfig(request.provider || null);
    this.validateApiConfig(apiConfig);

    const model = this.mapModelName(apiConfig.provider, request.model);

    const fullMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const body = {
      model,
      messages: this.normalizeMessages(fullMessages, apiConfig.provider),
      stream: false,
      max_tokens: 2048,
      // No tools — pure conversation for discovery
    };

    const { url, headers, finalBody } = this.prepareRequest(apiConfig, body, request);

    // Strip tools from finalBody if prepareRequest added them
    const cleanBody = { ...(finalBody || body) };
    delete cleanBody.tools;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(cleanBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Conversation call failed: HTTP ${response.status}: ${errorText}`);
    }

    const json = await response.json();

    // Extract text from response based on provider
    if (apiConfig.provider === "anthropic") {
      return json.content?.[0]?.text || "";
    }
    if (apiConfig.provider === "gemini") {
      return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    // OpenAI-compatible (DeepSeek, OpenRouter, Kimi)
    return json.choices?.[0]?.message?.content || "";
  }

  /**
   * Execute a single step — constrained spawn with a custom system prompt.
   * Returns { messages } with the conversation from this step.
   */
  async spawnStep(projectId, prompt, systemOverride, request) {
    const collectedMessages = [];
    const stepRequestId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Wrap onEvent to collect messages for verification
    const originalOnEvent = this.onEvent;
    this.onEvent = (pid, event, rid) => {
      if (pid === projectId && event.event === "message") {
        const parsed = event.data?.parsed;
        if (parsed?.type === "assistant" && parsed.message) {
          collectedMessages.push({ role: "assistant", content: parsed.message.content });
        }
        if (parsed?.type === "user" && parsed.message) {
          collectedMessages.push({ role: "user", content: parsed.message.content });
        }
      }
      // Forward all events to renderer
      originalOnEvent(pid, event, rid);
    };

    try {
      // Create a modified request with the system override.
      // history is always cleared here — execution model gets a narrow job card,
      // not the full conversation. Context comes from the system prompt built by
      // TaskRunner (which synthesizes handoff from Pane's change history).
      const stepRequest = {
        ...request,
        projectId,
        prompt,
        requestId: stepRequestId,
        _systemOverride: systemOverride,
        history: [], // narrow job card: no prior conversation
      };

      await this.spawn(stepRequest);
      return { messages: collectedMessages };
    } finally {
      // Restore original onEvent
      this.onEvent = originalOnEvent;
    }
  }
}
