import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execThroughWorker } from "./tool-executor.mjs";

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, console } = globalThis;

import { PunkBackend } from "./punk-backend.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import {
  mergeState,
  readState,
  getContextLimit,
  generateHandoff,
  extractFromModelOutput,
  mergeExtractedIntoHandoff,
  writeHandoffWithHistory,
  updateLatestHandoff,
  readHandoff,
} from "./pane-system-prompt.mjs";
import { orchestrateContext } from "./context-orchestrator.mjs";
import { estimateConversationTokens, estimateTokens, getModelLimit, getDefaultOutputBudget, TOKEN_ESTIMATE_SAFETY, SLIDING_WINDOW_SIZE } from "./token-budget.mjs";
import {
  extractWithLLM,
  countHighConfidence,
  recordCorrections,
} from "./extraction-tuning.mjs";

import { calculateCost } from "./pricing.mjs";
import { safeStringify } from "./sanitize.mjs";
import { buildSummary, toolResultCache } from "./tool-result-cache.mjs";
import { contextStore } from "./context-store.mjs";
import { compactMessages, startCompactionWorker, stopCompactionWorker } from "./compaction-driver.mjs";
import { scoreTurnsByRelevance, selectTurns, base64ToFloat32Array, getTopRelevantSummaries, formatSemanticPool } from "./semantic-turn-selector.mjs";
import { saveTurn, loadTurn, clearTurns } from "./session-turns.mjs";
import {
  openJournal,
  canResume,
  replay,
  clearJournal,
} from "./session-journal.mjs";

import { getPaneDb, pruneConversationMessages } from "./pane-db.mjs";
import { runTurnSentinel, recordQualityMetric, runDeepReview, saveDeepReview } from "./code-arbiter.mjs";
import { getAccessToken, getOAuthHeaders, getOAuthApiUrl, hasOAuthCredentials, invalidateCache } from "./claude-oauth.mjs";
import { buildBillingHeaderValue } from "./claude-signing.mjs";

// ── OAuth body transformation helpers ─────────────────────────────────────

/**
 * Strip cache_control from a system block — billing and identity blocks
 * must not carry cache_control when used as standalone entries.
 *
 * @param {{ type?: string, text?: string, cache_control?: object } | string} block
 * @returns {{ type: string, text: string }}
 */
function stripCacheControl(block) {
  if (typeof block === "string") return { type: "text", text: block };
  const { cache_control: _, ...rest } = block;
  return rest;
}

const TOOL_PREFIX = "mcp_";

// Reverse mapping from prefixed tool names back to original internal names.
// Populated by prefixToolName so that unprefixToolName can always recover
// the exact internal name (e.g. mcp_Run_shell_command → run_shell_command,
// mcp_TodoWrite → TodoWrite).
const toolNameReverseMap = new Map();

/**
 * Prefix a tool name with mcp_ and uppercase the first character.
 * Claude Code uses names like mcp_Bash, mcp_Read — only the first
 * character after mcp_ is uppercased. Fully lowercase names
 * (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 * Matches opencode-claude-auth's prefixName exactly.
 *
 * @param {string} name
 * @returns {string}
 */
function prefixToolName(name) {
  const prefixed = `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  toolNameReverseMap.set(prefixed, name);
  return prefixed;
}

/**
 * Reverse prefixToolName: strips mcp_ prefix and lowercases first character.
 * Used when processing tool_use blocks from API responses — the model returns
 * mcp_-prefixed names but Pane's internal tool registry uses unprefixed names.
 *
 * @param {string} name
 * @returns {string}
 */
function unprefixToolName(name) {
  if (toolNameReverseMap.has(name)) return toolNameReverseMap.get(name);
  if (name.startsWith(TOOL_PREFIX)) {
    const rest = name.slice(TOOL_PREFIX.length);
    return rest.charAt(0).toLowerCase() + rest.slice(1);
  }
  return name;
}

// ============================================================================
// Context Window Manager — Pane-owned conversation lifecycle
// ============================================================================
//
// Pane maintains a model-aware context window:
//   - System prompt: ~4k, always current (managed by orchestrator)
//   - Conversation: up to model_limit - output_reserve, actively pruned
//   - Output reserve: ~8k
//
// Instead of emergency compaction when full, the window is continuously
// managed: old tool results are pruned, oldest turns summarized, stale
// content dropped. The model always has room to work.

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
      name: "pane_directory",
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
      description:
        "Fetches the content of a URL and returns it as plain text. Use this to read documentation, READMEs, GitHub files, API references, or any web page.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          instructions: {
            type: "string",
            description:
              "Optional: specific information to extract or focus on from the page (e.g. 'get the installation steps', 'extract all code snippets')",
          },
        },
        required: ["url"],
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
        "Get the file currently open in Pane's editor, including its full content and recent file history. Working set pre-reads show partial content — use this for the complete file when you need more than what's pre-loaded.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_run_in_terminal",
      description:
        "Run a shell command and return its output. Use this for builds, tests, git operations, installing packages, or any shell task. Commands run in the project directory with the user's full shell environment. Never speculate whether a build or test passes — run it and verify.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds (default 30, max 120).",
          },
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
        "Search project memory for past decisions, lessons, patterns, errors, and file edits from previous sessions. Check this before investigating a bug or making an architectural decision — the answer may already exist from a prior session.",
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
        "Save something to project memory for future sessions — a decision, lesson, pattern, or important observation. Mandatory: call this whenever you discover a root cause, make an architectural decision, or find a non-obvious pattern. Not recording forces the next session to re-discover.",
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
      name: "pane_checkpoint",
      description:
        "Save a checkpoint — a snapshot of the current contents of every modified file — BEFORE you make a risky or large change (a refactor, a deletion, edits you're unsure about). If the change doesn't work out, this exact state can be restored. Cheap and safe to call. Prefer this over hoping an edit is reversible.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "Optional short label for what you're about to do, e.g. 'before auth refactor'.",
          },
        },
        required: [],
      },
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
            description:
              "Search query to find changes (matches file, content, or description)",
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
            description:
              "The ID of the change to revert (use pane_change_history to find IDs)",
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
        "View the project's knowledge graph — nodes (decisions, patterns, lessons, errors) and their connections. Use this to understand blast radius before refactoring: what connects to what you're changing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_cross_project",
      description:
        "Find patterns, decisions, and lessons from OTHER projects that are relevant to the current work. Use proven patterns from existing projects rather than inventing new approaches.",
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
      name: "pane_codebase_compass",
      description:
        "Get a 'neighborhood' of code relevant to your intent. Combines semantic search, structural symbols, and spatial dependency mapping to surface files you should look at. Use this when you are entering a new area of the codebase or need to understand the 'blast radius' of a change.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you are looking for or trying to do",
          },
          limit: {
            type: "number",
            description: "Maximum number of files to return (default 8)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_find_symbol",
      description:
        "Find any exported symbol — function, class, type, interface, constant — by name. Returns exact file and line number instantly from the index. Always call this FIRST when you know the name of something you're looking for. Do not use Grep to find a symbol by name when this tool exists.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Symbol name to find (partial match supported)",
          },
          kind: {
            type: "string",
            enum: [
              "function",
              "class",
              "const",
              "let",
              "var",
              "type",
              "interface",
              "enum",
              "default",
              "namespace",
              "reexport",
              "async_fn",
            ],
            description: "Narrow by symbol kind (optional)",
          },
          file: {
            type: "string",
            description: "Narrow by file path (partial match, optional)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_find_references",
      description:
        "Find every place a symbol is used across the codebase — imports, call sites, JSX usage, and type references. Use after pane_find_symbol to go from declaration to all usages. Grouped by file with surrounding context.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Exact symbol name to find usages of",
          },
          projectRoot: {
            type: "string",
            description: "Absolute path to the project root",
          },
          projectId: {
            type: "string",
            description: "Optional project ID for declaration tagging",
          },
        },
        required: ["symbol", "projectRoot"],
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
        "Add an explicit rule to the user's profile. Rules override observed preferences. Call immediately when the user states a firm preference — do not wait until session end.",
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
      name: "pane_set_about",
      description:
        "Record what this project is — its purpose, identity, and how it works. Per-project. Call this once you have understood the project deeply enough to articulate it clearly. Writes to about.md.",
      parameters: {
        type: "object",
        properties: {
          about: {
            type: "string",
            description:
              "The project's description — what it is, who it's for, the problem it solves, its identity and direction",
          },
        },
        required: ["about"],
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
      name: "ask_user",
      description:
        "Pause and ask the user a question, then STOP and wait for their reply before doing anything else. Use this when you are unsure how to proceed, when you need the user to test something and report back, when a decision is theirs to make, or when you cannot verify your work yourself. Calling this ENDS your turn — you will not continue until the user answers. Do NOT use it to narrate progress or announce what you're about to do; use it only to genuinely request input you cannot obtain on your own.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The specific question or request for the user. Be concrete about exactly what you need from them.",
          },
          context: {
            type: "string",
            description:
              "Optional: brief context on what you did and why you need their input — e.g. what to test, what the options are, what you're unsure about.",
          },
        },
        required: ["question"],
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
      name: "pane_delegate",
      description:
        "Delegate a task to an autonomous sub-agent with full read/write access. The sub-agent inherits the project's playbook (accumulated principles, patterns, and rules) and can read files, write code, run shell commands, search the web, record memories, and create checkpoints. Use this for complex multi-step tasks that are self-contained — e.g. 'add error handling to all API routes', 'refactor the auth module to use the new token format', 'investigate and fix the race condition in the queue worker'. The sub-agent works autonomously until the objective is complete, then returns a summary of changes.",
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
      name: "pane_read_files",
      description:
        "Read multiple files at once and return all their contents in a single response. Use this instead of sequential Read calls when you know you need several files — each sequential read resends the entire conversation, so batching 3 reads into 1 call saves significant overhead. Accepts an array of file paths.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of file paths to read (relative to project root or absolute)",
          },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explore",
      description:
        "Semantic codebase exploration — search by meaning, get the full picture. Returns relevant files, key functions with code excerpts, module relationships, and project constraints. One call replaces multiple grep + read cycles. Use this when you need to understand how something works, find where something is implemented, or get context before making changes.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language description of what you're looking for",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_codebase_navigator",
      description:
        "Build a structural dependency map for a component or symbol — what it imports, what imports it, relevant types, and the suggested read order. Traverses the actual import graph, not semantic search. Use before making changes to understand blast radius.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Component name, file path, or symbol to map (e.g. 'InputBar', 'useProjectsStore')",
          },
          depth: {
            type: "number",
            description: "Traversal depth (1 or 2, default 1)",
          },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_ui_constraints",
      description:
        "Get the hard design constraints for a specific component type before writing any UI code. Returns forbidden Tailwind patterns, design tokens, a reference implementation, and active anti-patterns.",
      parameters: {
        type: "object",
        properties: {
          component: {
            type: "string",
            description:
              "Component type or description, e.g. 'search input', 'floating panel', 'terminal output'",
          },
        },
        required: ["component"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_architecture_brief",
      description:
        "Get the architectural decisions, locked patterns, and gotchas for a specific subsystem before making changes. Returns the pattern in effect, locked decisions, known tensions, and specific failure modes.",
      parameters: {
        type: "object",
        properties: {
          subsystem: {
            type: "string",
            description:
              "Subsystem name or file path (e.g. 'terminal', 'ipc', 'auth')",
          },
        },
        required: ["subsystem"],
      },
    },
  },
  // ── On-demand context tools ──────────────────────────────────────────────
  // These replace pre-loaded context in the system prompt. The model calls
  // them when it actually needs context, instead of Pane guessing upfront.
  {
    type: "function",
    function: {
      name: "pane_get_session_state",
      description:
        "Get the current session state: active task, pending todos, locked decisions, recent actions, and working set. Call this when you need to know what work has been done or what's pending — it is NOT pre-loaded into context.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_get_project_map",
      description:
        "Get the project's file structure — every indexed file with path and type. Call this to understand the codebase layout before exploring. Useful on first turn or when working in unfamiliar areas.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_get_recent_changes",
      description:
        "Get recent file changes: git diff summary, modified files since last turn, and current branch status. Call this to understand what changed recently.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_read_journal",
      description:
        "Read the session journal — a log of all messages, tool results, and progress snapshots from the current and recent sessions. Optionally search by keyword. Use this to recall what happened earlier in the conversation or in a previous session that was interrupted.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional keyword to search for in journal entries. Omit to get the most recent entries.",
          },
          limit: {
            type: "number",
            description: "Maximum number of entries to return (default: 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_get_handoff",
      description:
        "Get the handoff document from the most recent previous session — accomplishments, blockers, next steps, and discoveries. Call this on cold start if you need context about what was done before.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_check_intents",
      description:
        "Check whether other threads are actively working on files in this project. Returns a list of active intents (file touches) from peer threads on the same project root. Use before editing a file to avoid colliding with another agent's in-progress work.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Optional: check for conflicts on a specific file path (relative to project root). Omit to get all active peer intents.",
          },
        },
        required: [],
      },
    },
  },
  // ── Skill tools ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "pane_list_skills",
      description:
        "List all available skills with their names, descriptions, and tags. Use this to discover what specialized capabilities are available before deciding which to activate. Skills are composable capability packages — pentesting, frontend design, API building, code review, etc.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional: filter skills by name or tag (e.g. 'frontend', 'security', 'design')",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_skill_info",
      description:
        "Get detailed information about a specific skill including its full instructions, compose rules (extends, conflicts, requires), and associated tools. Use this when considering whether to activate a skill or when you need to understand its compatibility with other active skills.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to inspect",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deactivate_skill",
      description:
        "Deactivates an active skill by name. Use this when a skill is no longer needed for the current task or when switching to a different domain. Does nothing if the skill isn't active.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to deactivate",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_list_active_skills",
      description:
        "List currently active skills for this project. Use this to see which skills are loaded and influencing the current session — useful before deactivating or when context feels overloaded.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_install_skill",
      description:
        "Install a skill from a GitHub URL or local path. Skills are agent capability packages that specialize the model for specific domains. Supports github: URLs (e.g. 'github:owner/repo/path/to/skill') and local directory paths. Installed skills go to ~/.pane/skills/ and become available for activation immediately.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The skill source — a github: URL (github:owner/repo/path/to/skill) or a local directory path.",
          },
          name: {
            type: "string",
            description: "Optional: rename the skill when installing. Defaults to the directory name.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pane_lens_findings",
      description:
        "Interact with Lens punk findings — the background code analysts that watch the codebase. Use 'list' to read all undismissed findings grouped by punk. Use 'resolve' to mark findings as resolved after fixing them. Use 'run' to trigger a specific punk with an optional task directive.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "resolve", "run"],
            description: "What to do: list findings, resolve them, or run a punk.",
          },
          findingIds: {
            type: "array",
            items: { type: "string" },
            description: "Finding IDs to resolve (required when action is 'resolve').",
          },
          punk: {
            type: "string",
            description: "Punk name to run, e.g. 'ghost', 'ash', 'sage' (required when action is 'run').",
          },
          task: {
            type: "string",
            description: "Optional task directive when running a punk, e.g. 'trace the auth flow and find any bypass'.",
          },
        },
        required: ["action"],
      },
    },
  },
];

// ── Phase-based tool lists ─────────────────────────────────────────────────
// planning  — reads + exploration only: model cannot modify files during planning
// execution — all tools: model implements the plan
const WRITE_TOOL_NAMES = new Set([
  "run_shell_command",
  "pane_run_in_terminal",
  "write_file",
  "replace",
  "pane_revert_change",
  "pane_remember",
  "pane_set_rule",
  "pane_set_philosophy",
  "pane_set_about",
  "TodoWrite",
  "Task",
  "activate_skill",
  "deactivate_skill",
  "pane_install_skill",
  "save_memory",
]);

function getToolsForPhase(phase) {
  // User-facing phases "think"/"analyze" and internal "planning" are all read-only.
  // "build"/"execution" get the full tool set.
  const readOnlyPhases = new Set(["planning", "think", "analyze"]);
  if (readOnlyPhases.has(phase)) {
    // Read/explore only — model cannot modify files during think/planning phases
    return TOOL_DEFINITIONS.filter(
      (t) => !WRITE_TOOL_NAMES.has(t.function.name),
    );
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


// ---------------------------------------------------------------------------
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
  // MiMo — Xiaomi reasoning/agentic models
  ["xiaomi/mimo-v2-pro", "Xiaomi", 1],
  ["xiaomi/mimo-v2-omni", "Xiaomi", 2],
  ["xiaomi/mimo-v2-flash", "Xiaomi", 2],
  // StepFun
  ["stepfun/step-3.5-flash", "StepFun", 2],
  // Kimi / Moonshot
  ["moonshot/moonshot-v1", "Kimi", 2],
  // GLM — Z.ai, thinks before tool calls (more specific first)
  ["z-ai/glm-4.7-flash", "Z.ai", 3],
  ["z-ai/glm-4.7", "Z.ai", 2],
  // Qwen3 Coder — only coding-focused models, no catch-all
  ["qwen/qwen3-coder-next", "Qwen", 1],
  ["qwen/qwen3-coder", "Qwen", 2],
  // MiniMax — multi-agent autonomous
  ["minimax/minimax-m2.7", "MiniMax", 2],
  ["minimax/minimax-m2.5", "MiniMax", 2],
];

function _familyFor(modelId) {
  const lower = modelId.toLowerCase();
  for (const [prefix, provider, tier] of CODING_FAMILIES) {
    if (lower.startsWith(prefix)) return { provider, tier };
  }
  return null;
}

function _normalizeModel(m) {
  const family = _familyFor(m.id) || {
    provider: (m.id.split("/")[0] || "unknown")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    tier: 2,
  };
  // Strip OpenRouter noise from display names: "(self-moderated)", "(extended)",
  // ":nitro", ":floor", ":free" suffixes, and trailing date stamps like " 2024-11"
  const name = (m.name ?? m.id)
    .replace(/\s*\(self-moderated\)/gi, "")
    .replace(/\s*\(extended\)/gi, "")
    .replace(/\s*\(preview\)/gi, " preview")
    .replace(/:\w+$/, "") // :nitro, :free, :floor
    .replace(/\s+\d{4}-\d{2}$/, "") // trailing " 2024-11" date stamps
    // Strip provider prefix from name: "Qwen: Qwen 3.6 Plus" → "Qwen 3.6 Plus"
    // "StepFun: Step 3.5 Flash" → "Step 3.5 Flash"
    .replace(/^[\w.-]+:\s*/, "")
    .trim();

  // Pricing in $/Mtok (OpenRouter uses per-token strings like "0.000003")
  const inputMtok = m.pricing?.prompt
    ? parseFloat(m.pricing.prompt) * 1_000_000
    : null;
  const outputMtok = m.pricing?.completion
    ? parseFloat(m.pricing.completion) * 1_000_000
    : null;

  return {
    id: m.id,
    name,
    context_length: m.context_length,
    provider: family.provider,
    tier: family.tier,
    input_cost: inputMtok != null ? +inputMtok.toFixed(4) : null,
    output_cost: outputMtok != null ? +outputMtok.toFixed(4) : null,
  };
}

function _byRelevance(a, b) {
  // Tier ascending (1 first), then context descending (larger wins ties)
  if (a.tier !== b.tier) return a.tier - b.tier;
  return (b.context_length ?? 0) - (a.context_length ?? 0);
}

// ─── DeepSeek model helpers ──────────────────────────────────────────────────

function _deepSeekDisplayName(id) {
  // Format model IDs: deepseek-xxx-yyy → DeepSeek Xxx Yyy
  // No manual mapping — always reflect what the API serves
  return id
    .replace(/^deepseek-/, "DeepSeek ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function _deepSeekContextLength(id) {
  if (id.includes("reasoner") || id.includes("r1")) return 128000;
  return 128000; // DeepSeek default
}

// ─── Z.ai (GLM) model helpers ────────────────────────────────────────────────

function _zaiDisplayName(id) {
  // glm-5.2 → GLM 5.2, glm-4.7-flash → GLM 4.7 Flash
  return id
    .replace(/^glm-/, "GLM ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function _zaiContextLength(id) {
  if (id.includes("glm-5")) return 1000000;
  if (id.includes("glm-4.7")) return 1000000;
  if (id.includes("glm-4.6")) return 128000;
  if (id.includes("glm-4.5")) return 128000;
  return 128000;
}

// ─── Anthropic model helpers ─────────────────────────────────────────────────

function _anthropicDisplayName(id) {
  // claude-opus-4-6 → Claude Opus 4.6
  return id
    .replace(/^claude-/, "Claude ")
    .replace(/-(\d+)-(\d+)/, " $1.$2")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function _anthropicContextLength(id) {
  // Opus 4.6 and Sonnet 4.6 support 1M with beta flag
  if (id.includes("opus-4-6") || id.includes("sonnet-4-6")) return 1000000;
  if (id.includes("opus-4-5") || id.includes("sonnet-4-5")) return 200000;
  if (id.includes("haiku")) return 200000;
  return 200000;
}

// ─── Model Output Limit Registry ────────────────────────────────────────────
// Maps model-ID substrings to their maximum output token budget.
// Used to set max_tokens per request without hardcoding provider-level logic
// in the hot path. Rules are checked in order — more specific entries first.
//
// Reasoning models (mimo-v2-pro, stepfun) consume thinking tokens from the
// same pool as output tokens, so their budgets are larger.
// StepFun is omitted intentionally — their docs say not to set max_tokens.
//
// If no entry matches, the fallback is DEFAULT_MAX_TOKENS (4096).
const MODEL_OUTPUT_LIMITS = [
  // DeepSeek — V4 models have 384K output (thinking + content share the same pool)
  { match: "deepseek-v4-flash", maxTokens: 384000, omit: false },
  { match: "deepseek-v4-pro", maxTokens: 384000, omit: false },
  // Xiaomi MiMo — thinking tokens count against max_tokens
  { match: "mimo-v2-pro", maxTokens: 65536, omit: false }, // ~16K thinking + 48K output
  { match: "mimo-v2-omni", maxTokens: 65536, omit: false },
  { match: "mimo-v2-flash", maxTokens: 16384, omit: false },
  { match: "mimo", maxTokens: 16384, omit: false }, // future MiMo variants
  // StepFun — docs say not to set max_tokens for reasoning models
  { match: "step-", maxTokens: null, omit: true },
  // Z.ai GLM — 128K max output for GLM-5/4.7/4.6 series, 96K for GLM-4.5
  { match: "glm-5.2", maxTokens: 131072, omit: false },
  { match: "glm-5.1", maxTokens: 131072, omit: false },
  { match: "glm-5-turbo", maxTokens: 131072, omit: false },
  { match: "glm-5", maxTokens: 131072, omit: false },
  { match: "glm-4.7", maxTokens: 131072, omit: false },
  { match: "glm-4.6", maxTokens: 131072, omit: false },
  { match: "glm-4.5", maxTokens: 98304, omit: false }, // 96K
  // Kimi — standard output, 8K is safe
  { match: "moonshot", maxTokens: 8192, omit: false },
  // Qwen / Alibaba
  { match: "qwen", maxTokens: 8192, omit: false },
  // Anthropic (via HTTP path — normally via native SDK)
  { match: "claude", maxTokens: 8192, omit: false },
];

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Providers with explicit cache_control breakpoints that tolerate
 * mid-conversation turn mutations without destroying the cache prefix.
 *
 * Auto-caching providers (DeepSeek, Kimi, Qwen, etc.) cache the
 * conversation body by prefix stability — the first byte that differs
 * from the cached prefix breaks the cache. Mid-body mutations destroy
 * this. These providers skip V4 body-level pruning and rely on the
 * semantic pool in the system prompt session tier + chronological
 * forcePruneToBudget for overflow management.
 */
const PROVIDERS_WITH_EXPLICIT_CACHE = new Set(["anthropic"]);

/**
 * Resolve the max_tokens value for a given model ID.
 * Returns { maxTokens: number | null, omit: boolean }.
 * When omit=true, max_tokens should be deleted from the request body entirely.
 */
function resolveMaxTokens(modelId) {
  if (!modelId) return { maxTokens: DEFAULT_MAX_TOKENS, omit: false };
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_OUTPUT_LIMITS) {
    if (lower.includes(entry.match)) {
      return { maxTokens: entry.maxTokens, omit: entry.omit };
    }
  }
  return { maxTokens: DEFAULT_MAX_TOKENS, omit: false };
}
const MODEL_STREAMING_CONFIG = [
  // DeepSeek V4 Flash/Pro — supports tools + thinking simultaneously
  [
    "deepseek-v4-flash",
    { reasoningField: "reasoning_content", supportsTools: true },
  ],
  [
    "deepseek-v4-pro",
    { reasoningField: "reasoning_content", supportsTools: true },
  ],
  [
    "deepseek/deepseek-v4-flash",
    { reasoningField: "reasoning_content", supportsTools: true },
  ],
  [
    "deepseek/deepseek-v4-pro",
    { reasoningField: "reasoning_content", supportsTools: true },
  ],
  ["deepseek/", { reasoningField: "reasoning_content", supportsTools: true }],
  // Xiaomi MiMo — uses delta.reasoning
  ["xiaomi/mimo", { reasoningField: "reasoning", supportsTools: true }],
  // StepFun — uses delta.reasoning
  ["stepfun/", { reasoningField: "reasoning", supportsTools: true }],
  // Z.ai GLM — thinks before tool calls, uses delta.reasoning_content
  ["z-ai/glm", { reasoningField: "reasoning_content", supportsTools: true }],
  // Kimi / Moonshot — standard content, no reasoning field
  ["moonshot/", { reasoningField: null, supportsTools: true }],
  // Qwen3 Coder — standard content
  ["qwen/qwen3-coder", { reasoningField: null, supportsTools: true }],
  ["qwen/", { reasoningField: null, supportsTools: true }],
  // MiniMax — standard content
  ["minimax/", { reasoningField: null, supportsTools: true }],
  // Frontier providers via OR — standard content
  ["anthropic/", { reasoningField: null, supportsTools: true }],
  ["google/", { reasoningField: null, supportsTools: true }],
  ["openai/", { reasoningField: null, supportsTools: true }],
  ["meta-llama/", { reasoningField: null, supportsTools: true }],
];

function getModelStreamingConfig(modelId) {
  if (!modelId) return { reasoningField: null, supportsTools: true };
  const lower = modelId.toLowerCase();
  for (const [prefix, config] of MODEL_STREAMING_CONFIG) {
    if (lower.startsWith(prefix)) return config;
  }
  return { reasoningField: null, supportsTools: true }; // safe default
}

export { ApiBackend as HttpBackend }; // backward compat alias

// ============================================================================
// Pre-send Message Validator — Phase 1: prevent broken tool sequences
// ============================================================================
// Walks the normalized messages array and validates tool_call→tool_result
// sequencing. Strips orphaned tool_calls from assistant messages and drops
// tool results with no matching tool_call_id in the preceding assistant.
// Called AFTER normalizeMessages() to catch any remaining sequence bugs
// before the request body is built.
//
// Only applies to OpenAI-compatible providers (DeepSeek, OpenRouter, etc.)
// where strict tool_call→tool_result ordering is required.
function validateMessageSequence(messages, provider) {
  const isOpenAI =
    !provider || // no provider means OpenAI-compatible
    provider === "deepseek" ||
    provider === "z-ai" ||
    provider === "kimi" ||
    provider === "openrouter" ||
    provider === "stepfun" ||
    provider === "xiaomi" ||
    provider === "alibaba" ||
    provider === "dashscope";

  if (!isOpenAI || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Walk and track: for each assistant with tool_calls, collect its call IDs.
  // Then as we walk forward, resolve tool messages against the pending set.
  const result = [];
  const pendingToolCallIds = new Set();
  // Stack of {index, ids: Set} per assistant that issued tool_calls.
  // Used to correctly synthesize results after the right assistant.
  const assistantStack = [];

  const synthesizeToolResult = (id) => ({
    role: "tool",
    tool_call_id: id,
    content:
      "Error: Turn was interrupted before tool result could be processed.",
    is_error: true,
  });

  const flushMissingToolResults = (label) => {
    for (const entry of assistantStack.slice().reverse()) {
      if (entry.ids.size > 0) {
        const orphanIds = [...entry.ids];
        console.warn(
          `[http] validateMessageSequence${label}: assistant at index ${entry.index} has ${orphanIds.length} missing tool results — synthesizing`,
        );
        const assistantMsg = result[entry.index];
        if (assistantMsg) {
          const fakeResults = orphanIds.map(synthesizeToolResult);
          result.splice(entry.index + 1, 0, ...fakeResults);
        }
        for (const id of orphanIds) {
          pendingToolCallIds.delete(id);
        }
      }
    }
    assistantStack.length = 0;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Before any non-tool boundary, synthesize missing tool results so DeepSeek
    // never sees an assistant tool_calls message without matching tool messages.
    if (
      msg.role !== "tool" &&
      assistantStack.some((entry) => entry.ids.size > 0)
    ) {
      flushMissingToolResults("");
    }

    // ── Assistant messages ──
    if (msg.role === "assistant") {
      // Collect tool_call IDs from this assistant
      const callIds = (msg.tool_calls || []).map((tc) => tc.id).filter(Boolean);
      // Also check content blocks (Anthropic-style tool_use, though rare in OpenAI path)
      let contentCallIds = [];
      if (Array.isArray(msg.content)) {
        contentCallIds = msg.content
          .filter((c) => c.type === "tool_use")
          .map((c) => c.id)
          .filter(Boolean);
      }
      const allIds = [...callIds, ...contentCallIds];

      if (allIds.length > 0) {
        const idSet = new Set(allIds);
        assistantStack.push({ index: result.length, ids: idSet });
        for (const id of allIds) {
          pendingToolCallIds.add(id);
        }
      }

      result.push(msg);
      continue;
    }

    // ── Tool messages ──
    if (msg.role === "tool") {
      const callId = msg.tool_call_id;
      if (callId && pendingToolCallIds.has(callId)) {
        // Valid — this tool result matches a pending tool call
        pendingToolCallIds.delete(callId);
        // Remove from the relevant assistant's set
        for (let s = assistantStack.length - 1; s >= 0; s--) {
          if (assistantStack[s].ids.has(callId)) {
            assistantStack[s].ids.delete(callId);
            break;
          }
        }
        result.push(msg);
      } else {
        // Orphaned tool result — drop it
        console.warn(
          `[http] validateMessageSequence: dropping orphaned tool result for ${callId}`,
        );
      }
      continue;
    }

    // ── User messages (boundary) ──
    if (msg.role === "user") {
      result.push(msg);
      continue;
    }

    // Pass through system and other messages unchanged
    result.push(msg);
  }

  // End of array: synthesize any remaining unresolved tool calls
  if (assistantStack.length > 0) {
    flushMissingToolResults(" (end)");
  }

  return result;
}

// ============================================================================
// Strip Tool History — heal a 400 "insufficient tool messages" response
// ============================================================================
// Removes ALL tool_calls from assistant messages and ALL tool-role messages.
// Produces a clean user↔assistant conversation that any OpenAI-compatible
// model can process.
function stripToolHistory(messages) {
  return messages
    .map((msg) => {
      // OpenAI: strip tool_calls from assistant messages
      if (msg.role === "assistant" && msg.tool_calls) {
        const cleaned = { ...msg };
        delete cleaned.tool_calls;
        return cleaned;
      }
      // Anthropic: strip tool_use blocks from assistant content, keep text
      if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((c) => c.type === "tool_use")) {
        const textOnly = msg.content.filter((c) => c.type !== "tool_use");
        return { ...msg, content: textOnly.length > 0 ? textOnly : "" };
      }
      return msg;
    })
    .filter((msg) => {
      // OpenAI: drop role:"tool" messages
      if (msg.role === "tool") return false;
      // Anthropic: drop role:"user" messages that are purely tool_result blocks
      if (
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((c) => c.type === "tool_result")
      ) return false;
      return true;
    });
}

export class ApiBackend extends PunkBackend {
  get supportsToolCalling() {
    return true;
  }

  constructor(onEvent) {
    super(onEvent);
    this.activeRequests = new Map(); // projectId -> AbortController
    this.requestStates = new Map(); // projectId -> { accumulated: string, toolUses: Map }
    this.paneDir = path.join(os.homedir(), ".pane");
    this.toolExecutors = new Map(); // projectId -> ToolExecutor
    this._brainRequest = null;
    // Start the compaction worker thread — keeps context compaction off
    // the main process event loop.
    startCompactionWorker();
  }

  setBrainRequest(fn) {
    this._brainRequest = fn;
    // Update existing executors
    for (const executor of this.toolExecutors.values()) {
      if (executor.setBrainRequest) executor.setBrainRequest(fn);
    }
  }

  setQuickCall(fn) {
    this._quickCall = fn;
    for (const executor of this.toolExecutors.values()) {
      if (executor.setQuickCall) executor.setQuickCall(fn);
    }
  }

  setAgentCall(fn) {
    this._agentCall = fn;
    for (const executor of this.toolExecutors.values()) {
      if (executor.setAgentCall) executor.setAgentCall(fn);
    }
  }

  setRunPunk(fn) {
    this._runPunk = fn;
    for (const executor of this.toolExecutors.values()) {
      if (executor.setRunPunk) executor.setRunPunk(fn);
    }
  }

  getToolExecutor(projectId, projectRoot) {
    let executor = this.toolExecutors.get(projectId);
    if (!executor) {
      executor = new ToolExecutor(projectId, projectRoot, (ev) =>
        this.onEvent(projectId, ev),
      );
      if (this._brainRequest && executor.setBrainRequest) {
        executor.setBrainRequest(this._brainRequest);
      }
      if (this._quickCall && executor.setQuickCall) {
        executor.setQuickCall(this._quickCall);
      }
      if (this._agentCall && executor.setAgentCall) {
        executor.setAgentCall(this._agentCall);
      }
      if (this._runPunk && executor.setRunPunk) {
        executor.setRunPunk(this._runPunk);
      }
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

      // Normalize "-api" suffixed providers to base name for key lookup and API calls.
      // "anthropic-api" → "anthropic", "gemini-api" → "gemini"
      const rawProvider =
        providerOverride || settings.http_provider || "deepseek";
      const provider = rawProvider.replace(/-api$/, "");

      let apiKey = settings.http_api_keys?.[provider] || "";
      let authType = apiKey ? "api_key" : undefined;

      // If no API key for anthropic, try OAuth tokens from Claude Code keychain
      if (provider === "anthropic" && !apiKey) {
        try {
          if (await hasOAuthCredentials()) {
            authType = "oauth";
            console.log("[http] getApiConfig: using Claude OAuth tokens (no API key)");
          }
        } catch (err) {
          console.warn("[http] getApiConfig: OAuth check failed:", err.message);
        }
      }

      const baseUrl = settings.http_base_urls?.[provider];

      // Log which keys are actually present so routing failures are easy to diagnose
      const presentKeys = Object.entries(settings.http_api_keys || {})
        .filter(([, v]) => !!v)
        .map(([k]) => k);
      console.log(
        `[http] getApiConfig: provider=${provider}, hasKey=${!!apiKey}, authType=${authType || "api_key"}, baseUrl=${baseUrl}, presentKeys=[${presentKeys.join(",")}]`,
      );
      return { provider, apiKey, baseUrl, authType };
    } catch {
      return {
        provider: providerOverride || "deepseek",
        apiKey: "",
        baseUrl: undefined,
        authType: undefined,
      };
    }
  }

  validateApiConfig(config) {
    if (!config.apiKey && config.authType !== "oauth") {
      const msg = config.provider === "anthropic"
        ? `Not signed in to Claude. Open settings (\u2318,) and click "sign in with claude.ai", or add an Anthropic API key.`
        : `No API key configured. Open settings (\u2318,) and add a key under API Keys.`;
      throw new Error(msg);
    }
    return true;
  }

  normalizeMessages(messages, provider, model = null, context = null) {
    const isDeepSeek =
      provider === "deepseek" ||
      model?.toLowerCase().includes("deepseek") ||
      (provider === "openrouter" && model?.toLowerCase().includes("deepseek"));

    const isOpenAI =
      isDeepSeek ||
      provider === "z-ai" ||
      provider === "kimi" ||
      provider === "openrouter" ||
      provider === "stepfun" ||
      provider === "xiaomi" ||
      provider === "alibaba" ||
      provider === "dashscope";

    // DeepSeek thinking models:
    // REQUIRES passing reasoning_content back on every turn to avoid 400 errors.
    const isReasoner =
      isDeepSeek &&
      (model?.includes("reasoner") ||
        model?.includes("r1") ||
        model?.includes("prover") || // deepseek-prover-v2 is math-only, no tool support
        model?.includes("thinking"));

    // ── _resultRef resolution ──────────────────────────────────────────────
    // Messages from the backend's messages[] array have _resultRef pointers
    // instead of full tool result content. We ALWAYS resolve to full content
    // for cache stability — if the content at a given position changes between
    // API calls (e.g., from full content to summary), the provider's prefix
    // cache is invalidated from that point forward, destroying the cache rate.
    //
    // The messages[] array maintains memory efficiency with summaries; the
    // ToolResultStore holds the full content. We resolve here for the API
    // request body only.
    const resolveResultRef = (msg) => {
      if (!msg._resultRef || !context) return msg;
      try {
        const resolved = toolResultCache.resolve(
          context.projectId,
          msg._resultRef.turn,
          msg._resultRef.seq,
        );
        if (resolved) {
          const copy = { ...msg };
          copy.content = resolved;
          delete copy._resultRef;
          delete copy._contentLength;
          return copy;
        }
      } catch {
        // Non-fatal — summary in msg.content is sufficient
      }
      return msg;
    };

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
    let lastToolCallAssistantIndex = -1;

    for (const msg of preFiltered) {
      const { role, content } = msg;

      if (role === "system") {
        // Tool results stored as system messages in front-end conversation
        // history (handlePunkMessage stores tool results as type: "system").
        // For OpenAI-compatible APIs (DeepSeek etc.), these MUST become
        // role: "tool" messages to satisfy strict tool_call→tool sequencing.
        // System messages with tool_results bypass the normal tool handler
        // below, so we handle them here.
        if (
          Array.isArray(content) &&
          content.some((c) => c.type === "tool_result")
        ) {
          if (isOpenAI) {
            for (const c of content) {
              if (c.type === "tool_result") {
                const res = {
                  role: "tool",
                  tool_call_id: c.tool_use_id,
                  name: c.name,
                  content:
                    typeof c.content === "string"
                      ? c.content
                      : safeStringify(c.content),
                  is_error: c.is_error,
                };
                if (pendingToolCallIds.has(res.tool_call_id)) {
                  normalized.push(res);
                  pendingToolCallIds.delete(res.tool_call_id);
                } else {
                  console.warn(
                    `[http] Pruning orphaned tool result (from system msg) for ${res.tool_call_id}`,
                  );
                }
              }
            }
          } else {
            // Anthropic: convert system-stored tool_result blocks to role:"user" batched message
            for (const c of content) {
              if (c.type === "tool_result") {
                const block = {
                  type: "tool_result",
                  tool_use_id: c.tool_use_id,
                  content: typeof c.content === "string" ? c.content : safeStringify(c.content),
                };
                if (c.is_error) block.is_error = true;
                pendingToolCallIds.delete(c.tool_use_id);
                const prev = normalized[normalized.length - 1];
                if (
                  prev?.role === "user" &&
                  Array.isArray(prev.content) &&
                  prev.content.every((b) => b.type === "tool_result")
                ) {
                  prev.content.push(block);
                } else {
                  normalized.push({ role: "user", content: [block] });
                }
              }
            }
          }
          continue;
        }
        // Preserve _tiers metadata through normalization — prepareRequest()
        // needs it for Anthropic cache breakpoints. It's stripped there before
        // the request body is serialized.
        normalized.push(msg);
        continue;
      }

      // --- 1. HANDLE ASSISTANT MESSAGES ---
      if (role === "assistant") {
        if (isOpenAI) {
          const assistantMsg = { role: "assistant", content: "" };

          // 1. Extract potential reasoning (verbatim field or from thinking blocks)
          let reasoning = undefined;
          if (msg.reasoning_content !== undefined) {
            reasoning = msg.reasoning_content;
          } else if (Array.isArray(content)) {
            reasoning = content
              .filter((c) => c.type === "thinking")
              .map((c) => c.thinking)
              .join("\n")
              .trim();
          }

          // 2. Extract text content
          if (typeof content === "string") {
            assistantMsg.content = content;
          } else if (Array.isArray(content)) {
            assistantMsg.content = content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          }

          // 3. Handle tool calls (omitted for Reasoner, which doesn't support them)
          if (
            !isReasoner &&
            (msg.tool_calls ||
              (Array.isArray(content) &&
                content.some((c) => c.type === "tool_use")))
          ) {
            const toolUses = Array.isArray(content)
              ? content.filter((c) => c.type === "tool_use")
              : [];
            const rawCalls =
              msg.tool_calls ||
              toolUses.map((tu) => ({
                id: tu.id,
                type: "function",
                function: {
                  name: tu.name,
                  arguments: tu.input,
                },
              }));

            const calls = rawCalls.map((tc) => {
              let args = tc.function?.arguments || "";
              if (typeof args === "string") {
                try {
                  const trimmed = args.trim();
                  if (!trimmed) {
                    args = "{}";
                  } else {
                    const parsed = JSON.parse(trimmed);
                    if (parsed === null || typeof parsed !== "object") {
                      args = "{}";
                    } else {
                      args = trimmed;
                    }
                  }
                } catch {
                  args = "{}";
                }
              } else if (args === null || typeof args !== "object") {
                args = "{}";
              } else {
                args = safeStringify(args);
              }

              return {
                id: tc.id,
                type: "function",
                function: {
                  name: tc.function?.name,
                  arguments: args,
                },
              };
            });

            if (calls.length > 0) {
              assistantMsg.tool_calls = calls;
              calls.forEach((tc) => pendingToolCallIds.add(tc.id));
            }
          }

          // 4. Reasoning Content Logic: DeepSeek-specific
          // For DeepSeek models, if reasoning exists (even if empty), pass it back.
          if (isDeepSeek && reasoning !== undefined) {
            assistantMsg.reasoning_content = reasoning;
          }

          normalized.push(assistantMsg);
          if (assistantMsg.tool_calls) {
            lastToolCallAssistantIndex = normalized.length - 1;
          }
        } else {
          // Anthropic/Gemini/etc.
          // History may contain assistant messages in OpenAI tool_calls format, or
          // Anthropic tool_use blocks whose input was accidentally stringified.
          // Both cause HTTP 400 ("Input should be an object"). Normalize here.
          if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            // OpenAI-style tool_calls → Anthropic tool_use content blocks
            const textContent =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
                  : "";
            const toolUseBlocks = msg.tool_calls.map((tc) => {
              let input = tc.function?.arguments ?? {};
              if (typeof input === "string") {
                try { input = JSON.parse(input); } catch { input = {}; }
              }
              if (input === null || typeof input !== "object") input = {};
              return { type: "tool_use", id: tc.id, name: tc.function?.name, input };
            });
            const blocks = [];
            if (textContent) blocks.push({ type: "text", text: textContent });
            blocks.push(...toolUseBlocks);
            normalized.push({ role: "assistant", content: blocks });
            toolUseBlocks.forEach((tu) => pendingToolCallIds.add(tu.id));
            lastToolCallAssistantIndex = normalized.length - 1;
          } else if (Array.isArray(content) && content.some((c) => c.type === "tool_use")) {
            // Already Anthropic format — ensure input is a plain object, not a string
            const fixedContent = content.map((c) => {
              if (c.type !== "tool_use") return c;
              let input = c.input;
              if (typeof input === "string") {
                try { input = JSON.parse(input); } catch { input = {}; }
              }
              if (input === null || typeof input !== "object") input = {};
              return { ...c, input };
            });
            normalized.push({ ...msg, content: fixedContent });
            fixedContent.filter((c) => c.type === "tool_use").forEach((c) => pendingToolCallIds.add(c.id));
            lastToolCallAssistantIndex = normalized.length - 1;
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
        // Some DeepSeek models (prover-v2, thinking-only) have no tool support —
        // silently drop all tool result messages from history so they don't
        // trigger a 400 from the API.
        if (isReasoner) continue;
        const results = [];
        if (role === "tool" && !Array.isArray(content)) {
          results.push(resolveResultRef(msg));
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
                    : safeStringify(c.content),
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
        } else if (role === "tool") {
          // Anthropic/Gemini: role:"tool" is not valid — convert to role:"user"
          // with type:"tool_result" content blocks. Multiple consecutive tool
          // results (one per tool call) must be batched into a single user turn.
          const resolved = resolveResultRef(msg);
          const block = {
            type: "tool_result",
            tool_use_id: resolved.tool_call_id,
            content:
              typeof resolved.content === "string"
                ? resolved.content
                : safeStringify(resolved.content),
          };
          if (resolved.is_error) block.is_error = true;
          pendingToolCallIds.delete(resolved.tool_call_id);
          // Merge into the previous user message if it already holds only
          // tool_result blocks (same assistant turn), otherwise open a new one.
          const prev = normalized[normalized.length - 1];
          if (
            prev?.role === "user" &&
            Array.isArray(prev.content) &&
            prev.content.length > 0 &&
            prev.content.every((c) => c.type === "tool_result")
          ) {
            prev.content.push(block);
          } else {
            normalized.push({ role: "user", content: [block] });
          }
        } else {
          // Already role:"user" with tool_result content blocks (Anthropic native format).
          // Resolve refs, pass through, and clear those IDs from pending.
          const resolved = resolveResultRef(msg);
          if (Array.isArray(resolved.content)) {
            resolved.content.forEach((c) => {
              if (c.type === "tool_result") pendingToolCallIds.delete(c.tool_use_id);
            });
          }
          normalized.push(resolved);
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
    // Insert fake results at the correct position — right after the assistant
    // message that made those tool calls — instead of appending at the end.
    // Skip for non-tool DeepSeek models — they have no tool support so tool
    // messages must never appear in the history regardless.
    if (isOpenAI && !isReasoner && pendingToolCallIds.size > 0) {
      console.warn(
        `[http] history sequence error: ${pendingToolCallIds.size} tool calls missing results. Healing...`,
      );
      const fakeResults = [];
      for (const id of pendingToolCallIds) {
        fakeResults.push({
          role: "tool",
          tool_call_id: id,
          content:
            "Error: Turn was interrupted before tool result could be processed.",
          is_error: true,
        });
      }
      // Insert after the last assistant with tool_calls, or fall back to append
      const insertAt = Math.min(
        lastToolCallAssistantIndex + 1,
        normalized.length,
      );
      normalized.splice(insertAt, 0, ...fakeResults);
    }

    if (!isOpenAI && !isReasoner && pendingToolCallIds.size > 0) {
      // Anthropic: orphaned tool_use blocks — insert a user message with fake
      // tool_result blocks right after the assistant message that made the calls.
      console.warn(
        `[http] Anthropic: ${pendingToolCallIds.size} tool_use blocks missing results. Healing...`,
      );
      const fakeBlocks = [];
      for (const id of pendingToolCallIds) {
        fakeBlocks.push({
          type: "tool_result",
          tool_use_id: id,
          content: "Error: Turn was interrupted before tool result could be processed.",
          is_error: true,
        });
      }
      const insertAt = Math.min(lastToolCallAssistantIndex + 1, normalized.length);
      normalized.splice(insertAt, 0, { role: "user", content: fakeBlocks });
    }

    // --- 5. DEFENSIVE SANITIZATION (OpenAI providers) ---
    // Last-resort guard: ensure every message has string content and no stray
    // array-content blocks leak through. Some renderer paths may produce content
    // blocks with missing 'type' fields, which causes Rust's serde to error with
    // "missing field 'type'" on providers like DeepSeek.
    if (isOpenAI) {
      for (let i = 0; i < normalized.length; i++) {
        const msg = normalized[i];

        // Flatten any array content that wasn't converted above
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((c) => c && typeof c.type === "string" && c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
          // Include tool_result content blocks as well
          const toolResults = msg.content
            .filter((c) => c && c.type === "tool_result" && c.content)
            .map((c) => (typeof c.content === "string" ? c.content : safeStringify(c.content)))
            .join("\n");
          const combined = [text, toolResults].filter(Boolean).join("\n\n");
          normalized[i] = { ...msg, content: combined || "" };
        }

        // Never send null/undefined content
        if (normalized[i].content == null) {
          normalized[i] = { ...normalized[i], content: "" };
        }

        // Ensure all tool_calls have the 'type' discriminator
        if (normalized[i].tool_calls) {
          normalized[i].tool_calls = normalized[i].tool_calls
            .filter((tc) => tc && tc.id)
            .map((tc) => ({ ...tc, type: tc.type || "function" }));
        }

        // Strip any top-level 'type' field — belongs on content blocks, not messages
        if ("type" in normalized[i] && normalized[i].role) {
          const { type: _unused, ...clean } = normalized[i];
          normalized[i] = clean;
        }
      }
    }

    return normalized;
  }

  async getGitStatus(workingDir) {
    try {
      const branchResult = await execThroughWorker(
        "git symbolic-ref --short HEAD || git rev-parse --abbrev-ref HEAD",
        { cwd: workingDir, timeout: 10 }
      );
      const branch = branchResult.success ? branchResult.stdout.trim() : "";

      const statusResult = await execThroughWorker(
        "git status --porcelain=v1 -unormal",
        { cwd: workingDir, timeout: 10 }
      );
      const summary = statusResult.success ? (statusResult.stdout.trim() || "(clean)") : "";

      if (!branch && !summary) return null;
      return { branch, summary };
    } catch {
      return null;
    }
  }

  async spawn(request) {
    // Reset healing flags for this new session — ensured fresh regardless
    // of previous spawn's state (e.g. auto-resume re-enters spawn).
    this._healAttemptedThisTurn = false;
    this._contextHealAttemptedThisTurn = false;
    if (typeof this._sessionRetryCount !== "number") {
      this._sessionRetryCount = 0;
    }

    const abortController = new AbortController();
    this.activeRequests.set(request.projectId, abortController);
    const spawnStartTime = Date.now();
    let journal = null; // Hoisted — opened inside try, closed in finally

    this.onEvent(
      request.projectId,
      { event: "processStarted", data: null },
      request.requestId,
    );

    try {
      const apiConfig = await this.getApiConfig(request.provider || null);
      console.log(
        `[http] spawn: request.provider=${request.provider}, resolved.provider=${apiConfig.provider}, model=${request.model}, hasKey=${!!apiConfig.apiKey}, prefix=${apiConfig.apiKey?.slice(0, 10)}`,
      );
      this.validateApiConfig(apiConfig);

      const gitStatus = await this.getGitStatus(request.workingDir);

      const historyLength = request.history ? request.history.length : 0;

      // Update session state before context assembly
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

      // Fetch recent changes from SQLite to include in context
      let sqliteChanges = [];
      try {
        const db = getPaneDb();
        if (db.stmts.getChanges) {
          sqliteChanges = db.stmts.getChanges
            .all(request.projectId)
            .slice(0, 10);
        } else {
          console.warn(
            "[http] Database not fully initialized, skipping SQLite changes fetch",
          );
        }
      } catch (err) {
        console.warn(
          "[http] Failed to fetch SQLite changes for context:",
          err.message,
        );
      }

      // ── Pre-compute query embedding for relevance-scored context ──
      // Computed once, reused for both the semantic turn pool (in orchestrateContext)
      // and turn selection.
      let queryEmbB64 = null;
      if (this._brainRequest) {
        try {
          const userQuery = request.prompt || "";
          const embedResult = await this._brainRequest("embed_texts", { texts: [userQuery] });
          queryEmbB64 = embedResult?.embeddings?.[userQuery] || null;
        } catch (err) {
          console.warn(`[http] query embedding failed (falling back to chronological): ${err.message}`);
        }
      }

      // ── Fetch & embed turn summaries (needed for session tier semantic pool) ──
      // Moved up to run before orchestrator so the semantic pool can be injected
      // into systemTiers.session. Reuses the same queryEmbB64 computed above.
      // Auto-caching providers (DeepSeek, Kimi, etc.) get their semantic context
      // here in the system prompt — the conversation body stays chronological.
      // Explicit-caching providers (Anthropic) also benefit: the session tier
      // is breakpointed and cached for 5 minutes during tool-call loops.
      let turnSummaries = [];
      if (this._brainRequest && queryEmbB64) {
        try {
          turnSummaries = contextStore.getTurnSummaries(request.projectId);
          if (turnSummaries && turnSummaries.length > 0) {
            const unembedded = turnSummaries.filter(s => !s.embedding);
            if (unembedded.length > 0) {
              const texts = unembedded.map(s => s.compressedText);
              const result = await this._brainRequest("embed_texts", { texts });
              if (result?.embeddings) {
                for (const s of unembedded) {
                  const b64 = result.embeddings[s.compressedText];
                  if (b64) s.embedding = base64ToFloat32Array(b64);
                }
                contextStore.updateTurnSummaries(request.projectId, turnSummaries);
              }
            }
          }
        } catch (err) {
          turnSummaries = [];
          console.warn(`[http] turn summary embedding failed: ${err.message}`);
        }
      }

      // Budget-aware context assembly via orchestrator (single path)
      const conversationTokens = estimateConversationTokens(
        request.history || [],
      );
      const context = orchestrateContext(request.projectId, {
        intent: request.intent,
        historyLength,
        backend: "http",
        model: request.model,
        projectRoot: request.workingDir,
        sqliteChanges,
        conversationTokens,
        queryEmbeddingBase64: queryEmbB64,
      });
      if (context.budget?.layersDropped > 0) {
        console.log(
          `[http] Context budget: ${context.budget.systemUsed}/${context.budget.systemBudget} tokens (dropped: ${context.budget.droppedNames.join(", ")})`,
        );
      }

      // ── Build system prompt with tier metadata for cache-aware providers ──
      // The context object has three tiers: frozen (never changes), session
      // (changes when scope changes), turn (changes every turn). Providers
      // that support caching (Anthropic, Gemini) get structured content blocks
      // with cache breakpoints. Others get a flat string — prefix stability
      // still helps automatic cachers (DeepSeek, Kimi, Qwen).
      let systemPrompt;
      let systemTiers = null; // { frozen, session, turn } — set when tiers available

      if (request.systemPromptOverride) {
        systemPrompt = request.systemPromptOverride;
      } else {
        const prepend = request._systemPrepend
          ? request._systemPrepend + "\n\n"
          : "";
        systemPrompt = prepend + context.full;
        // Expose tiers if the context produced them (orchestrator and compileContext both do)
        if (context.frozen !== undefined) {
          systemTiers = {
            frozen: prepend + context.frozen,
            session: context.session || "",
            turn: context.turn || "",
          };
        }
      }
      if (request.escalationHint) {
        systemPrompt += `\n\n${request.escalationHint}`;
        if (systemTiers) systemTiers.turn += `\n\n${request.escalationHint}`;
      }

      // ── Inject semantic turn pool into session tier ──
      // The pool surfaces the most relevant past turns for the current query.
      // Injected into the session tier so auto-caching providers (DeepSeek, Kimi)
      // get semantic context at the system/message boundary rather than through
      // mid-body turn mutations that break prefix cache. Explicit-caching providers
      // (Anthropic) also benefit — the session tier is breakpointed and cached
      // for 5 minutes during tool-call loops.
      //
      // The pool is built from the turn summaries fetched & embedded above,
      // using the same query embedding. When the brain engine is down or no
      // summaries exist, the session tier remains empty.
      if (queryEmbB64 && turnSummaries.length > 0) {
        try {
          const topSummaries = getTopRelevantSummaries(queryEmbB64, turnSummaries, 8);
          if (topSummaries?.length > 0) {
            const poolText = formatSemanticPool(topSummaries);
            if (poolText) {
              systemTiers.session = (systemTiers.session || "") + poolText;
              systemPrompt += poolText;
            }
          }
        } catch (err) {
          console.warn(`[http] semantic pool injection failed: ${err.message}`);
        }
      }

      // Emit synthetic init event after config is validated
      this.onEvent(
        request.projectId,
        {
          event: "message",
          data: {
            parsed: {
              type: "system",
              subtype: "init",
              session_id: `http-${Date.now()}`,
              tools: getToolsForPhase(request.phase || "execution"),
              model: request.model || this.getDefaultModel(apiConfig.provider),
            },
          },
        },
        request.requestId,
      );

      // Attach tier metadata to the system message for prepareRequest() to consume
      const messages = [
        { role: "system", content: systemPrompt, _tiers: systemTiers },
      ];

      // ── Session Resume: journal-first message loading ─────────────────────
      // Check if a previous session died mid-work. If a journal exists and is
      // fresh, replay it instead of using the renderer's truncated history.
      // The journal has the FULL conversation state including tool results,
      // auto-continuation prompts, and responses that the renderer may never
      // have received (stream died before delivery).
      //
      // Cache impact: messages replay verbatim, so Anthropic's prefix cache
      // hits on everything the model already saw. The system prompt is fresh
      // (it changes per-session), but frozen/session tiers still cache-hit
      // if content hasn't changed.
      const isNewConversation =
        !request.history || request.history.length === 0;
      let journalResumed = false;
      let lastProgress = null;

      if (!isNewConversation) {
        const resumeCheck = canResume(request.projectId);
        if (resumeCheck.resumable && resumeCheck.meta) {
          const journalData = replay(request.projectId);
          if (journalData.messages.length > 0) {
            // Journal has more context than the renderer's slice(-20) —
            // use it as the source of truth
            for (const msg of journalData.messages) {
              messages.push(msg);
            }
            lastProgress = journalData.progress;
            journalResumed = true;
            console.log(
              `[http] ⟲ RESUMED from journal: ${journalData.messages.length} messages, ` +
                `last activity ${Math.round((Date.now() - resumeCheck.meta.lastAppendAt) / 1000)}s ago` +
                (lastProgress
                  ? `, progress: ${lastProgress.accomplishments?.length || 0} accomplishments`
                  : ""),
            );

            // Surface the resume to the UI
            this.onEvent(
              request.projectId,
              {
                event: "status",
                data: { message: "resuming previous session..." },
              },
              request.requestId,
            );
          }
        }
      }

      // Fall back to renderer history if no journal resume
      if (!journalResumed && request.history) {
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
        `[http] Loaded ${messages.length} messages (${journalResumed ? "journal" : "history"})`,
      );

      // Prefix-caching optimization is applied in prepareRequest() per-provider,
      // NOT here in the shared messages array. This keeps history clean across
      // provider switches — no [Pane context] preambles baked into stored messages.
      // The _tiers metadata on messages[0] carries frozen/session/turn separately
      // for prepareRequest to restructure as needed per provider.

      // ── Context window management ────────────────────────────────────────
      // Pane owns the context window. Instead of emergency compaction when
      // full, the window is continuously managed:
      //   Phase 1: Prune old tool results (3k file reads → 30-token summaries)
      //   Phase 2: Drop turns (semantic by default, chronological fallback)
      //
      // ── Provider-aware V4 body mutation ──────────────────────────────
      // Explicit-caching providers (Anthropic) tolerate mid-body mutations
      // because they use cache_control breakpoints. Auto-caching providers
      // (DeepSeek, Kimi, Qwen, etc.) cache by prefix stability — body
      // mutations destroy the cache. For auto-caching providers:
      //   • Semantic context → system prompt session tier (injected above)
      //   • Overflow management → chronological forcePruneToBudget guardrail
      //   • Body → chronological, prefix-stable
      const canBodyMutate = PROVIDERS_WITH_EXPLICIT_CACHE.has(request.provider);
      let turnSelection = null;
      if (canBodyMutate && this._brainRequest && queryEmbB64) {
        try {
          // turnSummaries already fetched & embedded above (for session tier)
          if (turnSummaries.length > 0) {
            const scored = scoreTurnsByRelevance(queryEmbB64, turnSummaries);
            turnSelection = selectTurns(scored);
          }
        } catch (err) {
          console.warn(`[http] semantic turn selection failed: ${err.message}`);
        }
      }

      // ── Context window management (V4-direct) ────────────────────────
      // Only applies to explicit-caching providers. Auto-caching providers
      // let the pre-flight forcePruneToBudget guardrail handle overflow.
      // Offloaded to a Worker thread to avoid freezing the main process.
      let windowResult;
      if (turnSelection) {
        const compResult = await compactMessages("applyV4TurnSelection", {
          messages, turnSelection, projectId: request.projectId,
        });
        messages = compResult.messages;
        windowResult = {
          action: compResult.action,
          tokensSaved: compResult.tokensSaved,
          droppedTurns: compResult.droppedTurns,
        };
      } else {
        windowResult = { action: "none", tokensSaved: 0, droppedTurns: [] };
      }
      if (windowResult.action !== "none") {
        this.onEvent(
          request.projectId,
          {
            event: "window_managed",
            data: {
              action: windowResult.action,
              tokensSaved: windowResult.tokensSaved,
              droppedTurns: windowResult.droppedTurns?.length || 0,
              messagesRemaining: messages.length,
            },
          },
          request.requestId,
        );
      }

      // ── Session Resume: inject progress context ──────────────────────────
      // When resuming from journal, stuff last session's progress into the
      // user message so the model picks up exactly where it left off.
      if (journalResumed && lastProgress) {
        const resumeParts = [request.prompt];
        resumeParts.push(
          "\n\n[Session resumed — your previous session was interrupted. Here is your progress:]",
        );
        if (lastProgress.accomplishments?.length > 0) {
          resumeParts.push(
            `\n[Completed]\n${lastProgress.accomplishments.map((a) => `- ${a}`).join("\n")}`,
          );
        }
        if (lastProgress.decisions?.length > 0) {
          resumeParts.push(
            `\n[Decisions locked — do not revisit]\n${lastProgress.decisions.map((d) => `- ${d}`).join("\n")}`,
          );
        }
        if (lastProgress.pendingTodos?.length > 0) {
          resumeParts.push(
            `\n[Remaining work]\n${lastProgress.pendingTodos.map((t) => `- ${t}`).join("\n")}`,
          );
        }
        resumeParts.push(
          "\nPick up exactly where you left off. Do NOT re-explore files you already read.",
        );

        messages.push({
          role: "user",
          content: [{ type: "text", text: resumeParts.join("\n") }],
        });
      } else {
        messages.push({
          role: "user",
          content: [{ type: "text", text: request.prompt }],
        });
      }

      // ── Session Journal ───────────────────────────────────────────────────
      // Open the journal for this session. If resuming, we append to the
      // existing journal (preserving the full history). If new, we start fresh.
      // The journal is the crash-safe source of truth for the messages array.
      journal = openJournal(request.projectId, {
        fresh: isNewConversation && !journalResumed,
        model: request.model,
        provider: request.provider,
      });

      // Journal the new user message (the one we just pushed)
      journal.append(messages[messages.length - 1]);

      let turn = 0;
      const maxTurns = 500;
      let sessionOutput = ""; // Accumulate model text for pattern extraction (capped)
      const SESSION_OUTPUT_CAP = 512_000; // ~500KB — enough for extraction, avoids unbounded growth
      let disconnectRetryCount = 0; // Retries for premature stream disconnects
      const arbiterChangedFiles = new Set(); // Track files modified for Turn Sentinel

      const MAX_TURN_RETRIES = 3;
      let turnRetryCount = 0;
      let _preCallMessageCount = 0; // Hoisted for post-turn archiving
      let awaitingUserInput = false; // Set when the model calls ask_user — ends the loop cleanly

      while (turn < maxTurns) {
        turn++;

        // Resolve model name first — state carries it so handleStreamEvent
        // can look up the model's streaming personality at parse time.
        const resolvedModel = this.mapModelName(
          apiConfig.provider,
          request.model,
        );

        const state = {
          accumulated: "",
          thinking: "", // Track reasoning for resilience checks
          thinkingSignature: null, // Anthropic signature for thinking blocks (required for multi-turn)
          toolUses: new Map(),
          finishReason: null,
          model: resolvedModel,
          usage: null,
        };
        this.requestStates.set(request.projectId, state);

        try {
          // Some DeepSeek models (prover-v2, thinking-only variants) don't support
          // function calling — sending tools returns HTTP 400. They also ignore
          // sampling params (temperature etc.). V4 Flash/Pro fully support tools.
          const isDeepSeekReasoner =
            apiConfig.provider === "deepseek" &&
            (resolvedModel.includes("reasoner") ||
              resolvedModel.includes("r1") ||
              resolvedModel.includes("prover") ||
              resolvedModel.includes("thinking"));

          // Resolve max_tokens from the registry — no per-provider if/else chains.
          // resolveMaxTokens checks the model ID against MODEL_OUTPUT_LIMITS and
          // returns the right budget. omit=true means the field should be removed
          // entirely (e.g. StepFun reasoning models manage their own CoT budget).
          const { maxTokens, omit: omitMaxTokens } =
            resolveMaxTokens(resolvedModel);

          // Phase 1: Normalize — convert frontend message format to API format
          // Pass freshness context for _resultRef resolution: fresh turns get
          // their full tool content inlined from ToolResultStore; non-fresh
          // turns retain the summary that's already in the envelope.
          //
          // On session resume, existing messages have _resultRef.turn values
          // from a previous session counter. We compute effectiveTurn so
          // freshness is relative to the actual conversation position, not
          // the loop counter restart. Without this, resumed messages never
          // resolve to full content because currentTurn (1) < _resultRef.turn.
          const maxRefTurn = messages.reduce(
            (max, m) => (m._resultRef && m._resultRef.turn > max ? m._resultRef.turn : max),
            0,
          );
          const effectiveTurn = Math.max(turn, maxRefTurn);
          const normalizedMessages = this.normalizeMessages(
            messages,
            apiConfig.provider,
            resolvedModel,
            {
              projectId: request.projectId,
              currentTurn: effectiveTurn,
              freshDepth: SLIDING_WINDOW_SIZE,
            },
          );
          // Phase 2: Validate — catch any remaining tool_call→tool_result sequence bugs
          const validatedMessages = validateMessageSequence(
            normalizedMessages,
            apiConfig.provider,
          );
          const body = {
            model: resolvedModel,
            messages: validatedMessages,
            stream: true,
            max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          };

          if (omitMaxTokens) {
            delete body.max_tokens;
          }

          // Request usage data in streaming response for OpenAI-compatible providers.
          // Without this flag, some APIs (DeepSeek, Kimi, etc.) omit the usage object
          // from the final SSE chunk, breaking cost and cache rate tracking entirely.
          if (
            ["deepseek", "kimi", "stepfun", "xiaomi", "openrouter", "z-ai"].includes(
              apiConfig.provider,
            )
          ) {
            body.stream_options = { include_usage: true };
          }

          if (apiConfig.provider === "openrouter") {
            body.repetition_penalty = 1.1;
          }

          // Phase-based tool filtering — planning phase gets Plan tool, discovery gets read-only.
          // Some DeepSeek models (prover-v2, thinking-only variants) do NOT support
          // function calling — skip tools for those. For OpenRouter, consult the
          // model personality registry — some OR-proxied models also don't support tools.
          const phase = request.phase || "execution";
          const orPersonality =
            apiConfig.provider === "openrouter"
              ? getModelStreamingConfig(resolvedModel)
              : null;
          if (
            (apiConfig.provider === "deepseek" && !isDeepSeekReasoner) ||
            apiConfig.provider === "z-ai" ||
            apiConfig.provider === "kimi" ||
            apiConfig.provider === "stepfun" ||
            apiConfig.provider === "xiaomi" ||
            (apiConfig.provider === "openrouter" && orPersonality.supportsTools)
          ) {
            body.tools = getToolsForPhase(phase);
          } else if (apiConfig.provider === "anthropic") {
            body.tools = getAnthropicToolsForPhase(phase);
          }

          if (request.thinking && apiConfig.provider === "kimi") {
            body.temperature = 1;
            // Kimi thinking — same pattern: compute from live context window.
            // Kimi supports up to 128K context. No hardcoded ceiling.
            if (!omitMaxTokens) {
              const contextLimit = getModelLimit(resolvedModel);
              const promptTokens = estimateConversationTokens(validatedMessages);
              const safetyReserve = 4000;
              const dynamicMax = contextLimit - promptTokens - safetyReserve;
              const cap = (maxTokens ?? DEFAULT_MAX_TOKENS) * 2;
              // When the conversation already exceeds context budget, don't send
              // a doomed request — let the API see the full picture and return a
              // clean "context length exceeded" error instead of a confusing stub.
              body.max_tokens = dynamicMax > 0 ? Math.min(dynamicMax, cap) : cap;
            }
          }

          if (request.thinking && apiConfig.provider === "openrouter") {
            // OpenRouter standard reasoning toggle
            body.include_reasoning = true;
          }

          if (request.thinking && apiConfig.provider === "xiaomi") {
            // MiMo thinking mode — thinking tokens consume from the same max_tokens
            // pool as output. Compute from the live context window so the model has
            // room to reason without starving its output.
            // MiMo Pro/Omni support up to 1M context. No hardcoded ceiling.
            body.enable_thinking = true;
            if (!omitMaxTokens) {
              const contextLimit = getModelLimit(resolvedModel);
              const promptTokens = estimateConversationTokens(validatedMessages);
              const safetyReserve = 4000;
              const dynamicMax = contextLimit - promptTokens - safetyReserve;
              const cap = (maxTokens ?? DEFAULT_MAX_TOKENS) * 2;
              // When the conversation already exceeds context budget, don't send
              // a doomed request — let the API see the full picture and return a
              // clean "context length exceeded" error instead of a confusing stub.
              body.max_tokens = dynamicMax > 0 ? Math.min(dynamicMax, cap) : cap;
            }
          }

          if (
            request.thinking &&
            apiConfig.provider === "deepseek" &&
            !isDeepSeekReasoner
          ) {
            // DeepSeek V4 thinking mode: uses OpenAI-compatible parameters.
            //   thinking: { type: "enabled" }     — toggle
            //   reasoning_effort: "max"            — effort level (high | max)
            // Returns reasoning_content in the response delta, which MUST be
            // passed back on every subsequent turn.
            //
            // Notes:
            //   • V4 Flash/Pro use OpenAI-compatible thinking params
            //   • reasoning_effort="max" for agent/coding workloads (default is high)
            //   • When thinking is on, temperature/top_p/presence/frequency are ignored
            //
            // Thinking tokens share the same budget as output tokens from maxTokens
            // (384K for V4 Flash/Pro). No *2 multiplication — maxTokens already
            // includes the thinking budget. Never exceed the model's output limit.
            body.thinking = { type: "enabled" };
            body.reasoning_effort = "max";
            if (!omitMaxTokens) {
              const contextLimit = getModelLimit(resolvedModel);
              const promptTokens = estimateConversationTokens(validatedMessages);
              const safetyReserve = 4000;
              const dynamicMax = contextLimit - promptTokens - safetyReserve;
              const cap = maxTokens ?? DEFAULT_MAX_TOKENS;
              // When the conversation already exceeds context budget, don't send
              // a doomed request with 1 token — let the API see the full picture
              // and return a clean "context length exceeded" error.
              body.max_tokens = dynamicMax > 0 ? Math.min(dynamicMax, cap) : cap;
            }
          }

          if (
            request.thinking &&
            apiConfig.provider === "z-ai"
          ) {
            // Z.ai GLM thinking mode (OpenAI-compatible):
            //   thinking: { type: "enabled" }     — toggle
            //   reasoning_effort: "max"            — supported by GLM-5.2
            // Returns reasoning_content in the response delta, which MUST be
            // passed back on every subsequent turn.
            //
            // Notes:
            //   • GLM-5.2 supports reasoning_effort; other models default to thinking
            //   • temperature/top_p/presence_penalty/frequency_penalty ignored when thinking
            //   • clear_thinking=true by default (clear thinking across turns)
            body.thinking = { type: "enabled", clear_thinking: true };
            body.reasoning_effort = "max";
            if (!omitMaxTokens) {
              const contextLimit = getModelLimit(resolvedModel);
              const promptTokens = estimateConversationTokens(validatedMessages);
              const safetyReserve = 4000;
              const dynamicMax = contextLimit - promptTokens - safetyReserve;
              const cap = maxTokens ?? DEFAULT_MAX_TOKENS;
              // When the conversation already exceeds context budget, don't send
              // a doomed request with 1 token — let the API see the full picture
              // and return a clean "context length exceeded" error.
              body.max_tokens = dynamicMax > 0 ? Math.min(dynamicMax, cap) : cap;
            }
          }

          if (
            request.thinking &&
            apiConfig.provider === "anthropic"
          ) {
            // Anthropic extended thinking (interleaved-thinking-2025-05-14 beta):
            //   thinking: { type: "enabled", budget_tokens: N }
            //
            // Claude Code uses thinking: { type: "adaptive" } but the API also
            // supports explicit budget_tokens. We use a generous budget so Claude
            // can reason deeply before acting — especially important for complex
            // coding tasks. Temperature MUST be 1 when thinking is enabled.
            //
            // The interleaved-thinking-2025-05-14 beta flag (already in OAuth
            // headers via getOAuthHeaders) enables interleaved thinking blocks
            // between tool calls.
            body.thinking = { type: "enabled", budget_tokens: 16000 };
            body.temperature = 1;
            if (!omitMaxTokens) {
              const contextLimit = getModelLimit(resolvedModel);
              const promptTokens = estimateConversationTokens(validatedMessages);
              const safetyReserve = 4000;
              const dynamicMax = contextLimit - promptTokens - safetyReserve;
              // thinking tokens share the max_tokens budget — ensure room for both
              const cap = (maxTokens ?? DEFAULT_MAX_TOKENS) * 4;
              body.max_tokens = dynamicMax > 0 ? Math.min(dynamicMax, cap) : cap;
            }
          }

          const { url, headers, finalBody } = await this.prepareRequest(
            apiConfig,
            body,
            request,
          );

          const turnStartTime = Date.now();
          // ============================================================================
          // ENDURANCE RETRY LOGIC — Pane's resilience layer
          // ============================================================================
          //
          // Philosophy: API rejections are not failures — they're feedback.
          // Pane should never give up on transient errors. Network hiccups,
          // rate limits, and upstream server issues are expected in production.
          //
          // Retry strategy by error type:
          //   • 429 (Rate Limit):      7+ retries with jitter, respects Retry-After
          //   • 5xx (Server Error):    7+ retries with exponential backoff + jitter
          //   • Network failures:      7+ retries with progressive delays
          //   • 400/401/403/422:       Immediate fail (client errors are not transient)
          //   • 502/503/504:           Treated as network issues, 7+ retries
          //
          // Backoff formula: delay = base * 2^attempt + jitter
          // Jitter prevents thundering herd when many clients retry simultaneously
          // ============================================================================

          let response;
          let attempt = 0;
          const MAX_RETRIES = 7; // Minimum per requirement
          const BASE_DELAY_MS = 1000; // 1 second base

          // Track retry history for debugging
          const retryHistory = [];
          // Preserves the error body across the retry loop boundary — the 400
          // handler reads response.text() to check for "insufficient tool messages",
          // which exhausts the body stream. If the error is NOT healable and we
          // break, the code after the loop needs the body text for the error message.
          let lastResponseBody = "";

          // Lightweight pre-call checkpoint: save the last 6 messages instead of
          // the full array. Avoids the 60GB memory spike from structuredClone on
          // massive conversation arrays, but gives error recovery actual state to
          // restore from (previously saved messages: null which was useless).
          _preCallMessageCount = messages.length;
          saveTurn(request.projectId, turn, {
            messages: messages.slice(-6),
            fullLength: _preCallMessageCount,
            turn,
            timestamp: Date.now(),
            phase: "pre-call",
          });

          while (true) {
            try {
              // ── Pre-flight guardrail: last-resort context overflow check ──
              // V4's context orchestrator now budgets with TOKEN_ESTIMATE_SAFETY
              // baked in, so this should never fire. It exists as a tight assertion
              // catching bugs or unexpected edge cases (new provider, new body format)
              // where V4's budget didn't account for something.
              const sourceBody = finalBody || body;
              if (sourceBody.messages?.length > 0) {
                const modelLimit = request.model ? getModelLimit(request.model) : 128000;
                const outputBudget = getDefaultOutputBudget(request.model);
                const overheadBudget = 5000;
                const maxMessagesTokens = modelLimit - outputBudget - overheadBudget;
                // Use per-message estimation instead of JSON.stringify(allMessages) —
                // avoids serializing the entire (potentially 20-100MB) messages array
                // to a single string, which blocks the main thread for 50-200ms.
                let msgEstimateTokens = estimateConversationTokens(sourceBody.messages);
                if (sourceBody.system) {
                  const systemStr = typeof sourceBody.system === "string"
                    ? sourceBody.system
                    : JSON.stringify(sourceBody.system);
                  msgEstimateTokens += estimateTokens(systemStr);
                }
                const currentMsgTokens = Math.round(msgEstimateTokens * TOKEN_ESTIMATE_SAFETY);
                if (currentMsgTokens > maxMessagesTokens) {
                  console.warn(
                    `[http] GUARDRAIL FIRED: ~${currentMsgTokens} total tokens (${TOKEN_ESTIMATE_SAFETY}x safety) exceeds ${maxMessagesTokens} budget. V4 should have prevented this. Force-pruning...`
                  );
                  const pruneTarget = Math.floor(maxMessagesTokens / TOKEN_ESTIMATE_SAFETY);
                  const result = await compactMessages("forcePruneToBudget", {
                    messages: sourceBody.messages, maxTokens: pruneTarget, projectId: request.projectId,
                  });
                  sourceBody.messages = result.messages;
                  console.log(`[http] Guardrail force-prune: saved ${result.tokensSaved} tokens`);
                  if (finalBody && finalBody !== body && finalBody.messages) {
                    body.messages = finalBody.messages;
                  }
                  this.onEvent(request.projectId, {
                    event: "window_managed", data: { action: "guardrail-force-prune", tokensSaved: result.tokensSaved }
                  }, request.requestId);
                }
              }

              // Strip runtime-only cache fields before serialization — they're set by
              // estimateConversationTokens() above and must not reach any API endpoint.
              if (sourceBody.messages) {
                for (const msg of sourceBody.messages) {
                  delete msg._tokenEstimate;
                  delete msg._tiers;
                }
              }

              response = await fetch(url, {
                method: "POST",
                headers,
                body: safeStringify(sourceBody),
                signal: abortController.signal,
              });

              if (!response.ok) {
                const status = response.status;

                // 429 Rate Limit: 7+ retries with adaptive backoff
                const isRateLimit = status === 429 || status === 430; // 430 is sometimes used by specialized providers

                // Transient 4xx errors that SHOULD be retried:
                // 408: Request Timeout (upstream provider timed out)
                // 409: Conflict (transient state conflict)
                // 401: Unauthorized (ONLY for OpenRouter, occasionally transient sync issue)
                const isTransientClientError =
                  status === 408 ||
                  status === 409 ||
                  (status === 401 && apiConfig.provider === "openrouter");

                // 400-series client errors: NOT retryable (except 429/408/409/OR-401)
                if (
                  status >= 400 &&
                  status < 500 &&
                  !isRateLimit &&
                  !isTransientClientError
                ) {
                  // Explicitly categorize common client errors
                  if (status === 400) {
                    // ── HEALABLE 400: insufficient tool messages ──
                    // Read the error body to check for sequence violations.
                    // This catches cases where normalizeMessages + validateMessageSequence
                    // didn't fully resolve the tool_call→tool_result chain.
                    const errorBody = await response.text().catch(() => "");
                    lastResponseBody = errorBody; // Preserve for error message after retry loop
                    if (
                      (errorBody.includes("insufficient tool messages") ||
                        errorBody.includes("tool_use id") ||
                        errorBody.includes("tool_use block") ||
                        errorBody.includes("tool_result block") ||
                        (errorBody.includes("tool") && errorBody.includes("Unexpected role"))) &&
                      !this._healAttemptedThisTurn
                    ) {
                      this._healAttemptedThisTurn = true;
                      console.warn(
                        `[http] auto-healing: stripping tool history (400: insufficient tool messages)`,
                      );
                      // Notify the UI that Pane is handling it transparently
                      this.onEvent(
                        request.projectId,
                        {
                          event: "status",
                          data: { message: "auto-healing message sequence..." },
                        },
                        request.requestId,
                      );
                      // Strip all tool_calls and tool-role messages from the body
                      body.messages = stripToolHistory(body.messages);
                      // finalBody may be a different object (prepareRequest creates a copy
                      // for prefix-cache optimization). Sync it so the next fetch retry
                      // uses the cleaned messages.
                      if (
                        finalBody &&
                        finalBody !== body &&
                        Array.isArray(finalBody.messages)
                      ) {
                        finalBody.messages = body.messages;
                      }
                      // Clear status before retry
                      this.onEvent(
                        request.projectId,
                        {
                          event: "status",
                          data: { message: null },
                        },
                        request.requestId,
                      );
                      continue; // Don't consume an attempt — heal is free
                    }

                    // ── HEALABLE 400: context window overflow ──
                    // "maximum context length is X tokens. However, you requested Y tokens"
                    // The pre-flight guardrail should catch most of these, but if estimation
                    // is off or the tokenizer counts differently, the API will reject.
                    // Drop oldest turns aggressively and retry.
                    if (
                      (errorBody.includes("maximum context length") ||
                        errorBody.includes("context length") ||
                        errorBody.includes("reduce the length of the messages")) &&
                      !this._contextHealAttemptedThisTurn
                    ) {
                      this._contextHealAttemptedThisTurn = true;
                      console.warn(
                        `[http] auto-healing: context window overflow detected — force-pruning messages`,
                      );
                      this.onEvent(
                        request.projectId,
                        {
                          event: "status",
                          data: { message: "context window full — pruning old messages..." },
                        },
                        request.requestId,
                      );
                      // Drop ALL non-fresh turns — no heuristic estimation.
                      // The structure-aware heuristic can be off by 5× or more for
                      // certain content mixes (dense JSON tool results, CJK text, etc.),
                      // which causes forcePruneToBudget to exit early thinking it's
                      // under budget. This function drops by position alone, guaranteeing
                      // only the last FRESH_DEPTH (5) turns + system prompt remain.
                      // If all turns are already fresh (≤ 5) and a single tool result
                      // exceeds budget, pass maxTokens for Phase 2 message truncation.
                      const healModelLimit = request.model ? getModelLimit(request.model) : 128000;
                      const healOutputBudget = getDefaultOutputBudget(request.model);
                      const healOverheadBudget = 5000;
                      const healMaxMsgTokens = healModelLimit - healOutputBudget - healOverheadBudget;
                      const healResult = await compactMessages("dropAllNonFreshTurns", {
                        messages: sourceBody.messages,
                        projectId: request.projectId,
                        maxTokens: healMaxMsgTokens,
                      });
                      sourceBody.messages = healResult.messages;
                      console.log(
                        `[http] Context-heal: dropped ${healResult.dropped} non-fresh turns (saved ~${healResult.tokensSaved} estimated tokens)`
                      );

                      // Also handle system prompt overflow for Anthropic: if the system
                      // field exists and is too large, truncate highest-priority-last
                      // blocks (turn tier) until it fits in a reasonable budget.
                      if (sourceBody.system && Array.isArray(sourceBody.system)) {
                        const systemBudget = 80000; // generous: 80K tokens max for system
                        // Track the estimate incrementally — re-stringifying the whole
                        // (shrinking) array on every pop is O(n^2) and can pin the main
                        // thread for tens of seconds when there are many/large blocks.
                        let sysEstimate = estimateTokens(JSON.stringify(sourceBody.system));
                        while (sysEstimate > systemBudget && sourceBody.system.length > 1) {
                          // Drop the last (turn) block — it's the lowest priority, changes every turn
                          const dropped = sourceBody.system.pop();
                          sysEstimate -= estimateTokens(JSON.stringify(dropped));
                        }
                        console.log(
                          `[http] Context-heal pruned system prompt to ${sourceBody.system.length} blocks (estimated ${sysEstimate} tokens)`
                        );
                      }

                      // Sync back to body.messages so retry uses the pruned state
                      if (finalBody && finalBody !== body && Array.isArray(finalBody.messages)) {
                        body.messages = finalBody.messages;
                      } else if (!finalBody) {
                        body.messages = sourceBody.messages;
                      }
                      this.onEvent(
                        request.projectId,
                        { event: "status", data: { message: null } },
                        request.requestId,
                      );
                      console.log(`[http] Context-heal pruned to ${sourceBody.messages.length} messages`);
                      continue; // Don't consume an attempt — heal is free
                    }

                    console.error(
                      `[http] Bad request (400): ${errorBody.slice(0, 300)}`,
                    );
                    // Log full error body for OAuth diagnostics
                    if (errorBody.length > 300) {
                      console.error(`[http] Full error body:`, errorBody);
                    }

                    // Write error body to diagnostics file for OAuth debugging
                    (async () => {
                      try {
                        const diagDir = path.join(os.homedir(), ".pane", "diagnostics");
                        await fs.mkdir(diagDir, { recursive: true });
                        await fs.writeFile(
                          path.join(diagDir, "oauth-error.json"),
                          JSON.stringify({ timestamp: new Date().toISOString(), status: 400, body: errorBody }, null, 2),
                        );
                      } catch {}
                    })();

                    // Diagnostic: extract the offending message index from "missing field"
                    // errors (e.g. "messages[15]: missing field 'type' at line 1 column 54023")
                    // and log it so we can trace the root cause in logs.
                    if (
                      errorBody.includes("missing field") ||
                      errorBody.includes("missing_field")
                    ) {
                      const msgIdxMatch = errorBody.match(/messages\[(\d+)\]/);
                      if (msgIdxMatch) {
                        const badIdx = parseInt(msgIdxMatch[1], 10);
                        const badMsg =
                          sourceBody?.messages?.[badIdx];
                        if (badMsg) {
                          const diag = safeStringify({
                            role: badMsg.role,
                            contentType: typeof badMsg.content,
                            contentIsArray: Array.isArray(badMsg.content),
                            contentLength: Array.isArray(badMsg.content)
                              ? badMsg.content.length
                              : typeof badMsg.content === "string"
                                ? badMsg.content.length
                                : null,
                            hasToolCalls: !!badMsg.tool_calls,
                            toolCallsCount: badMsg.tool_calls?.length,
                            topKeys: Object.keys(badMsg),
                            // For array content: what types are present
                            blockTypes: Array.isArray(badMsg.content)
                              ? [
                                  ...new Set(
                                    badMsg.content.map(
                                      (b) => b?.type || "MISSING",
                                    ),
                                  ),
                                ]
                              : null,
                            // If a block has no type, include its keys
                            typeLessBlocks: Array.isArray(badMsg.content)
                              ? badMsg.content
                                  .filter((b) => !b?.type)
                                  .map((b) => Object.keys(b || {}))
                              : null,
                          });
                          console.error(
                            `[http] DIAGNOSTIC: message[${badIdx}] structure:`,
                            diag,
                          );
                        }
                      }
                    }
                  } else if (status === 401) {
                    // Read the error body for diagnostics
                    const errorBody401 = await response.text().catch(() => response.statusText);
                    lastResponseBody = errorBody401; // preserve for the error throw
                    console.error(
                      `[http] 401 UNAUTHORIZED:`,
                      JSON.stringify({
                        status,
                        errorBody: errorBody401?.slice(0, 500),
                        authType: apiConfig.authType,
                        hasAuthHeader: !!headers.Authorization,
                        authPrefix: headers.Authorization?.slice(0, 25),
                        url,
                        betaFlags: headers["anthropic-beta"]?.slice(0, 100),
                      })
                    );

                    // Z.ai Coding Plan auto-detection: Coding Plan API keys are
                    // only valid on the /coding/paas/v4 endpoint. The standard
                    // /paas/v4 endpoint returns 401 for Coding Plan keys. When we
                    // get a 401 and the user hasn't explicitly set a base URL,
                    // retry with the Coding Plan endpoint before giving up.
                    if (
                      apiConfig.provider === "z-ai" &&
                      !apiConfig.baseUrl
                    ) {
                      console.warn(
                        "[http] Z.ai 401 on standard endpoint (no custom base URL) — retrying with Coding Plan endpoint"
                      );
                      url = "https://api.z.ai/api/coding/paas/v4/chat/completions";
                      continue; // Don't consume an attempt — endpoint switch is free
                    }

                    // OAuth mode: token may have expired mid-session
                    if (apiConfig.authType === "oauth") {
                      console.warn("[http] OAuth 401 — invalidating cache and retrying with fresh token");
                      invalidateCache();
                      const freshToken = await getAccessToken();
                      if (freshToken) {
                        // Rebuild headers with fresh token.
                        // Do NOT add prompt-caching-2024-07-31 — OAuth uses
                        // prompt-caching-scope-2026-01-05 which is already in the OAuth betas.
                        const oauthHeaders = getOAuthHeaders(freshToken, resolvedModel);
                        headers = {
                          ...headers,
                          Authorization: oauthHeaders.Authorization,
                          "anthropic-beta": oauthHeaders["anthropic-beta"],
                        };
                        // Don't consume an attempt — token refresh is a heal
                        continue;
                      }
                    }
                    console.error(
                      `[http] Unauthorized (401): Check API key configuration`,
                    );
                  } else if (status === 403) {
                    console.error(
                      `[http] Forbidden (403): ${response.statusText}`,
                    );
                  } else if (status === 422) {
                    console.error(
                      `[http] Validation error (422): ${response.statusText}`,
                    );
                  } else {
                    console.error(
                      `[http] Client error (${status}): ${response.statusText}`,
                    );
                  }
                  break; // Don't retry fatal client errors
                }

                // Retryable 4xx (Rate Limit or Transient): 7+ retries with adaptive backoff
                if (
                  (isRateLimit || isTransientClientError) &&
                  attempt < MAX_RETRIES
                ) {
                  // Z.ai Coding Plan auto-detection: Coding Plan API keys hitting
                  // the standard /paas/v4 endpoint return 429 ("Insufficient balance
                  // or no resource package. Please recharge."). When we get a 429
                  // and the user hasn't explicitly set a base URL, retry once with
                  // the Coding Plan endpoint before entering backoff.
                  if (
                    isRateLimit &&
                    apiConfig.provider === "z-ai" &&
                    !apiConfig.baseUrl
                  ) {
                    console.warn(
                      "[http] Z.ai 429 on standard endpoint (no custom base URL) — retrying with Coding Plan endpoint"
                    );
                    url = "https://api.z.ai/api/coding/paas/v4/chat/completions";
                    continue; // Don't consume an attempt — endpoint switch is free
                  }

                  const retryAfterSec = parseInt(
                    response.headers.get("retry-after") || "0",
                    10,
                  );

                  // Adaptive backoff: respect provider's recommended delay or exponential with jitter
                  let delay;
                  if (retryAfterSec > 0) {
                    // Provider tells us exactly how long to wait
                    delay = retryAfterSec * 1000;
                  } else {
                    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, 32s, 64s
                    const exponential = Math.min(
                      BASE_DELAY_MS * Math.pow(2, attempt),
                      60000,
                    );
                    const jitter = Math.random() * 1000; // ±1s jitter
                    delay = exponential + jitter;
                  }

                  const delaySec = Math.round(delay / 1000);
                  retryHistory.push({
                    status,
                    attempt: attempt + 1,
                    delay: delaySec,
                  });

                  const errorMsg = isRateLimit
                    ? "rate limited"
                    : `transient error ${status}`;
                  console.warn(
                    `[http] ${errorMsg}. Waiting ${delaySec}s before retry ${attempt + 1}/${MAX_RETRIES}...`,
                  );

                  // Surface the wait to the user so they know Pane is handling it
                  this.onEvent(
                    request.projectId,
                    {
                      event: "status",
                      data: {
                        message: `${errorMsg} — retrying in ${delaySec}s (${attempt + 1}/${MAX_RETRIES})`,
                      },
                    },
                    request.requestId,
                  );

                  await new Promise((resolve) => setTimeout(resolve, delay));

                  // Clear status before next attempt
                  this.onEvent(
                    request.projectId,
                    {
                      event: "status",
                      data: { message: null },
                    },
                    request.requestId,
                  );

                  attempt++;
                  continue;
                }

                // 5xx server errors: 7+ retries with exponential backoff + jitter
                if (status >= 500 && attempt < MAX_RETRIES) {
                  const jitter = Math.random() * 500;
                  const delay =
                    Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) +
                    jitter;
                  const delaySec = Math.round(delay / 1000);

                  retryHistory.push({
                    status,
                    attempt: attempt + 1,
                    delay: delaySec,
                  });

                  console.warn(
                    `[http] Server error ${status}. Retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES})...`,
                  );
                  this.onEvent(
                    request.projectId,
                    {
                      event: "status",
                      data: {
                        message: `server error ${status} — retrying in ${delaySec}s (${attempt + 1}/${MAX_RETRIES})`,
                      },
                    },
                    request.requestId,
                  );

                  await new Promise((resolve) => setTimeout(resolve, delay));

                  this.onEvent(
                    request.projectId,
                    {
                      event: "status",
                      data: { message: null },
                    },
                    request.requestId,
                  );

                  attempt++;
                  continue;
                }
              }

              // Success or unrecoverable error
              break;
            } catch (err) {
              // Network-level failures: 7+ retries with progressive backoff
              if (err.name === "AbortError") {
                // User cancelled — don't retry
                throw err;
              }

              if (attempt < MAX_RETRIES) {
                const jitter = Math.random() * 500;
                const delay =
                  Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) +
                  jitter;
                const delaySec = Math.round(delay / 1000);

                // Distinguish network error types for better diagnostics
                let errorMsg = err.message || String(err);
                let errorCategory = "network";
                if (
                  errorMsg.includes("ECONNREFUSED") ||
                  errorMsg.includes("connect")
                ) {
                  errorCategory = "connection_refused";
                } else if (
                  errorMsg.includes("ETIMEDOUT") ||
                  errorMsg.includes("timeout")
                ) {
                  errorCategory = "timeout";
                } else if (
                  errorMsg.includes("ENOTFOUND") ||
                  errorMsg.includes("DNS")
                ) {
                  errorCategory = "dns";
                }

                retryHistory.push({
                  error: errorCategory,
                  attempt: attempt + 1,
                  delay: delaySec,
                });

                console.warn(
                  `[http] ${errorCategory} failure: ${errorMsg}. Retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES})...`,
                );
                this.onEvent(
                  request.projectId,
                  {
                    event: "status",
                    data: {
                      message: `${errorCategory} — retrying in ${delaySec}s (${attempt + 1}/${MAX_RETRIES})`,
                    },
                  },
                  request.requestId,
                );

                await new Promise((resolve) => setTimeout(resolve, delay));

                this.onEvent(
                  request.projectId,
                  {
                    event: "status",
                    data: { message: null },
                  },
                  request.requestId,
                );

                attempt++;
                continue;
              }

              // Max retries exceeded for network failure
              console.error(
                `[http] Network failure after ${MAX_RETRIES} attempts: ${err.message}`,
              );
              throw err;
            }
          }
          // --- END RETRY LOOP ---

          // Log retry summary if retries were used
          if (retryHistory.length > 0) {
            console.log(
              `[http] Retry summary: ${retryHistory.length} attempts, history:`,
              JSON.stringify(retryHistory),
            );
          }

          if (!response.ok) {
            // If the 400 handler already consumed the response body reading errorBody,
            // lastResponseBody has it. Otherwise read it fresh.
            const errorText =
              lastResponseBody ||
              (await response.text().catch(() => response.statusText));
            console.error(
              `[http] API Error: ${response.status} - ${errorText}`,
            );
            throw new Error(`HTTP ${response.status}: ${errorText}`);
          }

          if (!response.body) throw new Error("Response body is null");

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          // Shared idle timeout — single timer reused across chunks instead of
          // creating a new setTimeout + Promise per SSE read (20/sec during streaming).
          // Prevents rapid Timer object accumulation that triggers V8 minor GC pauses.
          const STREAM_IDLE_TIMEOUT_MS = 60_000;
          let _idleTimerId = null;
          async function readWithTimeout() {
            clearTimeout(_idleTimerId);
            const result = await Promise.race([
              reader.read(),
              new Promise((_, reject) => {
                _idleTimerId = setTimeout(
                  () => reject(new Error("Stream idle timeout — no data received for 60s")),
                  STREAM_IDLE_TIMEOUT_MS,
                );
              }),
            ]);
            clearTimeout(_idleTimerId);
            return result;
          }

          while (true) {
            const { done, value } = await readWithTimeout();
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

          // DeepSeek server-side resource exhaustion — retry the turn from scratch.
          // "insufficient_system_resource" means the server couldn't complete the
          // generation; treat it like a 503 and retry up to 2 times with a 2s delay.
          if (state.finishReason === "insufficient_system_resource") {
            if (turnRetryCount < 2) {
              turnRetryCount++;
              turn--; // don't count this as a used turn
              const delay = 2000;
              console.warn(
                `[http] insufficient_system_resource — retrying turn in ${delay}ms (attempt ${turnRetryCount}/2)`,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            } else {
              throw new Error(
                "DeepSeek server resources exhausted after 2 retries (insufficient_system_resource). Try again in a moment.",
              );
            }
          }
          turnRetryCount = 0; // reset on a successful turn

          // ─── Analytics Capture ─────────────────────────────────────────────
          const {
            cost: turnCost,
            source: costSource,
            rateSnapshot,
          } = calculateCost({
            model: state.model,
            provider: apiConfig.provider,
            // input_tokens is now raw total (including cache). Subtract cache_read
            // so calculateCost doesn't double-count cache at full input rate.
            inputTokens: Math.max(
              0,
              (state.usage?.input_tokens || 0) -
                (state.usage?.cache_read_input_tokens || 0),
            ),
            outputTokens: state.usage?.output_tokens || 0,
            cacheReadTokens: state.usage?.cache_read_input_tokens || 0,
            cacheWriteTokens: state.usage?.cache_creation_input_tokens || 0,
            apiReportedCost: state.usage?.cost,
          });

          this.onEvent(
            request.projectId,
            {
              event: "token_usage",
              data: {
                provider: apiConfig.provider,
                activity_type: request.activity_type || "conversation",
                model: state.model,
                input_tokens: state.usage?.input_tokens || 0,
                output_tokens: state.usage?.output_tokens || 0,
                cache_creation_input_tokens:
                  state.usage?.cache_creation_input_tokens || 0,
                cache_read_input_tokens:
                  state.usage?.cache_read_input_tokens || 0,
                cost_usd: turnCost,
                cost_source: costSource,
                cost_rate_snapshot: rateSnapshot
                  ? JSON.stringify(rateSnapshot)
                  : null,
                duration_ms: Date.now() - turnStartTime,
              },
            },
            request.requestId,
          );

          // Log cache efficiency per provider — visibility into cost savings
          const cacheRead = state.usage?.cache_read_input_tokens || 0;
          const totalInput = state.usage?.input_tokens || 0;
          if (cacheRead > 0 && totalInput > 0) {
            const hitRate = ((cacheRead / totalInput) * 100).toFixed(0);
            console.log(
              `[cache] ${apiConfig.provider}/${state.model}: ${hitRate}% hit (${cacheRead} cached / ${totalInput} total input tokens)`,
            );
          }

          const finalContent = [];
          if (state.accumulated) {
            finalContent.push({ type: "text", text: state.accumulated });
            // Accumulate text for pattern extraction in handoff
            if (sessionOutput.length < SESSION_OUTPUT_CAP) {
              sessionOutput +=
                (sessionOutput ? "\n\n" : "") + state.accumulated;
            }
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
          const parsedMessage = {
            type: "assistant",
            message: { content: finalContent },
          };
          const isDeepSeekModel =
            apiConfig.provider === "deepseek" ||
            (apiConfig.provider === "openrouter" &&
              resolvedModel.includes("deepseek"));
          const isZaiModel = apiConfig.provider === "z-ai";
          const deepseekThinking =
            isDeepSeekModel &&
            (isDeepSeekReasoner ||
              (apiConfig.provider === "deepseek" && !isDeepSeekReasoner) ||
              (apiConfig.provider === "openrouter" &&
                body.include_reasoning)) &&
            state.thinking;
          const zaiThinking =
            isZaiModel && request.thinking && state.thinking;

          if (deepseekThinking) {
            parsedMessage.message.reasoning_content = state.thinking;
          }
          if (zaiThinking) {
            parsedMessage.message.reasoning_content = state.thinking;
          }

          this.onEvent(
            request.projectId,
            {
              event: "message",
              data: {
                parsed: parsedMessage,
              },
            },
            request.requestId,
          );

          const assistantEntry = { role: "assistant", content: finalContent };
          if (deepseekThinking || zaiThinking) {
            assistantEntry.reasoning_content = state.thinking;
          }
          messages.push(assistantEntry);
          journal.append(assistantEntry, { turn, phase: "response" });

          // LOOP CONTROL
          const hasTools = state.toolUses.size > 0;
          const hasContent = state.accumulated.trim().length > 0;
          const wasThinking = state.thinking.trim().length > 0;
          const isLengthLimited = state.finishReason === "length";
          const isToolCalls = state.finishReason === "tool_calls";

          // Handle premature stream disconnects
          // Detect two cases:
          //   1. Stream died with nothing: finishReason null, no content, no tools
          //   2. Stream died mid-output: finishReason null, but has partial content/thinking
          // Both mean the API connection dropped before the model finished its turn.
          const streamDiedEmpty =
            state.finishReason == null && !hasContent && !hasTools;
          const streamDiedMidOutput =
            state.finishReason == null && (hasContent || wasThinking);

          if (
            (streamDiedEmpty || streamDiedMidOutput) &&
            !abortController.signal.aborted
          ) {
            if (disconnectRetryCount < 3) {
              disconnectRetryCount++;
              turn--; // Don't consume a turn

              const diag = streamDiedMidOutput
                ? `partial output (${state.accumulated.length} chars text, ${state.thinking.length} chars thinking)`
                : wasThinking
                  ? "abandoned thought"
                  : "no data received";
              console.warn(
                `[http] Stream closed prematurely (${diag}). Retrying turn ${turn + 1} (attempt ${disconnectRetryCount}/3)...`,
              );

              // Strip the assistant message — it's incomplete
              messages.pop();

              // Preserve partial thinking/content as context for the retry on
              // every attempt, not just the third. Without this, the model
              // re-derives its reasoning from scratch on every retry, hitting
              // the same failure mode repeatedly. The full thinking content is
              // injected (not just tail) so the model doesn't repeat work.
              if (streamDiedMidOutput) {
                const partialContext = [];
                if (state.thinking.trim()) {
                  partialContext.push(
                    `[Your partial reasoning from a dropped connection — continue from here]\n${state.thinking}`,
                  );
                }
                if (state.accumulated.trim()) {
                  partialContext.push(
                    `[Your partial output from a dropped connection — continue from here]\n${state.accumulated}`,
                  );
                }
                if (partialContext.length > 0) {
                  const disconnectMsg = {
                    role: "user",
                    content: [
                      { type: "text", text: partialContext.join("\n\n") },
                    ],
                  };
                  messages.push(disconnectMsg);
                  journal.append(disconnectMsg, {
                    turn,
                    phase: "disconnect-recovery",
                  });
                }
              }

              // Surface the retry to the UI
              this.onEvent(
                request.projectId,
                {
                  event: "status",
                  data: {
                    message: `connection dropped — retrying turn (${disconnectRetryCount}/3)`,
                  },
                },
                request.requestId,
              );

              await new Promise((resolve) =>
                setTimeout(resolve, 2000 * disconnectRetryCount),
              );

              // Clear status
              this.onEvent(
                request.projectId,
                {
                  event: "status",
                  data: { message: null },
                },
                request.requestId,
              );

              continue;
            } else {
              console.error(
                "[http] Stream closed prematurely 3 times in a row. Falling through.",
              );
            }
          }

          disconnectRetryCount = 0; // Reset on success

          // If no reason to continue, check for pending todos before breaking
          if (!hasTools && !isLengthLimited && !isToolCalls) {
            const todos = readState(request.projectId).todos || [];
            const workLeft = todos.some(
              (t) => t.status === "pending" || t.status === "in_progress",
            );

            // MIMO-specific: also catch premature stops where the model ended
            // with "stop" but the last output looks unfinished (e.g. ends mid-code,
            // mid-sentence, or with an explicit "I'll continue" / "Next I will" signal).
            // This happens when the model runs out of reasoning budget and wraps up
            // too early even though max_tokens wasn't actually hit.
            const isMimoProvider =
              request.provider === "xiaomi" ||
              (request.provider === "openrouter" &&
                (resolvedModel || "").includes("mimo"));
            const lastOutput = state.accumulated.trimEnd();
            const looksIncomplete =
              isMimoProvider &&
              state.finishReason === "stop" &&
              // Ends mid-code block (unclosed fence)
              ((lastOutput.match(/```/g) || []).length % 2 !== 0 ||
                // Explicit continuation signal the model wrote
                /(?:I(?:'ll| will| can) (?:now |continue|proceed|implement|write|add)|Next[,:]?\s+I|Let me (?:now |continue|proceed)|Moving on|Continuing)/i.test(
                  lastOutput.slice(-300),
                ) ||
                // Ends with punctuation that implies more is coming
                /[,:]\s*$/.test(lastOutput.slice(-50)));

            // Continue ONLY when the output was genuinely cut off mid-stream
            // (unclosed code fence, explicit "I'll continue", trailing comma).
            // Lingering todos do NOT force continuation: a model doing real work
            // keeps calling tools — a stop with no tools is the model YIELDING,
            // whether it's done or wants the user's input. Respect that instead
            // of force-feeding "keep going," which is what made the model plow
            // past completion and ignore the need for user verification.
            if (looksIncomplete && turn < maxTurns) {
              const remaining = todos.filter((t) => t.status !== "completed");
              const continueReason =
                looksIncomplete && !workLeft
                  ? "incomplete output detected"
                  : `incomplete output with ${remaining.length} pending todos`;
              console.log(
                `[http] Auto-continuing turn ${turn} - ${continueReason}`,
              );

              const continuationParts = [];

              if (looksIncomplete && !workLeft) {
                // ── Incomplete-output continuation (MIMO / reasoning model stopped early) ──
                // The model issued finish_reason:stop but left its output unfinished.
                // We don't inject todos (there are none) — just tell it to pick up
                // exactly where it left off, mirroring what it last wrote so it doesn't
                // re-explore from the top.
                continuationParts.push(
                  "Your output was cut short. Continue exactly from where you left off — do NOT restart, re-explain, or repeat anything already written.",
                );

                // Mirror the model's last partial output so it has the exact tail to continue from
                for (
                  let i = messages.length - 1;
                  i >= Math.max(0, messages.length - 4);
                  i--
                ) {
                  const m = messages[i];
                  if (m.role === "assistant") {
                    // Last reasoning tail — helps reasoning models pick up their thought
                    const thinkingBlock = Array.isArray(m.content)
                      ? m.content.find((b) => b.type === "thinking")
                      : null;
                    if (thinkingBlock?.thinking) {
                      const tail = thinkingBlock.thinking.slice(-400);
                      continuationParts.push(
                        `\n[Your last reasoning — continue the thought]\n...${tail}`,
                      );
                    }
                    // Last output tail — the exact characters the model stopped after
                    const textContent = Array.isArray(m.content)
                      ? m.content
                          .filter((b) => b.type === "text")
                          .map((b) => b.text)
                          .join("\n")
                      : typeof m.content === "string"
                        ? m.content
                        : "";
                    if (textContent.trim()) {
                      const tail = textContent.slice(-500);
                      continuationParts.push(
                        `\n[Your last output — pick up from this exact point]\n...${tail}`,
                      );
                    }
                    break;
                  }
                }
              } else {
                // ── Todo-based continuation (model stopped with pending work) ──────────
                // The model stopped but there is tracked work remaining.
                // Reconstruct what it already accomplished so it picks up where it left
                // off rather than re-exploring from scratch.
                continuationParts.push(
                  "You stopped before finishing. Here is your progress so far — pick up exactly where you left off.",
                );

                // Inject what the model already accomplished this session
                const sessionState = readState(request.projectId);
                const recentActions = sessionState.recentActions || [];
                if (recentActions.length > 0) {
                  const actionSummary = recentActions
                    .slice(-5)
                    .map((a) => `- ${a.content}`)
                    .join("\n");
                  continuationParts.push(
                    `\n[Actions completed so far]\n${actionSummary}`,
                  );
                }

                // Inject decisions locked this session
                const decisions = sessionState.decisions || [];
                if (decisions.length > 0) {
                  const decisionSummary = decisions
                    .slice(-3)
                    .map((d) => `- ${d.content}`)
                    .join("\n");
                  continuationParts.push(
                    `\n[Decisions already made — do not revisit]\n${decisionSummary}`,
                  );
                }

                // Mirror the model's own last thinking/content
                for (
                  let i = messages.length - 1;
                  i >= Math.max(0, messages.length - 4);
                  i--
                ) {
                  const m = messages[i];
                  if (m.role === "assistant") {
                    const thinkingBlock = Array.isArray(m.content)
                      ? m.content.find((b) => b.type === "thinking")
                      : null;
                    if (thinkingBlock?.thinking) {
                      const tail = thinkingBlock.thinking.slice(-500);
                      continuationParts.push(
                        `\n[Your last reasoning before dropping]\n...${tail}`,
                      );
                    }
                    const textContent = Array.isArray(m.content)
                      ? m.content
                          .filter((b) => b.type === "text")
                          .map((b) => b.text)
                          .join("\n")
                      : typeof m.content === "string"
                        ? m.content
                        : "";
                    if (textContent.trim()) {
                      const tail = textContent.slice(-300);
                      continuationParts.push(
                        `\n[Your last output before dropping]\n...${tail}`,
                      );
                    }
                    break;
                  }
                }

                // Remaining work
                if (remaining.length > 0) {
                  const todoList = remaining
                    .map((t) => `- [${t.status}] ${t.content}`)
                    .join("\n");
                  continuationParts.push(`\n[Remaining work]\n${todoList}`);
                }

                // Stall warning
                if (arbiterChangedFiles.size === 0) {
                  continuationParts.push(
                    "\nWARNING: Your last turn made no file changes. Use tools (write_file, replace, bash) to actually implement — do not just discuss.",
                  );
                }
              }

              const contMsg = {
                role: "user",
                content: [{ type: "text", text: continuationParts.join("\n") }],
              };
              messages.push(contMsg);
              journal.append(contMsg, { turn, phase: "auto-continue" });

              // Journal progress snapshot — if the session dies after this,
              // the next resume will know exactly what was accomplished
              const progressState = readState(request.projectId);
              journal.writeProgress({
                accomplishments: (progressState.recentActions || [])
                  .slice(-5)
                  .map((a) => a.content),
                decisions: (progressState.decisions || []).map(
                  (d) => d.content,
                ),
                pendingTodos: (progressState.todos || [])
                  .filter((t) => t.status !== "completed")
                  .map((t) => t.content),
                turn,
              });

              continue;
            }
            break;
          }

          // If it was just a length limit without tools, we continue immediately.
          // BUT: if the model was thinking and ran out of tokens before producing
          // visible content, don't kill the session — inject a continuation prompt.
          // The model's partial reasoning is in state.thinking and was already pushed
          // as reasoning_content in the assistant message, so it has continuity.
          if (isLengthLimited && !hasTools) {
            if (!hasContent && !wasThinking) {
              console.warn(
                `[http] Stopping turn ${turn} - length limit hit but no content or tools produced.`,
              );
              break;
            }
            if (!hasContent && wasThinking) {
              console.log(
                `[http] Length limit hit mid-thought (turn ${turn}). Continuing with continuation prompt so model can produce its response.`,
              );
              const continuationParts = [
                `[Continue] You ran out of tokens while reasoning. Your partial thinking follows. Do NOT repeat any reasoning you already did. Pick up where your reasoning left off and produce the response you were working toward.`,
              ];
              if (state.thinking.trim()) {
                continuationParts.push(
                  `[Your reasoning so far]\n${state.thinking}`,
                );
              }
              const contMsg = {
                role: "user",
                content: [{ type: "text", text: continuationParts.join("\n\n") }],
              };
              messages.push(contMsg);
              journal.append(contMsg, { turn, phase: "thinking-continue" });
              continue;
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
          // Reset the copy-on-write file journal for this turn
          executor.resetJournal();
          let toolSeq = 0; // sequence counter for tool-result-cache

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
                result = {
                  success: true,
                  output: safeStringify(val, null, 2),
                };
              } catch (err) {
                result = { success: false, error: err.message };
              }
            } else if (tool.name === "ask_user") {
              // Terminal tool: the model is handing control back to the user.
              // Surface the question as a normal assistant message so it renders
              // in the conversation, flag the wait, and acknowledge the tool so
              // the turn closes with a valid tool_result. The loop breaks after
              // this batch — the user's next message resumes naturally.
              const question = (parsedInput.question || "").trim();
              const ctx = (parsedInput.context || "").trim();
              const visible = ctx ? `${ctx}\n\n${question}` : question;
              if (visible) {
                this.onEvent(
                  request.projectId,
                  {
                    event: "message",
                    data: {
                      parsed: {
                        type: "assistant",
                        message: { content: [{ type: "text", text: visible }] },
                      },
                    },
                  },
                  request.requestId,
                );
              }
              // Signal the renderer that the session is waiting on the user.
              this.onEvent(
                request.projectId,
                { event: "awaiting_input", data: { question } },
                request.requestId,
              );
              awaitingUserInput = true;
              result = {
                success: true,
                output:
                  "Question delivered to the user. The turn is now paused — stop here and wait for the user's reply. Do not take further action.",
              };
            } else {
              result = await executor.executeTool(
                tool.id,
                tool.name,
                parsedInput,
              );
            }
            let isError = !result.success;
            let content = result.output || result.error || "";

            // ── Immediate Tool Verification (Reflex Gate) ──────────────────
            // If a tool failed or was "hollow" (e.g. replace matched 0 lines),
            // augment the result with an actionable correction directive.
            // This keeps the model in the same "hot" context turn to fix it.
            if (
              tool.name === "replace" &&
              !isError &&
              content.includes("0 replacements")
            ) {
              const filePath = parsedInput.file_path || parsedInput.path;
              content =
                `Error: 0 replacements made in ${filePath}. ` +
                `The 'old_string' you provided did not match any text in the file. ` +
                `TIP: Read the file again to ensure you have the exact text, including all whitespace and indentation. ` +
                `The file content may have changed or your mental model of it is stale.`;
              isError = true; // Treat hollow replacement as an error to trigger re-thinking
            }
            if (tool.name === "write_file" && isError) {
              content = `Error writing file: ${content}. Ensure the path is correct and you have permission.`;
            }

            // ── Tool Result Enrichment ─────────────────────────────────────
            // When the model uses exploration tools (read_file, grep, glob),
            // enrich the result with project intelligence: design constraints,
            // architecture briefs, memories, symbols. The model gets smarter
            // results without calling special tools.
            const ENRICHABLE_TOOLS = new Set([
              "read_file",
              "pane_read_files",
              "grep_search",
              "glob",
            ]);
            if (!isError && ENRICHABLE_TOOLS.has(tool.name)) {
              try {
                const { enrichToolResult } =
                  await import("./tool-enrichment.mjs");
                content = await enrichToolResult(
                  tool.name,
                  parsedInput,
                  content,
                  request.projectId,
                  {
                    brainRequest: this._brainRequest,
                    projectRoot: request.workingDir,
                  },
                );
              } catch {} // enrichment failure is silent — raw result still works
            }

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
                      activeForm:
                        content.split(" ").slice(0, 2).join(" ") + "...",
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
                    data: {
                      activeTask: {
                        description:
                          parsedInput.task || parsedInput.description,
                      },
                    },
                  },
                  request.requestId,
                );
              }

              // Track changed file for Turn Sentinel
              if (
                !isError &&
                (tool.name === "write_file" || tool.name === "replace")
              ) {
                const changedPath =
                  parsedInput.file_path || parsedInput.path || "";
                if (changedPath) arbiterChangedFiles.add(changedPath);
              }
            }

            // Emit tool_result as a "user" message to match CLI worker
            const resultMeta = result.metadata || undefined;
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
                          ...(resultMeta ? { metadata: resultMeta } : {}),
                        },
                      ],
                    },
                  },
                },
              },
              request.requestId,
            );

            // --- PUSH AS CANONICAL TOOL ROLE (with _resultRef) ---
            // Full content goes to ToolResultStore (bounded LRU memory + disk).
            // messages[] gets a lightweight envelope: summary + _resultRef pointer.
            // Fresh turns resolve the pointer at API request time (normalizeMessages);
            // non-fresh turns use the summary already in content. This keeps the
            // messages[] array memory-bounded regardless of turn count.
            const { summary } = buildSummary(
              request.projectId,
              turn,
              toolSeq,
              { toolName: tool.name, toolId: tool.id, content },
              { cache: true },
            );
            toolResultCache.store(request.projectId, turn, toolSeq, {
              toolName: tool.name,
              toolId: tool.id,
              content,
            });
            const toolMsg = {
              role: "tool",
              tool_call_id: tool.id,
              name: tool.name,
              content: summary,
              _resultRef: { turn, seq: toolSeq },
              _contentLength: typeof content === "string" ? content.length : 0,
              is_error: isError,
            };
            messages.push(toolMsg);
            journal.append(toolMsg, { turn, phase: "tool-result" });
            toolSeq++;
          }

          // Always refresh context after tool execution — ensures every turn has fresh state
          // (git status, working set, recent actions, session state, etc.)
          const gitStatus = await this.getGitStatus(request.workingDir);
          mergeState(request.projectId, { gitStatus });

          // Fetch fresh SQLite changes
          let loopSqliteChanges = [];
          try {
            const db = getPaneDb();
            if (db.stmts.getChanges) {
              loopSqliteChanges = db.stmts.getChanges
                .all(request.projectId)
                .slice(0, 10);
            } else {
              console.warn(
                "[http] Database not fully initialized, skipping SQLite changes fetch in loop",
              );
            }
          } catch (err) {
            console.warn(
              "[http] Failed to fetch SQLite changes in loop:",
              err.message,
            );
          }

          // ── Frozen system prompt: DO NOT rebuild ──────────────────────────
          // The system prompt was assembled at spawn time and is frozen for the
          // duration of this conversation. Rebuilding it in the tool loop caused:
          // - Intent directive flipping mid-conversation (DISCUSSION → EXECUTION)
          // - Re-scored memories changing between tool calls
          // - Prompt cache misses on every iteration (wasting tokens)
          //
          // Instead, inject tool-execution deltas as a context-update block.
          // The model sees stable instructions + fresh operational context.
          if (loopSqliteChanges.length > 0 || gitStatus) {
            const deltaLines = ["[context update]"];
            for (const c of loopSqliteChanges.slice(0, 5)) {
              const type = c.old_string || c.oldString ? "edited" : "created";
              deltaLines.push(`- ${type}: ${c.file_path || c.file}`);
            }
            if (gitStatus?.summary) {
              deltaLines.push(
                `- git: ${gitStatus.branch} — ${gitStatus.summary.split("\n")[0]}`,
              );
            }
            deltaLines.push("[end context update]");

            // Inject as a system-role message before the next user turn, or
            // append to the last tool_result message so the model sees it.
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === "user") {
              // Prepend to the user message content
              const deltaText = deltaLines.join("\n");
              if (Array.isArray(lastMsg.content)) {
                lastMsg.content = [
                  { type: "text", text: deltaText },
                  ...lastMsg.content,
                ];
              } else {
                lastMsg.content = deltaText + "\n\n" + (lastMsg.content || "");
              }
            }
          }

          // Window management — V4-direct when turn selection is available
          // Only for explicit-caching providers (Anthropic). Auto-caching
          // providers skip body-level pruning to keep the cache prefix stable.
          // Offloaded to a Worker thread to avoid freezing the main process.
          if (turnSelection && PROVIDERS_WITH_EXPLICIT_CACHE.has(request.provider)) {
            const compResult = await compactMessages("applyV4TurnSelection", {
              messages, turnSelection, projectId: request.projectId,
            });
            messages = compResult.messages;
          }
        } catch (turnError) {
          // Per-turn error handling — retry recoverable errors inside the loop
          if (turnError.name === "AbortError") throw turnError; // propagate to outer
          const isRecoverable = (err) => {
            const msg = (err.message || "").toLowerCase();
            return (
              msg.includes("429") ||
              msg.includes("500") ||
              msg.includes("502") ||
              msg.includes("503") ||
              msg.includes("504") ||
              msg.includes("econnreset") ||
              msg.includes("etimedout") ||
              msg.includes("insufficient_system_resource")
            );
          };
          if (isRecoverable(turnError) && turnRetryCount < MAX_TURN_RETRIES) {
            turnRetryCount++;
            const delay = Math.pow(2, turnRetryCount) * 1000;
            console.warn(
              `[http] Recoverable error on turn ${turn}. Retrying in ${delay}ms (attempt ${turnRetryCount}/${MAX_TURN_RETRIES}). Error: ${turnError.message}`,
            );
            this.onEvent(
              request.projectId,
              {
                event: "status",
                data: {
                  message: `error — retrying turn ${turn} in ${delay / 1000}s (${turnRetryCount}/${MAX_TURN_RETRIES})`,
                },
              },
              request.requestId,
            );
            await new Promise((r) => setTimeout(r, delay));
            // Try to restore from checkpoint. Pre-call checkpoints save
            // the last 6 messages (lightweight), post-turn saves the full array.
            const checkpoint = loadTurn(request.projectId, turn);
            if (checkpoint && checkpoint.messages?.length > 0) {
              if (checkpoint.phase === "pre-call" && checkpoint.fullLength) {
                // Pre-call checkpoint only has tail — splice it back onto the
                // messages array at the correct position to avoid losing earlier context
                const keepFromCurrent = messages.slice(
                  0,
                  checkpoint.fullLength - checkpoint.messages.length,
                );
                messages = [...keepFromCurrent, ...checkpoint.messages];
                console.log(
                  `[http] Restored turn ${turn} from pre-call checkpoint (${checkpoint.messages.length} tail msgs, ${messages.length} total)`,
                );
              } else {
                messages = checkpoint.messages;
                console.log(
                  `[http] Restored turn ${turn} from full checkpoint (${messages.length} msgs)`,
                );
              }
              turn--;
              continue;
            } else {
              console.warn(
                `[http] No usable checkpoint for turn ${turn}, retrying with current state`,
              );
              turn--;
              continue;
            }
          }
          throw turnError; // non-recoverable — propagate to outer catch
        }

        // Turn completed cleanly — mark boundary in journal
        journal.markTurn(turn);

        // ── Turn Sentinel: independently verify the LLM's work ─────────────
        // Runs tsc + eslint on changed files. Verdict persisted for the context
        // orchestrator to inject as CRITICAL on the next turn.
        // Only fire when JS/TS files were changed — markdown, JSON, config-only
        // changes don't need type checking or linting (saves 2-15s of exec time).
        const arbiterTargets = [...arbiterChangedFiles].filter(f =>
          /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path.extname(f)),
        );
        if (arbiterTargets.length > 0) {
          try {
            // Pass DB for architecture sentinel (circular deps, broken imports)
            let arbiterDb = null;
            try {
              arbiterDb = getPaneDb();
            } catch {}
            const verdict = await runTurnSentinel(
              request.projectId,
              request.workingDir,
              arbiterTargets,
              { db: arbiterDb },
            );

            // Record behavioral fingerprint
            if (arbiterDb) {
              // Check if previous verdict had issues that are now resolved (self-correction)
              let selfCorrected = undefined;
              try {
                const prev = arbiterDb.stmts.getRecentVerdicts?.get(
                  request.projectId,
                  1,
                );
                if (prev && prev.verdict_pass === 0 && verdict.pass) {
                  selfCorrected = true; // LLM fixed previous issues
                } else if (prev && prev.verdict_pass === 0 && !verdict.pass) {
                  selfCorrected = false; // LLM didn't fix previous issues
                }
              } catch {}
              recordQualityMetric(arbiterDb, {
                projectId: request.projectId,
                model: request.model,
                provider: request.provider,
                verdict,
                selfCorrected,
              });
            }

            // Emit verdict to renderer so UI can show quality indicator
            this.onEvent(
              request.projectId,
              {
                event: "arbiter_verdict",
                data: verdict,
              },
              request.requestId,
            );

            // Deep Review: fire-and-forget on milestones or repeated failures
            if (arbiterDb) {
              const recent =
                arbiterDb.stmts.getRecentVerdicts?.all(request.projectId, 5) ||
                [];
              const recentFailures = recent.filter(
                (r) => r.verdict_pass === 0,
              ).length;
              const isMilestone = arbiterChangedFiles.size >= 5;

              if (recentFailures >= 3 || isMilestone) {
                // Generate diff for review
                const diffCmd = `cd "${request.workingDir}" && git diff HEAD --no-color 2>/dev/null || echo "(no git diff available)"`;
                import("node:child_process").then(({ exec: execCb }) => {
                  execCb(
                    diffCmd,
                    { maxBuffer: 256 * 1024, timeout: 5000 },
                    (err, stdout) => {
                      const diff = stdout || "";
                      if (diff.length < 50) return; // No meaningful diff
                      const quickCallFn = (sys, usr) => {
                        const cheapReq = {
                          provider: null,
                          model: null,
                          thinking: false,
                        };
                        return this.planningCall(sys, usr, cheapReq);
                      };
                      runDeepReview({
                        diff,
                        intent: request.prompt?.slice(0, 500) || "",
                        callFn: quickCallFn,
                      })
                        .then((review) => {
                          if (review && review.findings.length > 0) {
                            saveDeepReview(request.projectId, review);
                            this.onEvent(
                              request.projectId,
                              {
                                event: "arbiter_verdict",
                                data: { ...verdict, deepReview: review },
                              },
                              request.requestId,
                            );
                          }
                        })
                        .catch(() => {});
                    },
                  );
                });
              }
            }
          } catch (err) {
            console.warn(`[http] Turn Sentinel failed: ${err.message}`);
          }
        }

        // Build handoff document then enrich with pattern extraction — single write at the end.
        // Layer 3: extracted items carry confidence scores.
        // Layer 4: LLM fallback fires when regex found < 2 high-confidence items.
        // Layer 5: model corrections recorded against the previous session's handoff.
        const previousHandoff = readHandoff(request.projectId);
        let handoff = generateHandoff(request.projectId, { writeFile: false });
        if (sessionOutput.length > 0) {
          const extracted = extractFromModelOutput(
            sessionOutput,
            request.projectId,
          );
          handoff = mergeExtractedIntoHandoff(handoff, extracted);
          // Layer 5: record corrections now, before writing the new handoff
          if (extracted.corrections?.length > 0) {
            recordCorrections(
              request.projectId,
              extracted.corrections,
              previousHandoff,
            );
          }
          // Layer 4: async LLM fallback when regex yielded too little
          if (
            countHighConfidence(extracted) < 2 &&
            sessionOutput.length > 500
          ) {
            const quickCallFn = (sys, usr) => {
              const cheapReq = { provider: null, model: null, thinking: false };
              return this.planningCall(sys, usr, cheapReq);
            };
            const brainRequestRef = this._brainRequest;
            const projectId = request.projectId;
            // Fire-and-forget — initial handoff written below, LLM enrichment replaces it in-place
            // via updateLatestHandoff (not writeHandoffWithHistory) to avoid a duplicate history entry
            extractWithLLM(sessionOutput, quickCallFn)
              .then((llmExtracted) => {
                if (Object.keys(llmExtracted).length > 0) {
                  const enriched = mergeExtractedIntoHandoff(
                    { ...handoff },
                    llmExtracted,
                  );
                  updateLatestHandoff(projectId, enriched);
                  // Also index LLM-extracted items into brain
                  const llmEvents = [];
                  for (const item of llmExtracted.accomplishments || []) {
                    llmEvents.push({
                      type: "accomplishment",
                      content: item.text,
                      metadata: {
                        source: item.source,
                        confidence: item.confidence,
                      },
                    });
                  }
                  for (const item of llmExtracted.blockers || []) {
                    llmEvents.push({
                      type: "blocker",
                      content: item.text,
                      metadata: {
                        source: item.source,
                        confidence: item.confidence,
                      },
                    });
                  }
                  for (const item of llmExtracted.nextSteps || []) {
                    llmEvents.push({
                      type: "intent",
                      content: item.text,
                      metadata: {
                        source: item.source,
                        confidence: item.confidence,
                      },
                    });
                  }
                  for (const item of llmExtracted.discoveries || []) {
                    llmEvents.push({
                      type: "discovery",
                      content: item.text,
                      metadata: {
                        source: item.source,
                        confidence: item.confidence,
                      },
                    });
                  }
                  if (llmEvents.length > 0 && brainRequestRef) {
                    brainRequestRef("index_events", {
                      projectId,
                      events: llmEvents,
                    }).catch(() => {});
                  }
                }
              })
              .catch(() => {});
          }

          // ── Close the loop: wire extracted knowledge → brain engine ──────
          // Send structured extraction output as index_events so it enters the
          // knowledge graph, gets synthesized, and becomes searchable across
          // sessions. Then prune the raw messages since they've been extracted.
          const brainEvents = [];
          for (const item of extracted.accomplishments || []) {
            brainEvents.push({
              type: "accomplishment",
              content: item.text,
              metadata: { source: item.source, confidence: item.confidence },
            });
          }
          for (const item of extracted.blockers || []) {
            brainEvents.push({
              type: "blocker",
              content: item.text,
              metadata: { source: item.source, confidence: item.confidence },
            });
          }
          for (const item of extracted.nextSteps || []) {
            brainEvents.push({
              type: "intent",
              content: item.text,
              metadata: { source: item.source, confidence: item.confidence },
            });
          }
          for (const item of extracted.discoveries || []) {
            brainEvents.push({
              type: "discovery",
              content: item.text,
              metadata: { source: item.source, confidence: item.confidence },
            });
          }
          for (const item of extracted.corrections || []) {
            brainEvents.push({
              type: "correction",
              content: item.text,
              metadata: { source: item.source, confidence: item.confidence },
            });
          }
          if (brainEvents.length > 0 && this._brainRequest) {
            this._brainRequest("index_events", {
              projectId: request.projectId,
              events: brainEvents,
            })
              .then((result) => {
                // Only prune if brain indexing actually succeeded
                if (result && result.type !== "error") {
                  pruneConversationMessages(request.projectId, 200);
                }
              })
              .catch((err) =>
                console.warn(
                  `[http] brain index_events failed (non-fatal): ${err.message}`,
                ),
              );
          }
        }
        try {
          writeHandoffWithHistory(request.projectId, handoff);
        } catch (err) {
          console.warn(`[http] Failed to write handoff: ${err.message}`);
        }

        // ── Handoff enrichment: fire-and-forget LLM pass over the journal ──
        // Runs after the basic handoff is written. Enriches the handoff with
        // reasoning chains, failed approaches, patterns, and preferences so
        // the next session's model doesn't start from zero.
        try {
          const { enrichHandoff } = await import("./handoff-enricher.mjs");
          enrichHandoff(request.projectId, updateLatestHandoff).catch((err) =>
            console.warn(`[http] Handoff enrichment failed (non-fatal): ${err.message}`),
          );
        } catch (err) {
          console.warn(`[http] Failed to load handoff enricher: ${err.message}`);
        }

        // Archive after each successful turn (end-of-turn checkpoint)
        // IMPORTANT: Only save the messages added THIS turn (the delta), NOT a
        // full deep clone of the entire conversation. structuredClone(messages)
        // on a 100-200MB+ array allocated 3x copies per turn (structuredClone →
        // JSON.stringify → gzipSync), causing 80GB RSS growth at 500+ turns.
        // The pre-call checkpoint already captures recovery context; the journal
        // handles crash-safe persistence. This archive is a lightweight reference.
        saveTurn(request.projectId, turn, {
          messages: messages.slice(_preCallMessageCount),
          fullLength: messages.length,
          turn,
          timestamp: Date.now(),
          phase: "post-turn",
        });

        // The model called ask_user — it is explicitly handing control back and
        // waiting for a reply. Stop the loop cleanly (all post-turn processing
        // above has run); the user's next message resumes the conversation.
        if (awaitingUserInput) {
          console.log(`[http] ask_user on turn ${turn} — pausing for user input.`);
          break;
        }
      }

      // Signal successful completion so the renderer's resultReceived flag is
      // set and no false "Process exited" error fires.
      this.onEvent(
        request.projectId,
        {
          event: "message",
          data: {
            parsed: {
              type: "result",
              subtype: "success",
              session_id: "",
              result: "",
              total_cost_usd: 0,
              duration_ms: Date.now() - spawnStartTime,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
              },
              num_turns: turn,
            },
          },
        },
        request.requestId,
      );

      // Reset session retry counter on success — next session starts fresh
      this._sessionRetryCount = 0;

      this.onEvent(
        request.projectId,
        {
          event: "processEnded",
          data: { exit_code: 0 },
        },
        request.requestId,
      );

      // Cleanup turn archive and journal on successful completion
      clearTurns(request.projectId);
      journal.close();
      clearJournal(request.projectId);
    } catch (error) {
      // ── SESSION-LEVEL AUTO-RESUME ──────────────────────────────────────
      // Phase 3: Last resort recovery. When all turn-level retries (network,
      // stream disconnect, insufficient_system_resource) and the 400 heal
      // have been exhausted, the session itself might be salvageable by
      // respawning from scratch. The journal preserves full history; re-spawn
      // detects the journal and replays it transparently.
      //
      // We do NOT auto-resume on:
      //   • AbortError — user explicitly cancelled
      //   • 401/403 — auth failures won't fix on retry
      //   • 422 — validation errors require code changes
      const isAuthError =
        error.message?.includes("401") ||
        error.message?.includes("403") ||
        error.message?.includes("unauthorized") ||
        error.message?.includes("forbidden");
      const isRecoverable = error.name !== "AbortError" && !isAuthError;

      if (isRecoverable && this._sessionRetryCount < 2) {
        this._sessionRetryCount++;
        const attempt = this._sessionRetryCount;
        console.warn(
          `[http] session-level auto-resume (attempt ${attempt}/2): ${error.message.slice(0, 200)}`,
        );

        // Preserve discoveries before cleanup
        try {
          const crashHandoff = generateHandoff(request.projectId, {
            writeFile: false,
          });
          crashHandoff._exitReason = "auto-resume";
          crashHandoff._errorMessage = error.message;
          writeHandoffWithHistory(request.projectId, crashHandoff);
        } catch {}

        // Close the old journal so the re-spawn can open it fresh
        try {
          journal?.close();
        } catch {}

        // Clean up state so the re-spawn doesn't collide with stale registrations
        this.activeRequests.delete(request.projectId);
        this.requestStates.delete(request.projectId);

        // Tell the UI we're recovering
        this.onEvent(
          request.projectId,
          {
            event: "status",
            data: {
              message: `connection lost — resuming session (${attempt}/2)...`,
            },
          },
          request.requestId,
        );

        // Brief settle window for any in-flight operations to drain
        await new Promise((r) => setTimeout(r, 2000));

        // Clear status before re-spawn
        this.onEvent(
          request.projectId,
          {
            event: "status",
            data: { message: null },
          },
          request.requestId,
        );

        // Re-spawn the entire session from scratch. The journal on disk has
        // all messages; this.spawn() detects it via canResume() and replays.
        // If spawn succeeds, this call returns normally and the catch block
        // ends here — no error emitted to the user.
        try {
          await this.spawn(request);
          return; // Success — exit without emitting error
        } catch (respawnErr) {
          // Re-spawn also failed — fall through to the real error handling
          console.error(
            `[http] auto-resume attempt ${attempt} failed: ${respawnErr.message}`,
          );
          // Update the error reference so the emergency handoff captures the
          // final error, not the original one
          error = respawnErr;
        }
      }

      // ── Emergency handoff: persist discoveries even on crash/abort ──────
      // Without this, everything the model learned this session is lost.
      try {
        const crashHandoff = generateHandoff(request.projectId, {
          writeFile: false,
        });
        crashHandoff._exitReason =
          error.name === "AbortError" ? "aborted" : "error";
        crashHandoff._errorMessage = error.message;
        writeHandoffWithHistory(request.projectId, crashHandoff);
        console.log(
          `[http] Emergency handoff written on ${crashHandoff._exitReason}`,
        );
      } catch (handoffErr) {
        console.warn(`[http] Emergency handoff failed: ${handoffErr.message}`);
      }

      if (error.name === "AbortError") {
        this.onEvent(
          request.projectId,
          {
            event: "processEnded",
            data: { exit_code: null, aborted: true },
          },
          request.requestId,
        );
      } else {
        // Non-recoverable error (recoverable retries handled in per-turn catch above)
        this.onEvent(
          request.projectId,
          {
            event: "message",
            data: {
              parsed: {
                type: "result",
                subtype: "error",
                session_id: "",
                result: "",
                error: error.message || "HTTP backend error",
                total_cost_usd: 0,
                duration_ms: Date.now() - spawnStartTime,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                },
                num_turns: 0,
              },
            },
          },
          request.requestId,
        );
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
      // Close journal on any exit path — on success it's already cleared,
      // on error/abort it persists on disk for resume
      try {
        journal?.close();
      } catch {}

      // Clear status if we're done or failing
      this.onEvent(
        request.projectId,
        {
          event: "status",
          data: { message: null },
        },
        request.requestId,
      );

      this.activeRequests.delete(request.projectId);
      this.requestStates.delete(request.projectId);
    }
  }

  async prepareRequest(apiConfig, body, request = null) {
    let url, headers;
    let finalBody = body;
    const userTag = `pane-project-${request?.projectId?.slice(0, 8) || "unknown"}`;

    // Extract _tiers metadata from system messages. Used by Anthropic for
    // cache breakpoints and prefix-cache providers for frozen/session split.
    // NOT deleted from the original message — persists across tool loop
    // iterations so caching works on every turn, not just the first.
    // Stripped from finalBody before return to prevent serialization.
    let systemTiers = null;
    if (body.messages) {
      for (const msg of body.messages) {
        if (msg.role === "system" && msg._tiers) {
          systemTiers = msg._tiers;
          break;
        }
      }
    }

    // ── Prefix-cache restructuring for automatic cachers ────────────────
    // DeepSeek, Kimi, Xiaomi, StepFun cache from token 0 of the messages.
    // The system message must be IDENTICAL across turns for cache hits.
    // This function: (1) replaces the system message with frozen-only content
    // (padded to 64-token boundary), (2) injects session+turn as a preamble
    // on the last user message. Applied per-request in prepareRequest, NOT
    // in the shared messages array — keeps history clean across provider switches.
    const applyPrefixCacheOptimization = (msgs, tiers) => {
      if (!tiers?.frozen) return msgs;
      const result = [...msgs];

      // System message = frozen tier only (guaranteed stable)
      let frozenPrompt = tiers.frozen.trim();
      const aligned = Math.ceil(frozenPrompt.length / 256) * 256;
      if (aligned > frozenPrompt.length)
        frozenPrompt += " ".repeat(aligned - frozenPrompt.length);
      result[0] = { role: "system", content: frozenPrompt };

      // Session + turn tiers go as preamble on the last user message
      const dynamicParts = [];
      if (tiers.session) dynamicParts.push(tiers.session);
      if (tiers.turn) dynamicParts.push(tiers.turn);

      if (dynamicParts.length > 0) {
        const preamble = `[Pane context]\n${dynamicParts.join("\n\n")}\n[End context]\n\n`;
        let inserted = false;
        for (let i = result.length - 1; i >= 0; i--) {
          if (result[i].role === "user") {
            const orig =
              typeof result[i].content === "string" ? result[i].content : "";
            result[i] = { ...result[i], content: preamble + orig };
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          result.push({ role: "user", content: preamble.trim() });
        }
      }
      return result;
    };

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
        // Disable default transforms. OpenRouter's provider sticky routing
        // activates automatically when caching is detected — no config needed.
        // Do NOT set provider.order as it disables automatic sticky routing.
        // Apply prefix-cache optimization — most OpenRouter models are served
        // by prefix-caching providers. Anthropic models via OpenRouter support
        // explicit breakpoints, but auto-caching from the smaller system prompt
        // still works.
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          transforms: [],
          data_collection: "allow",
          zdr: false,
          user: userTag,
        };
        break;

      case "deepseek":
        url =
          apiConfig.baseUrl || "https://api.deepseek.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        // Prefix-cache: frozen-only system message + dynamic preamble on user message
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          user: userTag,
        };
        break;

      case "z-ai":
        url =
          apiConfig.baseUrl || "https://api.z.ai/api/paas/v4/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        // Prefix-cache: GLM supports context caching, benefit from frozen-only split
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          user: userTag,
        };
        break;

      case "stepfun":
        // StepFun is fully OpenAI-compatible. Native API is at api.stepfun.com/v1.
        url =
          apiConfig.baseUrl || "https://api.stepfun.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          user: userTag,
        };
        break;

      case "kimi": {
        url =
          apiConfig.baseUrl || "https://api.moonshot.cn/v1/chat/completions";
        // Session affinity: route to same model instance within a project
        // for maximum prefix cache hit rates on multi-turn conversations.
        const kimiSessionId = request?.projectId
          ? `pane-${request.projectId.slice(0, 16)}`
          : undefined;
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
          ...(kimiSessionId ? { "x-session-affinity": kimiSessionId } : {}),
        };
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          user: userTag,
        };
        break;
      }

      case "xiaomi": {
        const base = apiConfig.baseUrl
          ? apiConfig.baseUrl.replace(/\/$/, "")
          : "https://api.xiaomimimo.com/v1";
        url =
          base.includes("/chat/completions") || base.includes("/messages")
            ? base
            : `${base}/chat/completions`;
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        // Prefix-cache: free writes → every token cached is pure savings
        finalBody = {
          ...body,
          messages: systemTiers
            ? applyPrefixCacheOptimization(body.messages, systemTiers)
            : body.messages,
          user: userTag,
        };
        break;
      }

      case "anthropic": {
        const isOAuth = apiConfig.authType === "oauth";

        if (isOAuth) {
          // OAuth mode: Bearer token from Claude Code/Pane keychain.
          // URL must include ?beta=true for OAuth-authenticated requests.
          url = getOAuthApiUrl(apiConfig.baseUrl || "https://api.anthropic.com/v1/messages");
          const accessToken = await getAccessToken();
          if (!accessToken) {
            throw new Error(
              "Claude OAuth credentials are unavailable or expired. Sign in via Settings → Claude Subscription."
            );
          }
          // Pass model for beta exclusions (e.g. haiku → exclude interleaved-thinking)
          const oauthHeaders = getOAuthHeaders(accessToken, request?.model);
          // OAuth betas already include prompt-caching-scope-2026-01-05.
          // Do NOT add prompt-caching-2024-07-31 — it's API-key-only and
          // causes "Invalid request format" when combined with OAuth tokens.
          headers = {
            "Content-Type": "application/json",
            ...oauthHeaders,
          };
          console.log("[http] Anthropic OAuth: using Bearer token, url:", url, "betas:", oauthHeaders["anthropic-beta"]);
        } else {
          url = apiConfig.baseUrl || "https://api.anthropic.com/v1/messages";
          headers = {
            "Content-Type": "application/json",
            "x-api-key": apiConfig.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
          };
        }

        const sysMsg = body.messages.find((m) => m.role === "system");
        const anthropicBody = {
          ...body,
          metadata: { user_id: userTag },
        };
        anthropicBody.messages = body.messages.filter(
          (m) => m.role !== "system",
        );

        // ── Thinking signature safety net ──
        // Anthropic requires that thinking blocks in conversation history include
        // their original signature (from signature_delta events). If a thinking
        // block lacks a signature, the API rejects with 400 "thinking.signature:
        // Field required". This strips any thinking blocks without signatures
        // before sending, so old conversations (before signature capture was added)
        // don't break on multi-turn requests.
        if (Array.isArray(anthropicBody.messages)) {
          for (const msg of anthropicBody.messages) {
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
              msg.content = msg.content.filter(
                (block) =>
                  block.type !== "thinking" || typeof block.signature === "string",
              );
              // If content is now empty, keep at least a minimal text block
              // so the message sequence stays valid
              if (msg.content.length === 0) {
                msg.content = [{ type: "text", text: "(thinking)" }];
              }
            }
          }
        }

        // ── Cache optimizations ──
        // Both API-key and OAuth support cache_control: { type: "ephemeral" }.
        // API-key uses prompt-caching-2024-07-31 beta; OAuth uses
        // prompt-caching-scope-2026-01-05 + extended-cache-ttl-2025-04-11.
        // The cache_control format is identical — only the beta flags differ.
        // The original 400 error was from cache_control being added WITHOUT the
        // correct OAuth beta flag, not from cache_control itself being rejected.
        {
          // Top-level auto-caching: automatically caches the last block of
          // the last message, handling conversation prefix caching without
          // manual breakpoints.
          anthropicBody.cache_control = { type: "ephemeral" };

          // Breakpoint 1: Cache tool definitions (most static content)
          if (anthropicBody.tools?.length > 0) {
            const lastTool = anthropicBody.tools[anthropicBody.tools.length - 1];
            if (typeof lastTool === "object") {
              lastTool.cache_control = { type: "ephemeral" };
            }
          }
        }

        if (sysMsg) {
          // ── Cache-aware system prompt for Anthropic ──
          // Both API-key and OAuth use cache_control: { type: "ephemeral" }.
          // The betas differ (prompt-caching-2024-07-31 vs prompt-caching-scope)
          // but the cache_control format is identical.
          if (systemTiers && systemTiers.frozen) {
            const tiers = systemTiers;
            const blocks = [];
            // Frozen tier — 1-hour cache (biggest win, survives user breaks)
            // OAuth supports caching via prompt-caching-scope-2026-01-05 +
            // extended-cache-ttl-2025-04-11 betas. The cache_control format is
            // the same for both API-key and OAuth — only the beta flag differs.
            if (tiers.frozen) {
              blocks.push({
                type: "text",
                text: tiers.frozen,
                cache_control: { type: "ephemeral", ttl: "1h" },
              });
            }
            // Session tier — 5-min cache (changes on scope change)
            if (tiers.session) {
              blocks.push({
                type: "text",
                text: tiers.session,
                cache_control: { type: "ephemeral" },
              });
            }
            // Turn tier — never cached, changes every turn
            if (tiers.turn) {
              blocks.push({ type: "text", text: tiers.turn });
            }
            anthropicBody.system = blocks;
            console.log(
              `[http] Anthropic cache: tools=cached frozen=${tiers.frozen.length}c(1h) session=${tiers.session.length}c(5m) turn=${tiers.turn.length}c${isOAuth ? " [oauth]" : ""}`,
            );
          } else {
            anthropicBody.system = sysMsg.content;
          }
        }

        // ── OAuth body transformation ──
        // The Anthropic API validates OAuth-authenticated requests by checking:
        // 1. Billing header: signed hash of first user message (proves "Claude Code" client)
        // 2. System identity prefix: "You are Claude Code, Anthropic's official CLI for Claude."
        // 3. Tool names prefixed with mcp_ + PascalCase (lowercase = non-Claude-Code = rejected)
        //
        // IMPORTANT: The API does NOT validate or restrict system[] content beyond
        // billing + identity. Claude Code itself sends its full system prompt (166+ lines)
        // in system[]. All system tiers (frozen, session, turn) stay in system[] with
        // their cache_control intact. The original 400 error (opencode-claude-auth PR #148)
        // was caused by cache_control: { type: "ephemeral" } sent WITHOUT the correct
        // OAuth beta flag, NOT by system content validation. Conflating these two issues
        // caused all system instructions to be demoted to user messages — fundamentally
        // weakening instruction adherence for 6+ months.
        if (isOAuth) {
          const systemBlocks = Array.isArray(anthropicBody.system)
            ? anthropicBody.system
            : typeof anthropicBody.system === "string"
              ? [{ type: "text", text: anthropicBody.system }]
              : anthropicBody.system
                ? [anthropicBody.system]
                : [];

          const BILLING_PREFIX = "x-anthropic-billing-header";
          const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

          // Compute billing header from the ACTUAL first user message text.
          // This must happen BEFORE any modification to messages — the hash
          // is tied to what the user actually typed, not to injected prefixes.
          const billingHeader = buildBillingHeaderValue(anthropicBody.messages || []);

          // Build final system: [billing, identity, ...all other tiers]
          // All system content stays in system[] — no demotion to user messages.
          // Strip any pre-existing billing/identity blocks to avoid duplicates.
          const newSystem = [
            { type: "text", text: billingHeader },
            { type: "text", text: SYSTEM_IDENTITY },
          ];

          for (const block of systemBlocks) {
            const txt = typeof block === "string" ? block : (block.text ?? "");
            if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
              continue; // Already added above
            }
            if (txt.length > 0) {
              newSystem.push(block);
            }
          }

          anthropicBody.system = newSystem;

          // Prefix tool names: mcp_ + PascalCase (Claude Code convention)
          if (Array.isArray(anthropicBody.tools)) {
            anthropicBody.tools = anthropicBody.tools.map((tool) => ({
              ...tool,
              name: tool.name ? prefixToolName(tool.name) : tool.name,
            }));
          }

          // Prefix tool_use names in messages
          if (Array.isArray(anthropicBody.messages)) {
            anthropicBody.messages = anthropicBody.messages.map((msg) => {
              if (!Array.isArray(msg.content)) return msg;
              return {
                ...msg,
                content: msg.content.map((block) => {
                  if (block.type !== "tool_use" || typeof block.name !== "string") return block;
                  return { ...block, name: prefixToolName(block.name) };
                }),
              };
            });
          }

          console.log("[http] Anthropic OAuth: injected billing header, system blocks:", newSystem.length);
        }

        // ── OAuth diagnostic: log key request properties ──
        if (isOAuth) {
          // Write full body synchronously to project dir so the agent can read it
          const diagDir = path.join(os.homedir(), ".pane", "diagnostics");
          try {
            await fs.mkdir(diagDir, { recursive: true });
            const bodyClone = JSON.parse(JSON.stringify(anthropicBody));
            const bodyPath = path.join(diagDir, "oauth-body.json");
            const headerPath = path.join(diagDir, "oauth-headers.json");
            await fs.writeFile(bodyPath, JSON.stringify(bodyClone, null, 2));
            await fs.writeFile(headerPath, JSON.stringify({
              url,
              model: anthropicBody.model,
              messageCount: anthropicBody.messages?.length,
              toolCount: anthropicBody.tools?.length,
              toolNames: anthropicBody.tools?.map((t) => t.name),
              systemBlockCount: Array.isArray(anthropicBody.system) ? anthropicBody.system.length : "not-array",
              system: Array.isArray(anthropicBody.system)
                ? anthropicBody.system.map((b) =>
                    typeof b === "string" ? b.slice(0, 200) : { type: b.type, text: (b.text ?? "").slice(0, 200) }
                  )
                : null,
              hasCacheControl: !!anthropicBody.cache_control,
              headerKeys: Object.keys(headers).filter(k => k !== "Authorization"),
              hasAuth: !!headers.Authorization,
              authPrefix: headers.Authorization?.slice(0, 20),
            }, null, 2));
            console.log("[http] OAuth diagnostic written to:", diagDir);
          } catch (e) {
            console.error("[http] OAuth diagnostic write failed:", e.message);
          }

          console.log(
            "[http] OAuth REQUEST DIAGNOSTIC:",
            JSON.stringify({
              url,
              model: anthropicBody.model,
              messageCount: anthropicBody.messages?.length,
              toolCount: anthropicBody.tools?.length,
              toolNames: anthropicBody.tools?.map((t) => t.name).slice(0, 10),
              systemBlockCount: Array.isArray(anthropicBody.system) ? anthropicBody.system.length : "not-array",
              headerKeys: Object.keys(headers).filter(k => k !== "Authorization"),
            })
          );
        }

        // Conversation caching handled by top-level cache_control (auto-caching).
        // No manual cutoff breakpoint needed — the API incrementally caches
        // the growing conversation prefix and handles the 20-block lookback
        // automatically.

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

        // ── Gemini explicit context caching ──────────────────────────────
        // Cache frozen+session tiers via cachedContents API. When using
        // cachedContent, its systemInstruction replaces any live one, so we
        // cache the stable parts and send the turn tier as a context preamble
        // in the first user message instead.
        // Gemini 2.5+: 90% discount on cached tokens.
        let geminiCachedContent = null;
        const stableSysContent = systemTiers
          ? (systemTiers.frozen + "\n\n" + (systemTiers.session || "")).trim()
          : null;

        if (
          stableSysContent &&
          stableSysContent.length > 4000 &&
          apiConfig.apiKey
        ) {
          // Cache key uses a hash of the actual content — not just length.
          // Session tier changes re-score relevant files/memories, producing
          // different content at similar lengths. A hash catches real changes.
          const { createHash } = await import("node:crypto");
          const contentHash = createHash("md5")
            .update(stableSysContent)
            .digest("hex")
            .slice(0, 12);
          const cacheKey = `gemini:${body.model}:${contentHash}`;
          if (!this._geminiCacheRefs) this._geminiCacheRefs = new Map();

          // Evict stale entries (prevent memory leak from scope changes)
          for (const [k, v] of this._geminiCacheRefs) {
            if (Date.now() > v.expiresAt) this._geminiCacheRefs.delete(k);
          }
          const cached = this._geminiCacheRefs.get(cacheKey);

          if (cached && Date.now() < cached.expiresAt) {
            geminiCachedContent = cached.name;
          } else {
            try {
              const cacheResponse = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiConfig.apiKey}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: safeStringify({
                    model: `models/${body.model}`,
                    systemInstruction: { parts: [{ text: stableSysContent }] },
                    ttl: "1800s",
                  }),
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (cacheResponse.ok) {
                const cacheData = await cacheResponse.json();
                this._geminiCacheRefs.set(cacheKey, {
                  name: cacheData.name,
                  expiresAt: Date.now() + 1800 * 1000,
                });
                geminiCachedContent = cacheData.name;
                console.log(
                  `[http] Gemini cache created: ${cacheData.name} (stable=${stableSysContent.length}c, 30min TTL)`,
                );
              }
            } catch (err) {
              console.warn(
                `[http] Gemini cache creation failed: ${err.message}`,
              );
            }
          }
        }

        // When using cachedContent, systemInstruction comes from the cache.
        // Turn tier is prepended to the first user message as context.
        // When NOT using cache, full system prompt goes in systemInstruction.
        const sysInstructionParts = [];
        if (geminiCachedContent) {
          // Stable tiers are in the cache. Prepend turn tier to the first user message.
          if (systemTiers?.turn) {
            const turnPreamble = `[Context update]\n${systemTiers.turn}\n[End context update]\n\n`;
            const firstUser = contents.find((c) => c.role === "user");
            if (firstUser?.parts?.[0]?.text) {
              firstUser.parts[0] = {
                text: turnPreamble + firstUser.parts[0].text,
              };
            } else {
              // No user message yet — insert one with the turn context
              contents.unshift({
                role: "user",
                parts: [{ text: turnPreamble.trim() }],
              });
            }
          }
        } else {
          const sysMsgs = body.messages.filter((m) => m.role === "system");
          for (const m of sysMsgs)
            sysInstructionParts.push({ text: m.content });
        }

        finalBody = {
          contents,
          ...(geminiCachedContent
            ? { cachedContent: geminiCachedContent }
            : {}),
          tools: [
            {
              functionDeclarations: TOOL_DEFINITIONS.map((td) => ({
                name: td.function.name,
                description: td.function.description,
                parameters: td.function.parameters,
              })),
            },
          ],
          // When using cachedContent, systemInstruction is in the cache — don't send it again.
          ...(sysInstructionParts.length > 0
            ? { systemInstruction: { parts: sysInstructionParts } }
            : {}),
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

    // Strip internal metadata fields before serialization — providers reject unknown fields.
    if (finalBody.messages) {
      for (const msg of finalBody.messages) {
        if (msg._tiers) delete msg._tiers;
        if (msg._tokenEstimate !== undefined) delete msg._tokenEstimate;
      }
    }

    return { url, headers, finalBody };
  }

  getDefaultModel(provider) {
    switch (provider) {
      case "gemini":
        return "gemini-3-flash-preview";
      case "deepseek":
        return "deepseek-v4-flash";
      case "z-ai":
        return "glm-5.2";
      case "stepfun":
        return "step-3.5-flash";
      case "kimi":
        return "moonshot-v1-128k";
      case "xiaomi":
        return "mimo-v2-flash";
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

    // StepFun model IDs are used as-is (step-3.5-flash, step-2-mini, etc.)
    if (provider === "stepfun") return model;

    if (provider === "gemini") {
      const map = {
        "gemini-3-flash-preview": "gemini-3-flash-preview",
        gemini_flash: "gemini-flash-latest",
        gemini_pro: "gemini-pro-latest",
      };
      return map[model.toLowerCase()] || model;
    }

    if (provider === "deepseek") {
      const map = {
        "deepseek-v4-flash": "deepseek-v4-flash",
        "deepseek-v4-pro": "deepseek-v4-pro",
        "deepseek-v4": "deepseek-v4-flash",
      };
      return map[model.toLowerCase()] || model;
    }

    if (provider === "z-ai") {
      // Z.ai GLM models use their native IDs directly (glm-5.2, glm-4.7, etc.)
      const map = {
        "glm-5.2": "glm-5.2",
        "glm-5.1": "glm-5.1",
        "glm-5": "glm-5",
        "glm-5-turbo": "glm-5-turbo",
        "glm-4.7": "glm-4.7",
        "glm-4.7-flash": "glm-4.7-flash",
        "glm-4.6": "glm-4.6",
        "glm-4.5": "glm-4.5",
        "glm-4.5-flash": "glm-4.5-flash",
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

    // Capture usage info if present in any provider's chunk.
    // Provider-specific cache field mapping:
    //   Anthropic:  cache_read_input_tokens, cache_creation_input_tokens
    //   DeepSeek:   prompt_cache_hit_tokens, prompt_cache_miss_tokens
    //   Kimi:       cached_tokens
    //   StepFun:    cached_token (singular)
    //   Xiaomi/OpenAI: prompt_tokens_details.cached_tokens
    //   Gemini:     cachedContentTokenCount (in usageMetadata, handled below)
    if (event.usage) {
      // Normalize cache_read first — needed for input_tokens normalization below.
      const _cacheRead =
        event.usage.cache_read_input_tokens || // Anthropic (handled separately, but harmless)
        event.usage.prompt_cache_hit_tokens || // DeepSeek
        event.usage.cached_tokens || // Kimi
        event.usage.cached_token || // StepFun (singular)
        event.usage.prompt_tokens_details?.cached_tokens || // Xiaomi / OpenAI-compatible
        0;
      // OpenAI-compatible providers (DeepSeek, Kimi, Xiaomi, etc.) report prompt_tokens
      // as the TOTAL — cached + non-cached. Anthropic reports input_tokens as non-cached
      // only (overwritten below). Normalize all providers to raw total here so the DB
      // consistently stores total tokens (including cache). Cache breakdown lives in
      // cache_read_input_tokens. Cost calculation subtracts cache before billing.
      const _rawInput =
        event.usage.prompt_tokens || event.usage.input_tokens || 0;
      state.usage = {
        input_tokens: _rawInput,
        output_tokens:
          event.usage.completion_tokens || event.usage.output_tokens || 0,
        cache_creation_input_tokens:
          event.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: _cacheRead,
        cost: event.usage.cost || null,
      };
    }

    // Anthropic specific usage in message_start or message_delta
    if (provider === "anthropic") {
      if (event.type === "message_start" && event.message?.usage) {
        state.usage = {
          input_tokens:
            (event.message.usage.input_tokens || 0) +
            (event.message.usage.cache_read_input_tokens || 0),
          output_tokens: event.message.usage.output_tokens || 0,
          cache_creation_input_tokens:
            event.message.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens:
            event.message.usage.cache_read_input_tokens || 0,
        };
      } else if (event.type === "message_delta" && event.usage) {
        if (!state.usage) state.usage = { input_tokens: 0, output_tokens: 0 };
        state.usage.output_tokens = event.usage.output_tokens;
      }
    }

    // Gemini specific usage in usageMetadata.
    // promptTokenCount is TOTAL (includes cached). Store raw total; cache
    // breakdown is in cache_read_input_tokens.
    if (provider === "gemini" && event.usageMetadata) {
      const _geminiCacheRead = event.usageMetadata.cachedContentTokenCount || 0;
      state.usage = {
        input_tokens: event.usageMetadata.promptTokenCount || 0,
        output_tokens: event.usageMetadata.candidatesTokenCount || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: _geminiCacheRead,
      };
    }

    switch (provider) {
      case "openrouter": {
        const delta = event.choices?.[0]?.delta;

        // Process tool_calls FIRST. In the OpenAI streaming spec, once a model
        // switches to tool_calls mode it must not also emit meaningful content —
        // but some providers (StepFun, OpenRouter wrappers) occasionally send
        // `content` in the same chunk or in subsequent chunks interleaved with
        // tool_calls. Emitting both causes letter-by-letter JSON rendering.
        // Fix: only extract content when there are NO tool_calls in this chunk
        // AND no tool call has started building in this turn yet.
        const hasDeltaToolCalls = !!delta?.tool_calls?.length;

        if (!hasDeltaToolCalls && state.toolUses.size === 0) {
          if (delta?.content) content = delta.content;
        }

        // Use the model personality registry to read the correct reasoning field.
        // This prevents speculative double-checking of both delta.reasoning and
        // delta.reasoning_content, which could collide if a future model uses both.
        const personality = getModelStreamingConfig(state?.model ?? "");
        if (personality.reasoningField && delta?.[personality.reasoningField]) {
          thinking = delta[personality.reasoningField];
        }

        if (hasDeltaToolCalls) {
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
      }

      // Native provider cases — fixed, known streaming formats.
      // DeepSeek V4 uses reasoning_content; stepfun uses reasoning;
      // kimi uses standard content only. Tool-call handling is identical
      // to the openrouter block above so they share that logic via fallthrough.
      case "xiaomi":
      case "z-ai":
      case "deepseek":
      case "kimi":
      case "stepfun": {
        const delta = event.choices?.[0]?.delta;
        const hasDeltaToolCalls = !!delta?.tool_calls?.length;

        if (!hasDeltaToolCalls && state.toolUses.size === 0) {
          if (delta?.content) content = delta.content;
        }

        // Use the model personality registry to read the correct reasoning field.
        const personality = getModelStreamingConfig(state?.model ?? "");
        if (personality.reasoningField && delta?.[personality.reasoningField]) {
          thinking = delta[personality.reasoningField];
        }

        // Fallback for known fields if personality check failed
        if (!thinking) {
          if (delta?.reasoning_content) thinking = delta.reasoning_content;
          if (delta?.reasoning) thinking = delta.reasoning;
        }

        if (hasDeltaToolCalls) {
          const tc = event.choices[0].delta.tool_calls[0];
          if (tc) {
            const toolId = tc.id;
            const toolName = tc.function?.name || "";
            const toolArgs = tc.function?.arguments || "";
            if (toolId) {
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
      }

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
              const toolArgs = safeStringify(fc.args || {});

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

        // Signature delta: Anthropic sends this after thinking content to
        // provide the cryptographic signature required for multi-turn conversations.
        // When interleaved thinking is enabled, subsequent turns MUST include the
        // signature on thinking blocks. Without it, the API rejects with
        // "thinking.signature: Field required" (400).
        // Forward to frontend so it can attach the signature to the thinking block.
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "signature_delta" &&
          event.delta.signature
        ) {
          // Store in state for journal storage
          state.thinkingSignature = event.delta.signature;
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
                      type: "signature_delta",
                      signature: event.delta.signature,
                    },
                  },
                },
              },
            },
            requestId,
          );
          emitted = true;
        }

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          const tb = event.content_block;
          // Strip mcp_ prefix if present (Claude Code OAuth convention)
          const strippedName = unprefixToolName(tb.name);
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
                      name: strippedName,
                      input: {},
                    },
                  },
                },
              },
            },
            requestId,
          );
          state.toolUses.set(tb.id, { id: tb.id, name: strippedName, input: "" });
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
      state.thinking += thinking; // Accumulate for resilience checks
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
      // Include thinking block with signature for Anthropic OAuth/interleaved-thinking.
      // The API requires that thinking blocks in conversation history include their
      // original signature. Without it, multi-turn requests fail with 400.
      if (state.thinking && state.thinkingSignature) {
        finalContent.push({
          type: "thinking",
          thinking: state.thinking,
          signature: state.thinkingSignature,
        });
      }
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
    // Kill any background processes spawned by tools for this project
    const executor = this.toolExecutors.get(projectId);
    if (executor) {
      executor.cleanup();
      this.toolExecutors.delete(projectId);
    }
  }

  async terminate(projectId) {
    await this.abort(projectId);
  }

  shutdown() {
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    this.requestStates.clear();
    // Clean up ALL tool executors — kill background processes, release references
    for (const [, executor] of this.toolExecutors) {
      executor.cleanup();
    }
    this.toolExecutors.clear();
    // Gracefully terminate the compaction worker
    stopCompactionWorker();
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

      return json.data
        .map(_normalizeModel)
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch OpenRouter models:", err);
      return [];
    }
  }

  /**
   * Fetch available DeepSeek models via their OpenAI-compatible /models endpoint.
   */
  async getDeepSeekModels() {
    const apiConfig = await this.getApiConfig("deepseek");
    if (!apiConfig.apiKey) return [];

    try {
      const url = apiConfig.baseUrl
        ? apiConfig.baseUrl.replace(/\/chat\/completions\/?$/, "/models")
        : "https://api.deepseek.com/v1/models";
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiConfig.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return [];

      const json = await response.json();
      if (!json.data) return [];

      return json.data
        .filter(
          (m) => m.id && !m.id.includes("embed") && !m.id.includes("whisper"),
        )
        .map((m) => ({
          id: m.id,
          name: _deepSeekDisplayName(m.id),
          context_length: m.context_length || _deepSeekContextLength(m.id),
          provider: "DeepSeek",
          tier: m.id.includes("reasoner") || m.id.includes("r1") ? 1 : 2,
          input_cost: null,
          output_cost: null,
        }))
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch DeepSeek models:", err);
      return [];
    }
  }

  /**
   * Fetch available Z.ai (GLM) models via their OpenAI-compatible /models endpoint.
   * Z.ai's /models endpoint returns the standard OpenAI format with id, context_length, etc.
   */
  async getZaiModels() {
    const apiConfig = await this.getApiConfig("z-ai");
    if (!apiConfig.apiKey) return [];

    try {
      const base = apiConfig.baseUrl
        ? apiConfig.baseUrl.replace(/\/chat\/completions\/?$/, "")
        : "https://api.z.ai/api/paas/v4";
      const baseUrlClean = base.replace(/\/$/, "");
      let url = baseUrlClean.endsWith("/models")
        ? baseUrlClean
        : `${baseUrlClean}/models`;

      let response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiConfig.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });

      // Coding Plan fallback: if no custom base URL and the standard endpoint
      // failed, try the Coding Plan endpoint (its key isn't valid on standard).
      if (!response.ok && !apiConfig.baseUrl) {
        console.warn(
          "[http] Z.ai models: standard endpoint failed — retrying with Coding Plan endpoint"
        );
        url = "https://api.z.ai/api/coding/paas/v4/models";
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${apiConfig.apiKey}` },
          signal: AbortSignal.timeout(12_000),
        });
      }

      if (!response.ok) return [];

      const json = await response.json();
      if (!json.data) return [];

      return json.data
        .filter((m) => m.id && (m.id.includes("glm") || m.id.includes("cogview")))
        .map((m) => ({
          id: m.id,
          name: _zaiDisplayName(m.id),
          context_length: m.context_length || _zaiContextLength(m.id),
          provider: "Z.ai",
          tier: m.id.includes("glm-5") ? 1 : m.id.includes("glm-4.7") ? 1 : 2,
          input_cost: null,
          output_cost: null,
        }))
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch Z.ai models:", err);
      return [];
    }
  }

  /**
   * Fetch available Xiaomi MiMo models via their OpenAI-compatible /models endpoint.
   */
  async getXiaomiModels() {
    const apiConfig = await this.getApiConfig("xiaomi");
    if (!apiConfig.apiKey) return [];

    try {
      const base = apiConfig.baseUrl
        ? apiConfig.baseUrl.replace(/\/$/, "")
        : "https://api.xiaomimimo.com/v1";
      const baseUrlClean = base.replace(
        /\/(chat\/completions|messages)\/?$/,
        "",
      );
      const url = baseUrlClean.endsWith("/models")
        ? baseUrlClean
        : `${baseUrlClean}/models`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiConfig.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return [];

      const json = await response.json();
      if (!json.data) return [];

      const MIMO_CONTEXT = {
        "mimo-v2-flash": 262144,
        "mimo-v2-pro": 1000000,
        "mimo-v2-omni": 1000000,
      };

      return json.data
        .filter((m) => m.id && m.id.includes("mimo"))
        .map((m) => {
          const id = m.id;
          const name = id
            .replace(/^mimo-/, "MiMo ")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          const ctxKey = Object.keys(MIMO_CONTEXT).find((k) => id.includes(k));
          return {
            id,
            name,
            context_length: MIMO_CONTEXT[ctxKey] || 262144,
            provider: "Xiaomi",
            tier: id.includes("pro") ? 1 : id.includes("omni") ? 1 : 2,
            input_cost: null,
            output_cost: null,
          };
        })
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch Xiaomi models:", err);
      return [];
    }
  }

  /**
   * Fetch available Anthropic models via their /v1/models endpoint.
   */
  async getAnthropicModels() {
    const apiConfig = await this.getApiConfig("anthropic");
    const isOAuth = apiConfig.authType === "oauth";
    if (!apiConfig.apiKey && !isOAuth) return [];

    try {
      const url = apiConfig.baseUrl
        ? apiConfig.baseUrl.replace(/\/messages\/?$/, "/models")
        : "https://api.anthropic.com/v1/models";

      let fetchHeaders;
      if (isOAuth) {
        const accessToken = await getAccessToken();
        if (!accessToken) return [];
        const oauthHeaders = getOAuthHeaders(accessToken);
        fetchHeaders = {
          Authorization: oauthHeaders.Authorization,
          "anthropic-version": oauthHeaders["anthropic-version"],
          "user-agent": oauthHeaders["user-agent"],
          "anthropic-dangerous-direct-browser-access": oauthHeaders["anthropic-dangerous-direct-browser-access"],
          "x-app": oauthHeaders["x-app"],
        };
      } else {
        fetchHeaders = {
          "x-api-key": apiConfig.apiKey,
          "anthropic-version": "2023-06-01",
        };
      }

      const response = await fetch(url, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return [];

      const json = await response.json();
      const models = json.data || [];

      return models
        .filter((m) => m.id && m.type === "model")
        .map((m) => ({
          id: m.id,
          name: m.display_name || _anthropicDisplayName(m.id),
          context_length: _anthropicContextLength(m.id),
          provider: "Anthropic",
          tier: m.id.includes("opus") ? 1 : m.id.includes("sonnet") ? 2 : 3,
          input_cost: null,
          output_cost: null,
        }))
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch Anthropic models:", err);
      return [];
    }
  }

  /**
   * Fetch available Gemini models via the generativelanguage API.
   */
  async getGeminiModels() {
    const apiConfig = await this.getApiConfig("gemini");
    if (!apiConfig.apiKey) return [];

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiConfig.apiKey}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return [];

      const json = await response.json();
      const models = json.models || [];

      return models
        .filter((m) => {
          const methods = m.supportedGenerationMethods || [];
          if (!methods.includes("generateContent")) return false;
          if ((m.inputTokenLimit || 0) < 16384) return false;
          return true;
        })
        .map((m) => {
          const id = (m.name || "").replace(/^models\//, "");
          return {
            id,
            name: m.displayName || id,
            context_length: m.inputTokenLimit || 128000,
            provider: "Google",
            tier: id.includes("pro") ? 1 : id.includes("flash") ? 2 : 3,
            input_cost: null,
            output_cost: null,
          };
        })
        .sort(_byRelevance);
    } catch (err) {
      console.error("[http] Failed to fetch Gemini models:", err);
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
      messages: this.normalizeMessages(
        [
          {
            role: "system",
            content: systemPrompt,
            _tiers: { frozen: systemPrompt, session: "", turn: "" },
          },
          { role: "user", content: userPrompt },
        ],
        apiConfig.provider,
      ),
      stream: true,
      // No tools — pure text generation for planning
    };

    // Request usage data in streaming response for OpenAI-compatible providers
    if (
      ["deepseek", "kimi", "stepfun", "xiaomi", "openrouter"].includes(
        apiConfig.provider,
      )
    ) {
      body.stream_options = { include_usage: true };
    }

    const { url, headers, finalBody } = await this.prepareRequest(
      apiConfig,
      body,
      request,
    );

    const cleanBody = { ...(finalBody || body), stream: true };
    delete cleanBody.tools;

    // ============================================================================
    // Endurance retry loop for planning calls
    // ============================================================================
    const MAX_RETRIES = 7;
    const BASE_DELAY_MS = 1000;
    let attempt = 0;

    while (true) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: safeStringify(cleanBody),
        });

        if (!response.ok) {
          const status = response.status;

          // Client errors (4xx except 429) are not retryable — propagate immediately
          if (status >= 400 && status < 500 && status !== 429) {
            const errorText = await response
              .text()
              .catch(() => response.statusText);
            const fatal = new Error(
              `Planning call failed: HTTP ${status}: ${errorText}`,
            );
            fatal._noRetry = true;
            throw fatal;
          }

          // Rate limit or server error: retry with backoff
          if (attempt < MAX_RETRIES) {
            const retryAfterSec =
              status === 429
                ? parseInt(response.headers.get("retry-after") || "0", 10)
                : 0;
            const jitter = Math.random() * 500;
            const delay =
              retryAfterSec > 0
                ? retryAfterSec * 1000
                : Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) +
                  jitter;

            console.warn(
              `[http] Planning call ${status}. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_RETRIES})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
            continue;
          }

          const errorText = await response
            .text()
            .catch(() => response.statusText);
          throw new Error(
            `Planning call failed after ${MAX_RETRIES} attempts: HTTP ${status}: ${errorText}`,
          );
        }

        // Stream the response — extract text deltas and call onChunk as they arrive
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let buffer = "";
        let usage = null;
        const callStartTime = Date.now();

        const STREAM_IDLE_TIMEOUT_MS = 60_000;
        let _idleTimerId = null;
        async function readWithTimeout() {
          clearTimeout(_idleTimerId);
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              _idleTimerId = setTimeout(
                () => reject(new Error("Stream idle timeout — no data received for 60s")),
                STREAM_IDLE_TIMEOUT_MS,
              );
            }),
          ]);
          clearTimeout(_idleTimerId);
          return result;
        }

        while (true) {
          const { done, value } = await readWithTimeout();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete last line

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            // Capture usage
            if (parsed.usage) usage = parsed.usage;
            if (apiConfig.provider === "anthropic") {
              if (parsed.type === "message_start") usage = parsed.message.usage;
              if (parsed.type === "message_delta") usage = parsed.usage;
            } else if (
              apiConfig.provider === "gemini" &&
              parsed.usageMetadata
            ) {
              usage = {
                prompt_tokens: parsed.usageMetadata.promptTokenCount,
                completion_tokens: parsed.usageMetadata.candidatesTokenCount,
                prompt_cache_hit_tokens:
                  parsed.usageMetadata.cachedContentTokenCount || 0,
              };
            }

            let delta = "";
            if (apiConfig.provider === "anthropic") {
              // Anthropic: content_block_delta with text_delta
              if (
                parsed.type === "content_block_delta" &&
                parsed.delta?.type === "text_delta"
              ) {
                delta = parsed.delta.text || "";
              }
            } else if (apiConfig.provider === "gemini") {
              if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                delta = parsed.candidates[0].content.parts[0].text;
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

        // Emit token_usage for the planning call
        // Normalize input_tokens to raw total (including cache) for consistent DB storage.
        // OpenAI-compatible and Gemini report prompt_tokens as TOTAL (cached + non-cached).
        // Anthropic reports input_tokens as non-cached only — add cache_read for raw total.
        const _rawInput = usage?.prompt_tokens || usage?.input_tokens || 0;
        const cacheRead =
          usage?.cache_read_input_tokens || usage?.prompt_cache_hit_tokens || 0;
        const totalInput =
          apiConfig.provider === "anthropic"
            ? _rawInput + cacheRead
            : _rawInput;
        const costInput =
          apiConfig.provider === "anthropic"
            ? _rawInput
            : Math.max(0, _rawInput - cacheRead);
        const totalOutput =
          usage?.completion_tokens || usage?.output_tokens || 0;
        const cacheWrite = usage?.cache_creation_input_tokens || 0;

        const {
          cost: callCost,
          source: costSource,
          rateSnapshot,
        } = calculateCost({
          model,
          provider: apiConfig.provider,
          inputTokens: costInput,
          outputTokens: totalOutput,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          apiReportedCost: usage?.cost,
        });

        this.onEvent(
          request.projectId,
          {
            event: "token_usage",
            data: {
              provider: apiConfig.provider,
              activity_type: request.activity_type || "planning",
              model,
              input_tokens: totalInput,
              output_tokens: totalOutput,
              cache_creation_input_tokens: cacheWrite,
              cache_read_input_tokens: cacheRead,
              cost_usd: callCost,
              cost_source: costSource,
              cost_rate_snapshot: rateSnapshot
                ? JSON.stringify(rateSnapshot)
                : null,
              duration_ms: Date.now() - callStartTime,
            },
          },
          request.requestId,
        );

        return fullText;
      } catch (err) {
        if (err.name === "AbortError" || err._noRetry) throw err;

        if (attempt < MAX_RETRIES) {
          const jitter = Math.random() * 500;
          const delay =
            Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) + jitter;

          console.warn(
            `[http] Planning call network error: ${err.message}. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
          continue;
        }

        throw new Error(
          `Planning call failed after ${MAX_RETRIES} attempts: ${err.message}`,
        );
      }
    }
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
      {
        role: "system",
        content: systemPrompt,
        _tiers: { frozen: systemPrompt, session: "", turn: "" },
      },
      ...messages,
    ];

    const normalizedMessages = this.normalizeMessages(
      fullMessages,
      apiConfig.provider,
    );
    const validatedMessages = validateMessageSequence(
      normalizedMessages,
      apiConfig.provider,
    );
    const body = {
      model,
      messages: validatedMessages,
      stream: false,
      max_tokens: 2048,
      // No tools — pure conversation for discovery
    };

    const { url, headers, finalBody } = await this.prepareRequest(
      apiConfig,
      body,
      request,
    );

    // Strip tools from finalBody if prepareRequest added them
    const cleanBody = { ...(finalBody || body) };
    delete cleanBody.tools;

    // ============================================================================
    // Endurance retry loop for conversation calls
    // ============================================================================
    const MAX_RETRIES = 7;
    const BASE_DELAY_MS = 1000;
    let attempt = 0;

    while (true) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: safeStringify(cleanBody),
        });

        if (!response.ok) {
          const status = response.status;

          // Client errors (4xx except 429) are not retryable — propagate immediately
          if (status >= 400 && status < 500 && status !== 429) {
            const errorText = await response
              .text()
              .catch(() => response.statusText);
            const fatal = new Error(
              `Conversation call failed: HTTP ${status}: ${errorText}`,
            );
            fatal._noRetry = true;
            throw fatal;
          }

          // Rate limit or server error: retry with backoff
          if (attempt < MAX_RETRIES) {
            const retryAfterSec =
              status === 429
                ? parseInt(response.headers.get("retry-after") || "0", 10)
                : 0;
            const jitter = Math.random() * 500;
            const delay =
              retryAfterSec > 0
                ? retryAfterSec * 1000
                : Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) +
                  jitter;

            console.warn(
              `[http] Conversation call ${status}. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_RETRIES})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
            continue;
          }

          const errorText = await response
            .text()
            .catch(() => response.statusText);
          throw new Error(
            `Conversation call failed after ${MAX_RETRIES} attempts: HTTP ${status}: ${errorText}`,
          );
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
      } catch (err) {
        if (err.name === "AbortError" || err._noRetry) throw err;

        if (attempt < MAX_RETRIES) {
          const jitter = Math.random() * 500;
          const delay =
            Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30000) + jitter;

          console.warn(
            `[http] Conversation call network error: ${err.message}. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
          continue;
        }

        throw new Error(
          `Conversation call failed after ${MAX_RETRIES} attempts: ${err.message}`,
        );
      }
    }
  }
}

// base64ToFloat32Array is now imported from ./semantic-turn-selector.mjs
