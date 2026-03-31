import { useCallback, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { useWorkspaceStore } from "../stores/workspace";
import type { Todo } from "../lib/punk-types";

// ============================================================================
// Model Execution Timeout Configuration
// ============================================================================
// These timeouts determine when to consider a model "hung" and force termination.
// Increased values to prevent premature killing of long-running operations.
// ============================================================================
const MODEL_SAFETY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for silent stream
const RESULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes after result message
const CHECKPOINT_TIMEOUT_MS = 3 * 1000; // 3 seconds for checkpoint creation

import {
  sendToPunk,
  abortPunk,
  createCheckpoint,
  deleteProjectCheckpoints,
  recordMemoryEvents,
  recordChange,
  generateBrief,
  brainIndexEvents,
  brainContextualSearch,
  brainClearSessionPins,
  sessionMergeState,
  sessionClearState,
  sessionReadState,
  extractPreferencesFromTurn,
} from "../lib/tauri-commands";
import type {
  PunkStreamEvent,
  PunkStreamMessage,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  MemoryEvent,
} from "../lib/punk-types";
import {
  inferAgentIntent,
  chooseModelForIntent,
  type AgentIntent,
} from "../lib/agent-routing";
import { getContextLimit } from "../lib/models";

// Active tool input animations keyed by `${projectId}:${toolId}`.
// Used to cancel a previous animation if the same tool is re-animated.
const activeToolAnimations = new Map<string, { cancelled: boolean }>();

function streamToolInputAnimate(
  projectId: string,
  toolId: string,
  completeInput: Record<string, unknown>,
) {
  const key = `${projectId}:${toolId}`;
  const existing = activeToolAnimations.get(key);
  if (existing) existing.cancelled = true;

  const token = { cancelled: false };
  activeToolAnimations.set(key, token);

  const json = JSON.stringify(completeInput);
  // Scale so animation takes ~0.4–1.5s regardless of content length
  const targetMs = Math.min(Math.max(json.length * 0.8, 400), 1500);
  const charsPerFrame = Math.max(
    Math.ceil(json.length / (targetMs / (1000 / 60))),
    1,
  );

  let pos = 0;
  const tick = () => {
    if (token.cancelled) {
      activeToolAnimations.delete(key);
      return;
    }
    pos = Math.min(pos + charsPerFrame, json.length);
    const partial = fixPartialJson(json.slice(0, pos));
    try {
      const parsed = JSON.parse(partial) as Record<string, unknown>;
      useProjectsStore.getState().updateToolUseInputById(projectId, toolId, parsed);
    } catch {
      /* partial JSON not yet parseable — skip frame */
    }

    if (pos < json.length) {
      requestAnimationFrame(tick);
    } else {
      // Final frame: guarantee complete input
      useProjectsStore
        .getState()
        .updateToolUseInputById(projectId, toolId, completeInput);
      activeToolAnimations.delete(key);
    }
  };
  requestAnimationFrame(tick);
}

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

interface StreamingState {
  pendingTextDelta: string;
  pendingThinkingDelta: string;
  textFlushRaf: number;
  thinkingFlushRaf: number;
  pendingToolInput: Record<string, unknown> | null;
  toolInputFlushRaf: number;
  toolJsonParseRaf: number;
  pendingToolJson: string;
  pendingToolJsonTruncated: boolean;
  pendingTodos: import("../lib/punk-types").Todo[] | null;
  todosFlushRaf: number;
  // Per-tool streaming tracking
  currentStreamingToolId: string | null;
  currentToolDeltaCount: number; // how many partial_json_delta events for current tool
}

const streamingStates = new Map<string, StreamingState>();

function getStreamingState(projectId: string): StreamingState {
  let state = streamingStates.get(projectId);
  if (!state) {
    state = {
      pendingTextDelta: "",
      pendingThinkingDelta: "",
      textFlushRaf: 0,
      thinkingFlushRaf: 0,
      pendingToolInput: null,
      toolInputFlushRaf: 0,
      toolJsonParseRaf: 0,
      pendingToolJson: "",
      pendingToolJsonTruncated: false,
      pendingTodos: null,
      todosFlushRaf: 0,
      currentStreamingToolId: null,
      currentToolDeltaCount: 0,
    };
    streamingStates.set(projectId, state);
  }
  return state;
}

const MAX_STREAMING_TOOL_JSON_CHARS = 100_000;

function flushToolInput(projectId: string) {
  const state = getStreamingState(projectId);
  if (state.pendingToolInput) {
    useProjectsStore
      .getState()
      .updateLastToolUseInput(projectId, state.pendingToolInput);
    state.pendingToolInput = null;
  }
  state.toolInputFlushRaf = 0;
}

function scheduleToolJsonParse(projectId: string) {
  const state = getStreamingState(projectId);
  if (state.toolJsonParseRaf) return;
  state.toolJsonParseRaf = requestAnimationFrame(() => {
    state.toolJsonParseRaf = 0;

    if (state.pendingToolJsonTruncated) return;
    if (!state.pendingToolJson) return;

    const fixed = fixPartialJson(state.pendingToolJson);
    try {
      const parsed = JSON.parse(fixed) as Record<string, unknown>;

      const store = useProjectsStore.getState();
      const project = store.projects.get(projectId);
      if (project) {
        const msgs = project.conversation.messages;
        const last = msgs[msgs.length - 1];
        if (last && last.type === "assistant") {
          // Check all tools in the last message, not just the last tool
          // This ensures we capture TodoWrite even if there are multiple tools
          const toolUses = last.content.filter(
            (b) => b.type === "tool_use"
          ) as ToolUseBlock[];
          
          // Find the TodoWrite tool and extract todos from parsed input
          const todoWriteTool = toolUses.find((t) => t.name === "TodoWrite");
          if (todoWriteTool && Array.isArray(parsed.todos)) {
            state.pendingTodos = (
              parsed.todos as import("../lib/punk-types").Todo[]
            ).map((t) => ({ ...t }));
            if (!state.todosFlushRaf) {
              state.todosFlushRaf = requestAnimationFrame(() =>
                flushTodos(projectId),
              );
            }
          }
        }
      }

      state.pendingToolInput = parsed;
      if (!state.toolInputFlushRaf) {
        state.toolInputFlushRaf = requestAnimationFrame(() =>
          flushToolInput(projectId),
        );
      }
    } catch {
      // Still incomplete
    }
  });
}

function flushTodos(projectId: string) {
  const state = getStreamingState(projectId);
  if (state.pendingTodos) {
    useProjectsStore
      .getState()
      .setConversationTodos(projectId, state.pendingTodos);
    state.pendingTodos = null;
  }
  state.todosFlushRaf = 0;
}

function flushTextDelta(projectId: string) {
  const state = getStreamingState(projectId);
  if (state.pendingTextDelta) {
    // Flush the full buffer in one shot per frame — no character-drip throttle.
    // The typewriter bleed (1-4 chars/frame) caused visible lag: fast scrolls
    // landed on empty space while the buffer slowly caught up (~1s delay in dev).
    // Natural streaming cadence from the backend already produces smooth output.
    useProjectsStore.getState().appendToLastAssistantText(projectId, state.pendingTextDelta);
    state.pendingTextDelta = "";
  }
  state.textFlushRaf = 0;
}

function resetStreamingState(projectId: string, flush = false) {
  const state = getStreamingState(projectId);
  if (flush) {
    if (state.pendingTextDelta) {
      cancelAnimationFrame(state.textFlushRaf);
      useProjectsStore
        .getState()
        .appendToLastAssistantText(projectId, state.pendingTextDelta);
      state.pendingTextDelta = "";
    }
    if (state.pendingThinkingDelta) {
      cancelAnimationFrame(state.thinkingFlushRaf);
      useProjectsStore
        .getState()
        .appendToLastAssistantThinking(projectId, state.pendingThinkingDelta);
      state.pendingThinkingDelta = "";
    }
    // Flush any pending tool JSON that didn't make it through the rAF pipeline.
    // This happens when resetStreamingState is called (e.g. on a tool_result message)
    // before the toolJsonParseRaf fires — common with fast CLI tool sequences.
    if (state.pendingToolJson && !state.pendingToolJsonTruncated) {
      cancelAnimationFrame(state.toolJsonParseRaf);
      state.toolJsonParseRaf = 0;
      const fixed = fixPartialJson(state.pendingToolJson);
      try {
        state.pendingToolInput = JSON.parse(fixed) as Record<string, unknown>;
      } catch { /* ignore */ }
      state.pendingToolJson = "";
    }
    if (state.pendingToolInput) {
      cancelAnimationFrame(state.toolInputFlushRaf);
      flushToolInput(projectId);
    }
    if (state.pendingTodos) {
      cancelAnimationFrame(state.todosFlushRaf);
      flushTodos(projectId);
    }
  }

  if (state.textFlushRaf) cancelAnimationFrame(state.textFlushRaf);
  if (state.thinkingFlushRaf) cancelAnimationFrame(state.thinkingFlushRaf);
  if (state.toolInputFlushRaf) cancelAnimationFrame(state.toolInputFlushRaf);
  if (state.toolJsonParseRaf) cancelAnimationFrame(state.toolJsonParseRaf);
  if (state.todosFlushRaf) cancelAnimationFrame(state.todosFlushRaf);

  state.pendingTextDelta = "";
  state.pendingThinkingDelta = "";
  state.pendingToolInput = null;
  state.pendingToolJson = "";
  state.pendingToolJsonTruncated = false;
  state.pendingTodos = null;

  state.textFlushRaf = 0;
  state.thinkingFlushRaf = 0;
  state.toolInputFlushRaf = 0;
  state.toolJsonParseRaf = 0;
  state.todosFlushRaf = 0;
  state.currentStreamingToolId = null;
  state.currentToolDeltaCount = 0;

  // Cancel any active CLI tool animations for this project
  const prefix = `${projectId}:`;
  for (const [key, token] of activeToolAnimations) {
    if (key.startsWith(prefix)) token.cancelled = true;
  }
}

function flushThinkingDelta(projectId: string) {
  const state = getStreamingState(projectId);
  if (state.pendingThinkingDelta) {
    useProjectsStore
      .getState()
      .appendToLastAssistantThinking(projectId, state.pendingThinkingDelta);
    state.pendingThinkingDelta = "";
  }
  state.thinkingFlushRaf = 0;
}

function fixPartialJson(s: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let result = s;
  if (inString) result += '"';
  while (stack.length) result += stack.pop();
  return result;
}

function extractMemoryEvents(messages: ConversationMessage[]): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const now = Date.now();

  let turnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === "user") {
      turnStart = i;
      break;
    }
  }
  const turnMessages = messages.slice(turnStart);

  let lastError: string | null = null;
  let lastErrorTool: string | null = null;
  let lastFix: string | null = null; // tracks most recent error_fix for causal linking

  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;

        if (tool.name === "pane_remember") continue;

        // CLI tools: Edit, Write | HTTP tools: write_file, replace
        if (
          tool.name === "Edit" ||
          tool.name === "Write" ||
          tool.name === "write_file" ||
          tool.name === "replace"
        ) {
          const filePath =
            (tool.input.file_path as string) ||
            (tool.input.path as string) ||
            (tool.input.target_file as string) ||
            "unknown";
          events.push({
            type: "file_edit",
            content: `${tool.name}: ${filePath}`,
            timestamp: now,
            source: "auto",
            metadata: { file: filePath, tool: tool.name },
          });
        }
        // CLI tools: Bash | HTTP tools: run_shell_command
        if (tool.name === "Bash" || tool.name === "run_shell_command") {
          const cmd = (tool.input.command as string) || "";
          if (cmd) {
            events.push({
              type: "command",
              content: cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd,
              timestamp: now,
              source: "auto",
              metadata: { tool: tool.name },
            });
          }
        }

        if (lastError && lastErrorTool && tool.name === lastErrorTool) {
          const fixContent = `Fixed: ${lastError.slice(0, 150)}`;
          events.push({
            type: "error_fix",
            content: fixContent,
            timestamp: now,
            source: "auto",
            metadata: { original_error: lastError.slice(0, 200) },
          });
          lastFix = fixContent; // track for causal linking to subsequent decisions
          lastError = null;
          lastErrorTool = null;
        }
      }
      if (
        block.type === "tool_result" &&
        (block as { is_error?: boolean }).is_error
      ) {
        const content = (block as { content: string }).content || "";
        if (content.length < 500) {
          events.push({
            type: "error",
            content: content.slice(0, 300),
            timestamp: now,
            source: "auto",
          });
          lastError = content.slice(0, 300);
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          if (toolUseId) {
            for (const m of turnMessages) {
              for (const b of m.content) {
                if (
                  b.type === "tool_use" &&
                  (b as ToolUseBlock).id === toolUseId
                ) {
                  lastErrorTool = (b as ToolUseBlock).name;
                }
              }
            }
          }
        }
      }
    }
  }

  const decisionPatterns = [
    /(?:I'll|I will|Let's|Going to|chose|choosing|decided|using|switched to)\s+(.{10,150})/gi,
    /(?:instead of|rather than|over)\s+(.{10,100})/gi,
  ];

  const lessonPatterns = [
    /(?:the (?:issue|problem|bug|root cause) (?:was|is)[:\s]+)(.{10,200})/gi,
    /(?:the (?:key )?(?:insight|fix|solution|answer) (?:was|is)[:\s]+)(.{10,200})/gi,
    /(?:(?:discovered|realized|found out|learned|turns out)[:\s]+)(.{10,200})/gi,
    /(?:important(?:ly)?[:\s]+|note[:\s]+)(.{10,200})/gi,
    /(?:the reason (?:is|was)[:\s]+)(.{10,200})/gi,
  ];

  const lastAssistant = [...turnMessages]
    .reverse()
    .find((m) => m.type === "assistant");
  if (lastAssistant) {
    const textBlocks = lastAssistant.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      const fullText = textBlocks
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
        .trim();

      // Extract decisions (cap 5)
      const seenDecisions = new Set<string>();
      for (const pattern of decisionPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(fullText)) !== null) {
          const decision = match[1]?.trim();
          if (
            decision &&
            decision.length >= 10 &&
            !seenDecisions.has(decision)
          ) {
            seenDecisions.add(decision);
            events.push({
              type: "decision",
              content:
                decision.length > 150
                  ? decision.slice(0, 150) + "..."
                  : decision,
              timestamp: now,
              source: "auto",
              // Causal link: if a fix preceded this decision, tag it so the
              // brain can create a "led-to" edge from the fix node → this node
              ...(lastFix ? { metadata: { preceded_by_fix: lastFix.slice(0, 120) } } : {}),
            });
            lastFix = null; // one fix → one decision; consume it
          }
          if (seenDecisions.size >= 5) break;
        }
        if (seenDecisions.size >= 5) break;
      }

      // Extract lessons (cap 3)
      const seenLessons = new Set<string>();
      for (const pattern of lessonPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(fullText)) !== null) {
          const lesson = match[1]?.trim();
          if (
            lesson &&
            lesson.length >= 10 &&
            !seenLessons.has(lesson.slice(0, 40).toLowerCase())
          ) {
            seenLessons.add(lesson.slice(0, 40).toLowerCase());
            events.push({
              type: "lesson",
              content:
                lesson.length > 200
                  ? lesson.slice(0, 200) + "..."
                  : lesson,
              timestamp: now,
              source: "auto",
            });
          }
          if (seenLessons.size >= 3) break;
        }
        if (seenLessons.size >= 3) break;
      }

      if (fullText.length > 20) {
        events.push({
          type: "summary",
          content:
            fullText.length > 500 ? fullText.slice(0, 500) + "..." : fullText,
          timestamp: now,
          source: "auto",
        });
      }
    }
  }

  // Deduplicate events by type:content key (keep first occurrence)
  const seenKeys = new Set<string>();
  const deduped = events.filter((event) => {
    const key = `${event.type}:${event.content}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  return deduped;
}

/**
 * Record file changes from tool_use blocks into the change history.
 * Works for both CLI tools (Edit, Write) and HTTP tools (replace, write_file).
 * Called after each conversation turn completes.
 */
function recordChangeHistory(
  projectId: string,
  messages: ConversationMessage[],
) {
  // Find the last user message to scope to this turn only
  let turnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === "user") {
      turnStart = i;
      break;
    }
  }
  const turnMessages = messages.slice(turnStart);

  // Build a set of tool_use IDs that errored, so we skip them
  const erroredToolIds = new Set<string>();
  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (
        block.type === "tool_result" &&
        (block as { is_error?: boolean }).is_error
      ) {
        const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
        if (toolUseId) erroredToolIds.add(toolUseId);
      }
    }
  }

  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const tool = block as ToolUseBlock;

      // Skip tools that errored
      if (erroredToolIds.has(tool.id)) continue;

      const filePath =
        (tool.input.file_path as string) ||
        (tool.input.path as string) ||
        (tool.input.target_file as string) ||
        "";
      if (!filePath) continue;

      // replace / Edit — have old_string and new_string
      if (
        tool.name === "replace" ||
        tool.name === "Edit"
      ) {
        const oldString = (tool.input.old_string as string) || "";
        const newString = (tool.input.new_string as string) || "";
        if (oldString || newString) {
          recordChange(projectId, filePath, oldString, newString).catch(
            () => {},
          );
        }
      }

      // write_file / Write — full file content
      if (
        tool.name === "write_file" ||
        tool.name === "Write"
      ) {
        const content = (tool.input.content as string) || "";
        if (content) {
          recordChange(projectId, filePath, "", content).catch(() => {});
        }
      }
    }
  }
}

function extractSessionDelta(
  messages: ConversationMessage[],
  todos: Todo[],
) {
  const now = Date.now();
  const workingSet: { path: string; purpose?: string }[] = [];
  const decisions: { content: string }[] = [];
  const recentActions: { type: string; content: string; timestamp: number }[] =
    [];

  let turnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === "user") {
      turnStart = i;
      break;
    }
  }
  const turnMessages = messages.slice(turnStart);

  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;
        // CLI tools: Edit, Write, Read | HTTP tools: write_file, replace, read_file
        if (
          tool.name === "Edit" ||
          tool.name === "Write" ||
          tool.name === "Read" ||
          tool.name === "write_file" ||
          tool.name === "replace" ||
          tool.name === "read_file"
        ) {
          const filePath =
            (tool.input.file_path as string) ||
            (tool.input.path as string) ||
            (tool.input.target_file as string) ||
            "";
          if (filePath) {
            workingSet.push({ path: filePath });
            
            // Only push to recentActions if it's a read action (not recorded in SQLite change_history)
            // or if it's an action we want to track ephemerally in the turn.
            if (tool.name === "Read" || tool.name === "read_file") {
              recentActions.push({
                type: tool.name.toLowerCase(),
                content: filePath,
                timestamp: now,
              });
            }
          }
        }
        // CLI tools: Bash | HTTP tools: run_shell_command
        if (tool.name === "Bash" || tool.name === "run_shell_command") {
          const cmd = (tool.input.command as string) || "";
          if (cmd)
            recentActions.push({
              type: "command",
              content: cmd.slice(0, 120),
              timestamp: now,
            });
        }
      }
    }
  }

  const lastAssistant = [...turnMessages]
    .reverse()
    .find((m) => m.type === "assistant");
  if (lastAssistant) {
    const text = lastAssistant.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    // Decision extraction (cap 5)
    const decisionPatterns = [
      /(?:I'll|I will|We'll|Let's|Going to|chose|choosing|decided|using|switched to)\s+(.{15,120})/gi,
      /(?:instead of|rather than|over)\s+(.{15,100})/gi,
    ];
    const seen = new Set<string>();
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const d = match[1]?.trim();
        if (d && d.length >= 15 && !seen.has(d.slice(0, 40).toLowerCase())) {
          seen.add(d.slice(0, 40).toLowerCase());
          decisions.push({
            content: d.length > 120 ? d.slice(0, 120) + "..." : d,
          });
          if (seen.size >= 5) break;
        }
      }
      if (seen.size >= 5) break;
    }

    // Lesson extraction → pushed as decisions so they appear in session state immediately
    const lessonPatterns = [
      /(?:the (?:issue|problem|bug|root cause) (?:was|is)[:\s]+)(.{10,150})/gi,
      /(?:the (?:key )?(?:insight|fix|solution) (?:was|is)[:\s]+)(.{10,150})/gi,
      /(?:(?:discovered|realized|found out|learned|turns out)[:\s]+)(.{10,150})/gi,
      /(?:the reason (?:is|was)[:\s]+)(.{10,150})/gi,
    ];
    const seenLessons = new Set<string>();
    for (const pattern of lessonPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const l = match[1]?.trim();
        if (l && l.length >= 10 && !seenLessons.has(l.slice(0, 40).toLowerCase())) {
          seenLessons.add(l.slice(0, 40).toLowerCase());
          decisions.push({
            content: l.length > 150 ? l.slice(0, 150) + "..." : l,
          });
          if (seenLessons.size >= 3) break;
        }
      }
      if (seenLessons.size >= 3) break;
    }
  }

  if (
    !workingSet.length &&
    !decisions.length &&
    !recentActions.length &&
    !todos?.length
  )
    return null;
  return { workingSet, decisions, recentActions, todos: todos || [] };
}

/**
 * Post-turn method compliance check.
 * Compares what the model did against what it was scoped to do.
 */
function extractMethodViolations(
  messages: ConversationMessage[],
): { type: string; content: string; timestamp: number }[] {
  const violations: { type: string; content: string; timestamp: number }[] = [];
  const now = Date.now();

  // Find last turn
  let turnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === "user") {
      turnStart = i;
      break;
    }
  }
  const turnMessages = messages.slice(turnStart);

  // Track what happened: edits and verification commands
  let hasEdits = false;
  let hasVerification = false;

  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;

        // File edits (CLI + HTTP tool names)
        if (
          tool.name === "Edit" ||
          tool.name === "Write" ||
          tool.name === "write_file" ||
          tool.name === "replace"
        ) {
          hasEdits = true;
        }

        // Verification commands
        if (tool.name === "Bash" || tool.name === "run_shell_command") {
          const cmd = ((tool.input.command as string) || "").toLowerCase();
          if (
            cmd.includes("test") ||
            cmd.includes("tsc") ||
            cmd.includes("typecheck") ||
            cmd.includes("build") ||
            cmd.includes("lint") ||
            cmd.includes("check") ||
            cmd.includes("jest") ||
            cmd.includes("vitest") ||
            cmd.includes("pytest") ||
            cmd.includes("cargo check") ||
            cmd.includes("go vet")
          ) {
            hasVerification = true;
          }
        }
      }
    }
  }

  // Edits happened but no verification — flag it
  if (hasEdits && !hasVerification) {
    violations.push({
      type: "no_verification",
      content:
        "Code was changed but no verification (tests, type-check, build) was run. Follow the Pane Method step 6 — verify after every change.",
      timestamp: now,
    });
  }

  return violations;
}

export function usePunk(projectId: string) {
  const abortingRef = useRef(false);
  // Set to true when sendMessage aborts an in-flight session to replace it with a new one.
  // Prevents the old processEnded from calling finishProcessing (which would set isProcessing=false)
  // and from nulling the session ID — the new message needs both intact.
  const intentionalAbortRef = useRef(false);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const store = useProjectsStore.getState();
      const project = store.projects.get(projectId);
      if (!project) return;

      // If already processing, abort the current generation and immediately replace it.
      // Mark intentionalAbort so the old processEnded skips finishProcessing/session-null.
      // UI stays on isProcessing=true the whole time — user sees no interruption.
      if (project.conversation.isProcessing) {
        intentionalAbortRef.current = true;
        await abortPunk(projectId).catch(() => {});
        resetStreamingState(projectId, true); // flush = true to capture partial response
        const s = useProjectsStore.getState();
        s.setLastMessageStreamingDone(projectId);
        s.setIsPlanning(projectId, false);
      } else {
        await abortPunk(projectId).catch(() => {});
        resetStreamingState(projectId);
      }

      const messageId = nextMessageId();
      const userMessage: ConversationMessage = {
        id: messageId,
        type: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
        isStreaming: false,
      };

      try {
        const cpResult = await Promise.race([
          createCheckpoint(projectId, project.root, messageId),
          new Promise<{ id: null; fileCount: 0 }>((resolve) =>
            setTimeout(() => resolve({ id: null, fileCount: 0 }), CHECKPOINT_TIMEOUT_MS),
          ),
        ]);
        if (cpResult.id) {
          userMessage.checkpointId = cpResult.id;
          store.addCheckpoint(projectId, {
            id: cpResult.id,
            timestamp: cpResult.timestamp ?? Date.now(),
            messageId,
            fileCount: cpResult.fileCount,
          });
        }
      } catch {
        // ignore
      }

      store.addConversationMessage(projectId, userMessage);
      store.setConversationProcessing(projectId, true);
      store.setConversationError(projectId, null);

      let assistantMessageAdded = false;
      let resultReceived = false;
      let resultSafetyTimer: ReturnType<typeof setTimeout> | null = null;
      let orchestrationActive = false; // true while TaskRunner is running steps

      const finishProcessing = () => {
        if (resultSafetyTimer) {
          clearTimeout(resultSafetyTimer);
          resultSafetyTimer = null;
        }
        abortPunk(projectId).catch(() => {});

        const s = useProjectsStore.getState();
        s.setConversationProcessing(projectId, false);
        s.setConversationRoutedModel(projectId, null);
        s.setLastMessageStreamingDone(projectId);
        s.setIsPlanning(projectId, false);

        setTimeout(() => {
          const current = useProjectsStore.getState().projects.get(projectId);
          if (current && !current.conversation.isProcessing) {
            useProjectsStore
              .getState()
              .setConversationStatusMessage(projectId, null);
          }
        }, 1500);

        useWorkspaceStore.getState().playCompletionSound();

        if (s.activeProjectId !== projectId) {
          const proj = s.projects.get(projectId);
          if (proj) {
            s.setHasUnreadCompletion(projectId, true);
            const evt = new CustomEvent("pane:task-complete", {
              detail: { projectId, projectName: proj.name },
            });
            window.dispatchEvent(evt);
          }
        }
      };

      const handleEvent = (event: PunkStreamEvent) => {
        if (resultSafetyTimer) {
          clearTimeout(resultSafetyTimer);
          resultSafetyTimer = setTimeout(() => {
            console.warn(
              `[pane] resultSafetyTimer triggered — model stream went silent for ${MODEL_SAFETY_TIMEOUT_MS / 1000} seconds`,
            );
            finishProcessing();
          }, MODEL_SAFETY_TIMEOUT_MS);
        }

        switch (event.event) {
          case "processStarted":
            break;

          case "sdk_init_info": {
            const { models, account } = event.data;
            useWorkspaceStore.getState().setSdkInfo(models, account);
            break;
          }

          case "rate_limit": {
            useWorkspaceStore.getState().setRateLimitInfo(event.data);
            break;
          }

          case "routing": {
            // Legacy routing event — still handled for backwards compat
            const { model, thinking, intent } = event.data;
            store.setConversationRoutedModel(projectId, model);
            if (thinking && intent === "plan") {
              store.setIsPlanning(projectId, true);
            }
            break;
          }

          case "strategy": {
            const d = event.data;
            // Update routing display (same as routing event)
            store.setConversationRoutedModel(projectId, d.model);
            if (d.thinking && d.intent === "plan") {
              store.setIsPlanning(projectId, true);
            }
            // Inject a synthetic assistant message containing the strategy block.
            // Appears between the user message and the LLM's response —
            // collapsed by default in the UI.
            store.addConversationMessage(projectId, {
              id: `strategy-${Date.now()}`,
              type: "assistant",
              content: [{
                type: "strategy",
                mode:             d.mode,
                discovery:        d.discovery,
                reasoning:        d.reasoning,
                verification:     d.verification,
                confidence:       d.confidence,
                reason:           d.reason,
                signals:          d.signals,
                intent:           d.intent,
                provider:         d.provider,
                model:            d.model,
                thinking:         d.thinking,
                classifierRouted:     d.classifierRouted     ?? false,
                classifierConfidence: d.classifierConfidence ?? null,
                classifierExploring:  d.classifierExploring  ?? false,
                localTaskType:    d.localTaskType    ?? null,
                localComplexity:  d.localComplexity  ?? null,
                localAtomHints:   d.localAtomHints   ?? [],
                escalationLevel:  d.escalationLevel  ?? 0,
                struggleCount:    d.struggleCount    ?? 0,
              }],
              timestamp: Date.now(),
              isStreaming: false,
            });
            break;
          }

          case "message": {
            try {
              const msg: PunkStreamMessage =
                event.data.parsed ?? JSON.parse(event.data.raw_json!);
              assistantMessageAdded = handlePunkMessage(
                msg,
                projectId,
                assistantMessageAdded,
              );

              if (msg.type === "result") resultReceived = true;
              if (msg.type === "result" && !resultSafetyTimer) {
                resultSafetyTimer = setTimeout(() => {
                  console.warn(
                    `[pane] Process hung after result message for ${RESULT_PROCESSING_TIMEOUT_MS / 1000} seconds — force-clearing processing state`,
                  );
                  finishProcessing();
                }, RESULT_PROCESSING_TIMEOUT_MS);
              }
            } catch (e) {
              console.error("Failed to parse claude message:", e);
            }
            break;
          }

          case "processEnded": {
            // During orchestration the TaskRunner spawns one process per step.
            // Each step exit fires processEnded — ignore these mid-plan or we'd
            // mark the conversation done and show spurious errors after step 1.
            if (orchestrationActive) break;

            // This processEnded belongs to a session that was intentionally aborted
            // to make way for a new message. Skip all cleanup — isProcessing stays
            // true, session ID stays intact, new message is already in flight.
            if (intentionalAbortRef.current) {
              intentionalAbortRef.current = false;
              break;
            }

            // If the process died without ever sending a result event, surface an error
            if (!resultReceived) {
              const s = useProjectsStore.getState();
              if (!s.projects.get(projectId)?.conversation.error) {
                s.setConversationError(
                  projectId,
                  "Process exited without responding — session may be invalid. Try again.",
                );
              }
            }
            finishProcessing();

            try {
              const proj = useProjectsStore.getState().projects.get(projectId);
              if (proj && proj.conversation.messages.length > 1) {
                // Record file changes to change history
                recordChangeHistory(projectId, proj.conversation.messages);

                // LLM preference extraction — build a concise text of the last
                // user message + assistant response for the model to analyse.
                // Fire-and-forget: never blocks the UI.
                try {
                  const msgs = proj.conversation.messages;
                  let turnStart = msgs.length - 1;
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i]!.type === "user") { turnStart = i; break; }
                  }
                  const turnMsgs = msgs.slice(turnStart, turnStart + 4); // user + up to 3 assistant blocks
                  const turnLines: string[] = [];
                  for (const m of turnMsgs) {
                    const role = m.type === "user" ? "Developer" : "Assistant";
                    for (const b of m.content) {
                      if (b.type === "text") {
                        turnLines.push(`${role}: ${(b as { text: string }).text.slice(0, 600)}`);
                      }
                    }
                  }
                  const turnText = turnLines.join("\n\n");
                  if (turnText.length > 100) {
                    extractPreferencesFromTurn(turnText).catch(() => {});
                  }
                } catch {
                  // non-critical
                }

                const memEvents = extractMemoryEvents(
                  proj.conversation.messages,
                );
                if (memEvents.length > 0) {
                  recordMemoryEvents(projectId, memEvents).catch(() => {});
                  brainIndexEvents(projectId, memEvents).catch(() => {});
                }
                generateBrief(projectId)
                  .then((brief) => {
                    if (brief) {
                      useProjectsStore
                        .getState()
                        .setCachedBrief(projectId, brief);
                    }
                  })
                  .catch(() => {});

                const sessionDelta = extractSessionDelta(
                  proj.conversation.messages,
                  proj.conversation.todos,
                );

                // Post-turn method compliance check
                const methodViolations = extractMethodViolations(
                  proj.conversation.messages,
                );

                if (sessionDelta) {
                  sessionMergeState(projectId, {
                    ...sessionDelta,
                    methodNotes: methodViolations,
                  }).catch(() => {});
                } else if (methodViolations.length > 0) {
                  sessionMergeState(projectId, {
                    methodNotes: methodViolations,
                  }).catch(() => {});
                }
              }
            } catch {
              // ignore
            }
            break;
          }

          case "status": {
            // Transient status from the backend (e.g. "rate limited — retrying in 30s").
            // null clears it. Does not affect isProcessing.
            store.setConversationStatusMessage(projectId, event.data?.message ?? null);
            break;
          }

          case "error": {
            const s = useProjectsStore.getState();
            s.setConversationError(projectId, event.data.message);
            s.setConversationProcessing(projectId, false);
            s.setIsPlanning(projectId, false);

            // RETRY LOGIC: Restore the failed prompt to the InputBar
            // We use a custom event that InputBar listens to
            const retryEvt = new CustomEvent("pane:retry-prompt", {
              detail: { projectId, prompt },
            });
            window.dispatchEvent(retryEvt);

            // Also remove the failed user message from the history so it's not doubled on retry
            const project = s.projects.get(projectId);
            if (project) {
              const msgs = project.conversation.messages;
              const lastMsg = msgs[msgs.length - 1];
              if (msgs.length > 0 && lastMsg && lastMsg.type === "user") {
                s.removeLastConversationMessage(projectId);
              }
            }
            break;
          }

          case "compaction_start": {
            console.log(
              `[frontend] Starting conversation compaction: ${event.data.reason}`,
            );
            // Optional: Show a brief indicator in the UI
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(
              projectId,
              `Compressing conversation...`,
            );
            break;
          }

          case "compaction_complete": {
            const { originalCount, compactedCount, tokensSaved, totalCompactions } = event.data;
            console.log(
              `[frontend] Compaction complete: ${originalCount} → ${compactedCount} messages, ` +
              `${tokensSaved} tokens saved, total compactions: ${totalCompactions}`,
            );
            // Clear the compaction status message
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(projectId, null);
            break;
          }

          case "todos_updated": {
            const { todos } = event.data;
            const s = useProjectsStore.getState();
            s.setConversationTodos(projectId, todos);
            break;
          }

          case "activeTask_updated": {
            const { activeTask } = event.data;
            // Update the status message with the active task
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(projectId, activeTask.description);
            break;
          }

          // ── Orchestration Events (Control Inversion) ──────────────────
          case "orchestration_phase": {
            const { phase, model, provider } = event.data;
            const s = useProjectsStore.getState();
            s.setConversationPhase(projectId, phase);
            const label =
              phase === "discovery" ? "Understanding the task..."
              : phase === "planning" ? `Planning with ${model || provider || "model"}...`
              : phase === "executing" ? `Executing with ${model || provider || "model"}...`
              : phase === "validating" ? "Verifying plan..."
              : phase === "replanning" ? "Revising plan..."
              : "Executing...";
            s.setConversationStatusMessage(projectId, label);
            // Execution phase: the execution model's processEnded is the real terminal event.
            if (phase === "executing") orchestrationActive = false;
            break;
          }

          case "orchestration_start": {
            orchestrationActive = true;
            break;
          }

          case "orchestration_planning_start": {
            // Planning model's messages stream through as regular conversation events.
            // No placeholder needed — user sees tool calls and text directly.
            useProjectsStore.getState().setConversationStatusMessage(projectId, "Planning...");
            break;
          }

          case "orchestration_step": {
            const { phase, stepIndex, totalSteps, message } = event.data;
            console.log(`[orchestration] ${phase}: ${message}`);
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(
              projectId,
              `Step ${stepIndex || "?"}/${totalSteps || "?"}: ${message}`,
            );
            // Mark the proportional task as in_progress when a step starts executing.
            // Tasks are fewer than steps — map by ratio so the active indicator tracks correctly.
            if (phase === "executing" && stepIndex && totalSteps) {
              const proj = s.projects.get(projectId);
              if (proj?.conversation.todos?.length) {
                const numTasks = proj.conversation.todos.length;
                const activeTask = Math.floor((stepIndex - 1) / totalSteps * numTasks);
                s.setConversationTodos(projectId, proj.conversation.todos.map(
                  (todo: Todo, idx: number) => ({
                    ...todo,
                    status: idx < activeTask
                      ? "completed" as const
                      : idx === activeTask
                        ? "in_progress" as const
                        : "pending" as const,
                  })
                ));
              }
            }
            break;
          }

          case "orchestration_step_complete": {
            const { stepIndex, totalSteps, passed, action } = event.data;
            console.log(
              `[orchestration] Step ${stepIndex}/${totalSteps} ${passed ? "passed" : "failed"}: ${action}`,
            );
            // Update todos using proportional mapping — tasks are fewer than steps.
            const s = useProjectsStore.getState();
            const proj = s.projects.get(projectId);
            if (proj?.conversation.todos) {
              const numTasks = proj.conversation.todos.length;
              const completedTasks = Math.floor(stepIndex / totalSteps * numTasks);
              const updatedTodos = proj.conversation.todos.map(
                (todo: Todo, idx: number) => ({
                  ...todo,
                  status: idx < completedTasks
                    ? "completed" as const
                    : idx === completedTasks
                      ? "in_progress" as const
                      : "pending" as const,
                }),
              );
              s.setConversationTodos(projectId, updatedTodos);
            }
            break;
          }

          case "orchestration_complete": {
            orchestrationActive = false;
            useProjectsStore.getState().setConversationPhase(projectId, "idle");
            const {
              summary,
              completedSteps,
              totalSteps: total,
              allPassed,
              typeCheckPassed,
              touchedFiles,
            } = event.data;
            console.log(
              `[orchestration] Complete: ${completedSteps}/${total} steps passed` +
              ` | tsc: ${typeCheckPassed ? "✓" : "✗"}` +
              ` | touched: ${touchedFiles?.length ?? 0} files (${summary})`,
            );
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(
              projectId,
              allPassed && typeCheckPassed
                ? `All ${total} steps completed`
                : !typeCheckPassed
                  ? `${completedSteps}/${total} steps — type check failed`
                  : `${completedSteps}/${total} steps completed`,
            );
            resultReceived = true;
            finishProcessing();

            // Record file changes from orchestration steps
            try {
              const proj = useProjectsStore.getState().projects.get(projectId);
              if (proj && proj.conversation.messages.length > 1) {
                recordChangeHistory(projectId, proj.conversation.messages);
              }
            } catch {}
            break;
          }

          case "orchestration_typecheck": {
            const { passed, output } = event.data;
            console.log(
              `[orchestration] Type check: ${passed ? "passed ✓" : "failed ✗"}`,
              passed ? "" : output,
            );
            const s = useProjectsStore.getState();
            s.setConversationStatusMessage(
              projectId,
              passed
                ? "Type check passed ✓"
                : `Type check failed — ${output.slice(0, 80)}`,
            );
            break;
          }

          case "orchestration_error": {
            orchestrationActive = false;
            useProjectsStore.getState().setConversationPhase(projectId, "idle");
            console.error(`[orchestration] Error: ${event.data.message}`);
            const s = useProjectsStore.getState();
            // Clean up planning-stream if it's still present (e.g. CLI plan parse failure)
            const errProj = s.projects.get(projectId);
            const planStream = errProj?.conversation.messages.find((m) => m.id === "planning-stream");
            if (planStream) s.removeConversationMessageById(projectId, "planning-stream");
            s.setConversationError(projectId, event.data.message);
            finishProcessing();

            // Record any changes made before the error
            try {
              const proj = useProjectsStore.getState().projects.get(projectId);
              if (proj && proj.conversation.messages.length > 1) {
                recordChangeHistory(projectId, proj.conversation.messages);
              }
            } catch {}
            break;
          }
        }
      };

      try {
        const conversation = project.conversation;
        const intent: AgentIntent = inferAgentIntent({ prompt, conversation });

        const activeFile = project.activeFilePath || undefined;
        await Promise.race([
          brainContextualSearch(
            projectId,
            prompt,
            activeFile,
            intent,
            project.root,
          ).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1000)), // Increased from 500ms to 1 second
        ]);
        const ws = useWorkspaceStore.getState();
        const selectedModel = ws.selectedModel;
        const selectedModelThinking = ws.selectedModelThinking;
        const selectedModelProvider = ws.selectedModelProvider;
        const intentAutoRoute = ws.intentAutoRoute;
        const routedModel = chooseModelForIntent(selectedModel, intent);

        const truncatedHistory = conversation.messages.slice(-20);
        const todos = conversation.todos;

        await sendToPunk(
          projectId,
          prompt,
          project.root,
          routedModel,
          handleEvent,
          intent,
          truncatedHistory,
          selectedModelThinking,
          selectedModelProvider,
          todos,
          intentAutoRoute,
        );
      } catch (err) {
        console.error("[pane] sendToPunk error:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        store.setConversationError(projectId, errMsg);
        store.setConversationProcessing(projectId, false);
      }
    },
    [projectId],
  );

  const abortMessage = useCallback(async () => {
    if (abortingRef.current) return;
    abortingRef.current = true;
    try {
      await abortPunk(projectId);
    } finally {
      abortingRef.current = false;
      const store = useProjectsStore.getState();
      store.setConversationProcessing(projectId, false);
      store.setLastMessageStreamingDone(projectId);
      store.setIsPlanning(projectId, false);
      resetStreamingState(projectId);
    }
  }, [projectId]);

  const clearConversation = useCallback(() => {
    // Promote session state to long-term memory before wiping it.
    // Decisions, method violations, and high-touch file patterns die on clear
    // otherwise — this bridges the session layer → brain layer.
    sessionReadState(projectId)
      .then((state) => {
        if (!state) return;
        const now = Date.now();
        const events: MemoryEvent[] = [];

        // Decisions accumulated this session
        for (const d of state.decisions || []) {
          if (d.content && d.content.length >= 10) {
            events.push({
              type: "decision",
              content: d.content.slice(0, 200),
              timestamp: (d as { content: string; timestamp?: number }).timestamp ?? now,
              source: "auto",
            });
          }
        }

        // Top-touch working set files → pattern node
        const topFiles = (state.workingSet || [])
          .filter((f) => (f.touches ?? 0) >= 2)
          .sort((a, b) => (b.touches ?? 0) - (a.touches ?? 0))
          .slice(0, 3)
          .map((f) => f.path);
        if (topFiles.length > 0) {
          events.push({
            type: "pattern",
            content: `Frequently edited together: ${topFiles.join(", ")}`,
            timestamp: now,
            source: "auto",
            metadata: { files: topFiles.join(",") },
          });
        }

        if (events.length > 0) {
          recordMemoryEvents(projectId, events).catch(() => {});
          brainIndexEvents(projectId, events).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        // Clear regardless of promotion success
        sessionClearState(projectId).catch(() => {});
      });

    useProjectsStore.getState().clearConversation(projectId);
    useProjectsStore.getState().clearCheckpoints(projectId);
    deleteProjectCheckpoints(projectId).catch(() => {});
    brainClearSessionPins(projectId).catch(() => {});
    // sessionClearState is now called inside the finally above
  }, [projectId]);

  return { sendMessage, abortMessage, clearConversation };
}

function handlePunkMessage(
  msg: PunkStreamMessage,
  projectId: string,
  assistantMessageExists: boolean,
): boolean {
  const store = useProjectsStore.getState();
  const state = getStreamingState(projectId);

  if (msg.type !== "stream_event") {
    resetStreamingState(projectId, true);
  }

  if ("skipped" in msg) {
    return assistantMessageExists;
  }

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) {
        if (msg.model) {
          store.setConversationModel(projectId, msg.model);
        }
      }
      return assistantMessageExists;
    }

    case "assistant": {
      const rawContent = msg.message.content as ContentBlock[];
      const seenToolIds = new Set<string>();
      const finalContent = rawContent.filter((block) => {
        if (block.type === "tool_use") {
          const id = (block as ToolUseBlock).id;
          if (seenToolIds.has(id)) return false;
          seenToolIds.add(id);
        }
        return true;
      });

      if (assistantMessageExists) {
        const project = store.projects.get(projectId);
        if (project) {
          const msgs = project.conversation.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const streamedTextBlocks = last.content.filter(
              (b) => b.type === "text",
            );
            const streamedThinkingBlocks = last.content.filter(
              (b) => b.type === "thinking",
            );
            const finalHasText = finalContent.some((b) => b.type === "text");
            const finalHasThinking = finalContent.some(
              (b) => b.type === "thinking",
            );

            let merged = finalContent;
            if (streamedThinkingBlocks.length > 0 && !finalHasThinking) {
              merged = [...streamedThinkingBlocks, ...merged];
            }
            if (streamedTextBlocks.length > 0 && !finalHasText) {
              const thinkingEnd = merged.findIndex(
                (b) => b.type !== "thinking",
              );
              const insertAt = thinkingEnd === -1 ? merged.length : thinkingEnd;
              merged = [
                ...merged.slice(0, insertAt),
                ...streamedTextBlocks,
                ...merged.slice(insertAt),
              ];
            }
            store.updateLastAssistantContent(projectId, merged);
          } else {
            store.updateLastAssistantContent(projectId, finalContent);
          }
        } else {
          store.updateLastAssistantContent(projectId, finalContent);
        }
        store.setLastMessageStreamingDone(projectId);

        if (project) {
          const todos = project.conversation.todos;
          if (
            todos.length > 0 &&
            todos.every((t) => t.status === "completed")
          ) {
            store.setConversationTodos(projectId, []);
          }
        }
      } else {
        const assistantMsg: ConversationMessage = {
          id: nextMessageId(),
          type: "assistant",
          content: finalContent,
          timestamp: Date.now(),
          isStreaming: false,
        };
        store.addConversationMessage(projectId, assistantMsg);
      }
      return true;
    }

    case "user": {
      const project = store.projects.get(projectId);
      const newContent = msg.message.content as ContentBlock[];
      const newToolResult = newContent.find((b) => b.type === "tool_result") as
        | ToolResultBlock
        | undefined;

      if (project && newToolResult) {
        const msgs = project.conversation.messages;
        // Search backwards for a matching system message with this tool_use_id
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!;
          if (m.type === "system") {
            const hasMatch = m.content.some(
              (b) =>
                b.type === "tool_result" &&
                (b as ToolResultBlock).tool_use_id ===
                  newToolResult.tool_use_id,
            );
            if (hasMatch) {
              store.updateMessageContent(projectId, m.id, newContent);
              return false;
            }
          }
          // Optimization: don't look too far back
          if (msgs.length - i > 15) break;
        }
      }

      const toolResultMsg: ConversationMessage = {
        id: nextMessageId(),
        type: "system",
        content: newContent,
        timestamp: Date.now(),
        isStreaming: false,
      };
      store.addConversationMessage(projectId, toolResultMsg);
      return false;
    }

    case "result": {
      if (msg.subtype === "success" && msg.total_cost_usd !== undefined) {
        store.setLastAssistantMeta(
          projectId,
          msg.total_cost_usd,
          msg.duration_ms ?? 0,
          msg.usage?.input_tokens,
          msg.usage?.output_tokens,
          msg.num_turns,
        );

        if (msg.usage?.input_tokens) {
          const model =
            store.projects.get(projectId)?.conversation.model ?? null;
          const limit = getContextLimit(model);
          const ratio = msg.usage.input_tokens / limit;
          const pressure =
            ratio >= 0.85 ? "high" : ratio >= 0.7 ? "building" : "none";
          store.setContextPressure(projectId, msg.usage.input_tokens, pressure);
        }

      } else if (msg.subtype !== "success") {
        if (msg.subtype === "interrupted") return assistantMessageExists;

        console.warn("[pane] Claude non-success result:", msg.subtype, msg);

        const existing = store.projects.get(projectId)?.conversation.error;
        if (!existing) {
          const detail =
            msg.subtype === "error_max_turns"
              ? "Reached max turns — send a message to continue"
              : msg.error?.trim() || msg.result?.trim();
          store.setConversationError(
            projectId,
            detail ||
              `Claude exited unexpectedly (${msg.subtype ?? "unknown"})`,
          );
        }
      }
      return assistantMessageExists;
    }

    case "stream_event": {
      const evt = msg.event;

      if (evt.type === "content_block_start") {
        if (state.pendingTextDelta) {
          cancelAnimationFrame(state.textFlushRaf);
          flushTextDelta(projectId);
        }
        if (state.pendingThinkingDelta) {
          cancelAnimationFrame(state.thinkingFlushRaf);
          flushThinkingDelta(projectId);
        }
        if (state.pendingToolInput) {
          cancelAnimationFrame(state.toolInputFlushRaf);
          flushToolInput(projectId);
        }
        if (state.pendingTodos) {
          cancelAnimationFrame(state.todosFlushRaf);
          flushTodos(projectId);
        }
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.text
      ) {
        store.setConversationStatusMessage(projectId, null);

        if (!assistantMessageExists) {
          const placeholder: ConversationMessage = {
            id: nextMessageId(),
            type: "assistant",
            content: [{ type: "text", text: evt.delta.text }],
            timestamp: Date.now(),
            isStreaming: true,
          };
          store.addConversationMessage(projectId, placeholder);
          return true;
        } else {
          state.pendingTextDelta += evt.delta.text;
          if (!state.textFlushRaf) {
            state.textFlushRaf = requestAnimationFrame(() =>
              flushTextDelta(projectId),
            );
          }
          return true;
        }
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "thinking_delta" &&
        evt.delta.thinking
      ) {
        store.setConversationStatusMessage(projectId, "thinking...");
        if (!assistantMessageExists) {
          const placeholder: ConversationMessage = {
            id: nextMessageId(),
            type: "assistant",
            content: [{ type: "thinking", thinking: evt.delta.thinking }],
            timestamp: Date.now(),
            isStreaming: true,
          };
          store.addConversationMessage(projectId, placeholder);
          return true;
        } else {
          // Ensure there's a thinking block to append to
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const blocks = [...last.content];
              const lastBlock = blocks[blocks.length - 1];
              if (!lastBlock || lastBlock.type !== "thinking") {
                // Add a new thinking block if the last block isn't thinking
                blocks.push({ type: "thinking", thinking: "" });
                store.updateLastAssistantContent(projectId, blocks);
              }
            }
          }
          
          state.pendingThinkingDelta += evt.delta.thinking;
          if (!state.thinkingFlushRaf) {
            state.thinkingFlushRaf = requestAnimationFrame(() =>
              flushThinkingDelta(projectId),
            );
          }
          return true;
        }
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.signature
      ) {
        if (assistantMessageExists) {
          store.setLastThinkingSignature(projectId, evt.delta.signature);
        }
        return assistantMessageExists;
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "thinking"
      ) {
        if (!assistantMessageExists) {
          const placeholder: ConversationMessage = {
            id: nextMessageId(),
            type: "assistant",
            content: [evt.content_block as ThinkingBlock],
            timestamp: Date.now(),
            isStreaming: true,
          };
          store.addConversationMessage(projectId, placeholder);
          return true;
        } else {
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const blocks = [...last.content];
              // Check if the last block is already a thinking block
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "thinking") {
                // If so, reuse it instead of creating a new one
                // This prevents multiple thinking blocks from being created
              } else {
                // Only add a new thinking block if the last one isn't already thinking
                blocks.push(evt.content_block as ThinkingBlock);
                store.updateLastAssistantContent(projectId, blocks);
              }
            }
          }
        }
        return assistantMessageExists;
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "tool_use"
      ) {
        // Flush any pending JSON from the previous tool before starting the new one.
        // Without this, the previous tool's rAF gets cancelled and its input is lost.
        if (state.pendingToolJson && !state.pendingToolJsonTruncated) {
          cancelAnimationFrame(state.toolJsonParseRaf);
          state.toolJsonParseRaf = 0;
          const fixed = fixPartialJson(state.pendingToolJson);
          try {
            useProjectsStore
              .getState()
              .updateLastToolUseInput(projectId, JSON.parse(fixed) as Record<string, unknown>);
          } catch { /* ignore */ }
        }
        state.pendingToolJson = "";
        state.pendingToolJsonTruncated = false;
        if (state.toolJsonParseRaf) {
          cancelAnimationFrame(state.toolJsonParseRaf);
          state.toolJsonParseRaf = 0;
        }
        const toolBlock = evt.content_block as ToolUseBlock;
        state.currentStreamingToolId = toolBlock.id;
        state.currentToolDeltaCount = 0;

        let status = `using ${toolBlock.name.toLowerCase()}...`;
        if (toolBlock.name === "read_file" || toolBlock.name === "Read")
          status = "reading file...";
        if (toolBlock.name === "replace" || toolBlock.name === "Edit")
          status = "editing file...";
        if (toolBlock.name === "write_file" || toolBlock.name === "Write")
          status = "writing file...";
        if (toolBlock.name === "grep_search" || toolBlock.name === "Grep")
          status = "searching...";
        if (toolBlock.name === "run_shell_command" || toolBlock.name === "Bash")
          status = "running command...";
        store.setConversationStatusMessage(projectId, status);

        if (!assistantMessageExists) {
          const placeholder: ConversationMessage = {
            id: nextMessageId(),
            type: "assistant",
            content: [toolBlock],
            timestamp: Date.now(),
            isStreaming: true,
          };
          store.addConversationMessage(projectId, placeholder);
        } else {
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const alreadyExists = last.content.some(
                (b) =>
                  b.type === "tool_use" &&
                  (b as ToolUseBlock).id === toolBlock.id,
              );
              if (!alreadyExists) {
                store.updateLastAssistantContent(projectId, [
                  ...last.content,
                  toolBlock,
                ]);
              }
            }
          }
        }

        if (toolBlock.name === "EnterPlanMode") {
          store.setIsPlanning(projectId, true);
        }
        if (toolBlock.name === "ExitPlanMode") {
          store.setIsPlanning(projectId, false);
        }

        return true;
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "partial_json_delta" &&
        evt.delta.partial_json
      ) {
        if (state.pendingToolJsonTruncated) return assistantMessageExists;

        state.currentToolDeltaCount++;
        state.pendingToolJson += evt.delta.partial_json;

        // Detect CLI: tool input arrives as one complete JSON in a single delta.
        // HTTP always sends partial chunks, so the first delta won't parse cleanly.
        // When detected, animate the reveal instead of using the rAF pipeline.
        if (state.currentToolDeltaCount === 1 && state.currentStreamingToolId) {
          try {
            const complete = JSON.parse(state.pendingToolJson) as Record<string, unknown>;
            if (Object.keys(complete).length > 0) {
              // Single-shot complete JSON → CLI → animate char-by-char
              streamToolInputAnimate(projectId, state.currentStreamingToolId, complete);
              state.pendingToolJson = "";
              return assistantMessageExists;
            }
          } catch {
            // Partial JSON → HTTP streaming → fall through to scheduleToolJsonParse
          }
        }

        if (state.pendingToolJson.length > MAX_STREAMING_TOOL_JSON_CHARS) {
          state.pendingToolJsonTruncated = true;
          state.pendingToolJson = "";
          state.pendingToolInput = {
            __pane_truncated: true,
            __pane_note:
              "Tool input streaming truncated (too large). Full input may still be available in the final message.",
          };
          if (!state.toolInputFlushRaf) {
            state.toolInputFlushRaf = requestAnimationFrame(() =>
              flushToolInput(projectId),
            );
          }
          return assistantMessageExists;
        }

        scheduleToolJsonParse(projectId);
        return assistantMessageExists;
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "server_tool_use"
      ) {
        if (assistantMessageExists) {
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const newContent = [
                ...last.content,
                evt.content_block as ServerToolUseBlock,
              ];
              store.updateLastAssistantContent(projectId, newContent);
            }
          }
        }
        return assistantMessageExists;
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "web_search_tool_result"
      ) {
        if (assistantMessageExists) {
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const newContent = [
                ...last.content,
                evt.content_block as WebSearchToolResultBlock,
              ];
              store.updateLastAssistantContent(projectId, newContent);
            }
          }
        }
        return assistantMessageExists;
      }

      if (evt.type === "content_block_stop") {
        const project = store.projects.get(projectId);
        if (project) {
          const msgs = project.conversation.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const lastBlock = last.content[last.content.length - 1];
            if (
              lastBlock &&
              (lastBlock.type === "tool_use" ||
                lastBlock.type === "server_tool_use")
            ) {
              store.setConversationStatusMessage(projectId, "thinking...");
            }
          }
        }
        return assistantMessageExists;
      }

      return assistantMessageExists;
    }

    default:
      return assistantMessageExists;
  }
}
