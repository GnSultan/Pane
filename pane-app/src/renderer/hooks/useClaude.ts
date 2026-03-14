import { useCallback, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { useWorkspaceStore } from "../stores/workspace";

import {
  sendToPunk,
  abortPunk,
  createCheckpoint,
  deleteProjectCheckpoints,
  recordMemoryEvents,
  generateBrief,
  brainIndexEvents,
  brainContextualSearch,
  brainClearSessionPins,
  sessionMergeState,
  sessionClearState,
} from "../lib/tauri-commands";
import type {
  PunkStreamEvent as ClaudeStreamEvent,
  PunkStreamMessage as ClaudeStreamMessage,
  PunkConversationMessage as ConversationMessage,
  ContentBlock,
  ToolUseBlock,
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

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

let pendingTextDelta = "";
let pendingThinkingDelta = "";
let textFlushRaf = 0;
let thinkingFlushRaf = 0;
let pendingToolInput: Record<string, unknown> | null = null;
let toolInputFlushRaf = 0;

let pendingJsonDelta = "";
let jsonFlushRaf = 0;
let isStreamingJson = false;

const MAX_STREAMING_TOOL_JSON_CHARS = 100_000;
let toolJsonParseRaf = 0;
let pendingToolJson = "";
let pendingToolJsonTruncated = false;

let pendingTodos: import("../lib/claude-types").Todo[] | null = null;
let todosFlushRaf = 0;

function flushToolInput(projectId: string) {
  if (pendingToolInput) {
    useProjectsStore
      .getState()
      .updateLastToolUseInput(projectId, pendingToolInput);
    pendingToolInput = null;
  }
  toolInputFlushRaf = 0;
}

function flushJsonDelta(projectId: string) {
  if (pendingJsonDelta) {
    const fixed = fixPartialJson(pendingJsonDelta);
    try {
      const parsed = JSON.parse(fixed);
      useProjectsStore
        .getState()
        .updateLastAssistantJson(projectId, parsed, pendingJsonDelta);
    } catch {
      // Still show the raw text if it doesn't parse yet
      useProjectsStore
        .getState()
        .updateLastAssistantJson(projectId, null, pendingJsonDelta);
    }
  }
  jsonFlushRaf = 0;
}

function scheduleToolJsonParse(projectId: string) {
  if (toolJsonParseRaf) return;
  toolJsonParseRaf = requestAnimationFrame(() => {
    toolJsonParseRaf = 0;

    if (pendingToolJsonTruncated) return;
    if (!pendingToolJson) return;

    const fixed = fixPartialJson(pendingToolJson);
    try {
      const parsed = JSON.parse(fixed) as Record<string, unknown>;

      const store = useProjectsStore.getState();
      const project = store.projects.get(projectId);
      if (project) {
        const msgs = project.conversation.messages;
        const last = msgs[msgs.length - 1];
        if (last && last.type === "assistant") {
          const lastTool = [...last.content]
            .reverse()
            .find((b) => b.type === "tool_use") as ToolUseBlock | undefined;
          if (lastTool?.name === "TodoWrite" && (parsed as any).todos) {
            pendingTodos = (
              (parsed as any).todos as import("../lib/claude-types").Todo[]
            ).map((t) => ({ ...t }));
            if (!todosFlushRaf) {
              todosFlushRaf = requestAnimationFrame(() =>
                flushTodos(projectId),
              );
            }
          }
        }
      }

      pendingToolInput = parsed;
      if (!toolInputFlushRaf) {
        toolInputFlushRaf = requestAnimationFrame(() =>
          flushToolInput(projectId),
        );
      }
    } catch {
      // Still incomplete
    }
  });
}

function flushTodos(projectId: string) {
  if (pendingTodos) {
    useProjectsStore.getState().setConversationTodos(projectId, pendingTodos);
    pendingTodos = null;
  }
  todosFlushRaf = 0;
}

function flushTextDelta(projectId: string) {
  if (pendingTextDelta) {
    useProjectsStore
      .getState()
      .appendToLastAssistantText(projectId, pendingTextDelta);
    pendingTextDelta = "";
  }
  textFlushRaf = 0;
}

function flushThinkingDelta(projectId: string) {
  if (pendingThinkingDelta) {
    useProjectsStore
      .getState()
      .appendToLastAssistantThinking(projectId, pendingThinkingDelta);
    pendingThinkingDelta = "";
  }
  thinkingFlushRaf = 0;
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

function buildContinuationBrief(projectId: string): string {
  const project = useProjectsStore.getState().projects.get(projectId);
  if (!project) return "Continue from where you left off.";

  const { messages, todos, cachedBrief } = project.conversation;

  const parts: string[] = [];

  if (cachedBrief) {
    parts.push(cachedBrief);
    parts.push("");
  }

  parts.push("---");
  parts.push(
    "The previous session hit the context window limit. Continuing automatically.",
  );
  parts.push("");
  parts.push("## Recent conversation");
  parts.push("");

  const convoMsgs = messages.filter(
    (m) => m.type === "user" || m.type === "assistant",
  );
  const recent = convoMsgs.slice(-12);

  for (const msg of recent) {
    if (msg.type === "user") {
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) parts.push(`**User:** ${text}`);
    } else if (msg.type === "assistant") {
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) {
        const truncated = text.length > 600 ? text.slice(0, 600) + "…" : text;
        parts.push(`**You (Claude):** ${truncated}`);
      }
    }
  }

  const activeTodos = todos.filter(
    (t) => t.status === "in_progress" || t.status === "pending",
  );
  if (activeTodos.length > 0) {
    parts.push("", "## Pending tasks");
    for (const todo of activeTodos) {
      const marker = todo.status === "in_progress" ? "→" : "·";
      parts.push(`${marker} ${todo.content}`);
    }
  }

  parts.push("", "Pick up exactly where you left off and continue the work.");
  return parts.join("\n");
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

  for (const msg of turnMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;

        if (tool.name === "pane_remember") continue;

        if (tool.name === "Edit" || tool.name === "Write") {
          const filePath =
            (tool.input.file_path as string) ||
            (tool.input.path as string) ||
            "unknown";
          events.push({
            type: "file_edit",
            content: `${tool.name}: ${filePath}`,
            timestamp: now,
            source: "auto",
            metadata: { file: filePath, tool: tool.name },
          });
        }
        if (tool.name === "Bash") {
          const cmd = (tool.input.command as string) || "";
          if (cmd) {
            events.push({
              type: "command",
              content: cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd,
              timestamp: now,
              source: "auto",
              metadata: { tool: "Bash" },
            });
          }
        }

        if (lastError && lastErrorTool && tool.name === lastErrorTool) {
          events.push({
            type: "error_fix",
            content: `Fixed: ${lastError.slice(0, 150)}`,
            timestamp: now,
            source: "auto",
            metadata: { original_error: lastError.slice(0, 200) },
          });
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
            });
          }
          if (seenDecisions.size >= 3) break;
        }
        if (seenDecisions.size >= 3) break;
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

  return events;
}

function extractSessionDelta(messages: ConversationMessage[]) {
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
        if (
          tool.name === "Edit" ||
          tool.name === "Write" ||
          tool.name === "Read"
        ) {
          const filePath =
            (tool.input.file_path as string) ||
            (tool.input.path as string) ||
            (tool.input.target_file as string) ||
            "";
          if (filePath) {
            workingSet.push({ path: filePath });
            recentActions.push({
              type: tool.name.toLowerCase(),
              content: filePath,
              timestamp: now,
            });
          }
        }
        if (tool.name === "Bash") {
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

    const decisionPatterns = [
      /(?:I'll|I will|We'll|Let's|Going to|chose|choosing|decided|using|switched to)\s+(.{15,120})/gi,
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
          if (seen.size >= 3) break;
        }
      }
      if (seen.size >= 3) break;
    }
  }

  if (!workingSet.length && !decisions.length && !recentActions.length)
    return null;
  return { workingSet, decisions, recentActions };
}

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  opus: 200000,
  sonnet: 200000,
  haiku: 200000,
  "gemini-3": 2000000,
  "gemini-2": 1000000,
};

export function getContextLimit(model: string | null): number {
  if (!model) return 200000;
  const lower = model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lower.includes(key)) return limit;
  }
  return 200000;
}

export function usePunk(projectId: string) {
  const abortingRef = useRef(false);
  const continuationRef = useRef<string | null>(null);
  const proactiveContinuationRef = useRef(false);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const store = useProjectsStore.getState();
      const project = store.projects.get(projectId);
      if (!project) return;
      if (project.conversation.isProcessing) return;

      await abortPunk(projectId).catch(() => {});

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
            setTimeout(() => resolve({ id: null, fileCount: 0 }), 3000),
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
      const sessionId = project.conversation.sessionId;
      let resultSafetyTimer: ReturnType<typeof setTimeout> | null = null;

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

        if (continuationRef.current) return;

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

      const handleEvent = (event: ClaudeStreamEvent) => {
        if (resultSafetyTimer) {
          clearTimeout(resultSafetyTimer);
          resultSafetyTimer = setTimeout(() => {
            console.warn(
              "[pane] resultSafetyTimer triggered — Gemini pipe went silent",
            );
            finishProcessing();
          }, 300000);
        }

        switch (event.event) {
          case "processStarted":
            break;

          case "routing": {
            const { model, thinking, intent } = event.data;
            store.setConversationRoutedModel(projectId, model);
            if (thinking && intent === "plan") {
              store.setIsPlanning(projectId, true);
            }
            break;
          }

          case "message": {
            try {
              const msg: ClaudeStreamMessage =
                event.data.parsed ?? JSON.parse(event.data.raw_json!);
              assistantMessageAdded = handleClaudeMessage(
                msg,
                projectId,
                assistantMessageAdded,
              );

              if (msg.type === "result") {
                const proj = useProjectsStore
                  .getState()
                  .projects.get(projectId);
                if (
                  proj?.conversation.contextPressure === "high" &&
                  !proactiveContinuationRef.current
                ) {
                  proactiveContinuationRef.current = true;
                }
              }

              if (msg.type === "result" && !resultSafetyTimer) {
                resultSafetyTimer = setTimeout(() => {
                  console.warn(
                    "[pane] Process hung after result — force-clearing processing state",
                  );
                  finishProcessing();
                }, 30000);
              }
            } catch (e) {
              console.error("Failed to parse claude message:", e);
            }
            break;
          }

          case "processEnded": {
            finishProcessing();

            try {
              const proj = useProjectsStore.getState().projects.get(projectId);
              if (proj && proj.conversation.messages.length > 1) {
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
                );
                if (sessionDelta) {
                  sessionMergeState(projectId, sessionDelta).catch(() => {});
                }
              }
            } catch {
              // ignore
            }

            if (proactiveContinuationRef.current && !continuationRef.current) {
              proactiveContinuationRef.current = false;
              const brief = buildContinuationBrief(projectId);
              useProjectsStore.getState().clearConversation(projectId);
              brainClearSessionPins(projectId).catch(() => {});
              window.dispatchEvent(
                new CustomEvent("pane:context-refreshed", {
                  detail: { projectId },
                }),
              );
              setTimeout(() => sendMessage(brief), 100);
              return;
            }
            break;
          }

          case "error": {
            const isContextLimit =
              /context window|context length|maximum context/i.test(
                event.data.message,
              );
            if (isContextLimit) {
              continuationRef.current = buildContinuationBrief(projectId);
            } else {
              const s = useProjectsStore.getState();
              s.setConversationError(projectId, event.data.message);
              s.setConversationProcessing(projectId, false);
              s.setIsPlanning(projectId, false);
            }
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
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        const selectedModel = useWorkspaceStore.getState().selectedModel;
        const selectedModelThinking =
          useWorkspaceStore.getState().selectedModelThinking;
        const selectedModelProvider =
          useWorkspaceStore.getState().selectedModelProvider;
        const routedModel = chooseModelForIntent(selectedModel, intent);

        resultSafetyTimer = setTimeout(() => {
          console.warn(
            "[pane] resultSafetyTimer triggered (initialization hang)",
          );
          finishProcessing();
        }, 5000);

        const truncatedHistory = conversation.messages.slice(-20);

        await sendToPunk(
          projectId,
          prompt,
          project.root,
          sessionId,
          routedModel,
          handleEvent,
          intent,
          truncatedHistory,
          selectedModelThinking,
          selectedModelProvider,
        );
      } catch (err) {
        console.error("[pane] sendToClaude error:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        store.setConversationError(projectId, errMsg);
        store.setConversationProcessing(projectId, false);
      }

      if (continuationRef.current) {
        const brief = continuationRef.current;
        continuationRef.current = null;
        useProjectsStore.getState().clearConversation(projectId);
        setTimeout(() => sendMessage(brief), 50);
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
    }
  }, [projectId]);

  const clearConversation = useCallback(() => {
    useProjectsStore.getState().clearConversation(projectId);
    useProjectsStore.getState().clearCheckpoints(projectId);
    deleteProjectCheckpoints(projectId).catch(() => {});
    brainClearSessionPins(projectId).catch(() => {});
    sessionClearState(projectId).catch(() => {});
  }, [projectId]);

  return { sendMessage, abortMessage, clearConversation };
}

export const useClaude = usePunk;

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  projectId: string,
  assistantMessageExists: boolean,
): boolean {
  const store = useProjectsStore.getState();

  if (msg.type !== "stream_event") {
    if (pendingTextDelta) {
      cancelAnimationFrame(textFlushRaf);
      flushTextDelta(projectId);
    }
    if (pendingThinkingDelta) {
      cancelAnimationFrame(thinkingFlushRaf);
      flushThinkingDelta(projectId);
    }
    if (pendingToolInput) {
      cancelAnimationFrame(toolInputFlushRaf);
      flushToolInput(projectId);
    }
    if (pendingTodos) {
      cancelAnimationFrame(todosFlushRaf);
      flushTodos(projectId);
    }
    if (pendingJsonDelta) {
      cancelAnimationFrame(jsonFlushRaf);
      flushJsonDelta(projectId);
    }
    isStreamingJson = false;
  }

  if ("skipped" in msg) {
    return assistantMessageExists;
  }

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) {
        store.setConversationSessionId(projectId, msg.session_id);
        if (msg.model) {
          store.setConversationModel(projectId, msg.model);
        }
        store.setConversationReady(projectId, true);
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
      const toolResultMsg: ConversationMessage = {
        id: nextMessageId(),
        type: "system",
        content: msg.message.content as ContentBlock[],
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

        const project = store.projects.get(projectId);
        if (project) {
          const msgs = project.conversation.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const fullText = last.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { type: "text"; text: string }).text)
              .join("\n")
              .trim();
            if (
              /ready to proceed|send ['"]go['"]/i.test(fullText.slice(-200))
            ) {
              store.setPendingPlanApproval(projectId, true);
            }
          }
        }
      } else if (msg.subtype !== "success") {
        if (msg.subtype === "interrupted") return assistantMessageExists;

        console.warn("[pane] Claude non-success result:", msg.subtype, msg);

        const existing = store.projects.get(projectId)?.conversation.error;
        if (!existing) {
          const detail = msg.error?.trim() || msg.result?.trim();
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
        if (pendingTextDelta) {
          cancelAnimationFrame(textFlushRaf);
          flushTextDelta(projectId);
        }
        if (pendingThinkingDelta) {
          cancelAnimationFrame(thinkingFlushRaf);
          flushThinkingDelta(projectId);
        }
        if (pendingToolInput) {
          cancelAnimationFrame(toolInputFlushRaf);
          flushToolInput(projectId);
        }
        if (pendingTodos) {
          cancelAnimationFrame(todosFlushRaf);
          flushTodos(projectId);
        }
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.text
      ) {
        store.setConversationStatusMessage(projectId, null);

        // JSON detection: if message starts with { or [, switch to JSON streaming mode
        if (
          !assistantMessageExists &&
          (evt.delta.text.trim().startsWith("{") ||
            evt.delta.text.trim().startsWith("["))
        ) {
          isStreamingJson = true;
          pendingJsonDelta = evt.delta.text;
          const placeholder: ConversationMessage = {
            id: nextMessageId(),
            type: "assistant",
            content: [{ type: "json", json: {}, raw: evt.delta.text }],
            timestamp: Date.now(),
            isStreaming: true,
          };
          store.addConversationMessage(projectId, placeholder);
          return true;
        }

        if (isStreamingJson) {
          pendingJsonDelta += evt.delta.text;
          if (!jsonFlushRaf) {
            jsonFlushRaf = requestAnimationFrame(() =>
              flushJsonDelta(projectId),
            );
          }
          return true;
        }

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
          pendingTextDelta += evt.delta.text;
          if (!textFlushRaf) {
            textFlushRaf = requestAnimationFrame(() =>
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
          pendingThinkingDelta += evt.delta.thinking;
          if (!thinkingFlushRaf) {
            thinkingFlushRaf = requestAnimationFrame(() =>
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
              const newContent = [
                ...last.content,
                evt.content_block as ThinkingBlock,
              ];
              store.updateLastAssistantContent(projectId, newContent);
            }
          }
        }
        return assistantMessageExists;
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "tool_use"
      ) {
        pendingToolJson = "";
        pendingToolJsonTruncated = false;
        if (toolJsonParseRaf) {
          cancelAnimationFrame(toolJsonParseRaf);
          toolJsonParseRaf = 0;
        }
        const toolBlock = evt.content_block as ToolUseBlock;

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
          store.setPendingPlanApproval(projectId, true);
          store.setIsPlanning(projectId, false);
        }

        return true;
      }

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "partial_json_delta" &&
        evt.delta.partial_json
      ) {
        if (pendingToolJsonTruncated) return assistantMessageExists;

        pendingToolJson += evt.delta.partial_json;
        if (pendingToolJson.length > MAX_STREAMING_TOOL_JSON_CHARS) {
          pendingToolJsonTruncated = true;
          pendingToolJson = "";
          pendingToolInput = {
            __pane_truncated: true,
            __pane_note:
              "Tool input streaming truncated (too large). Full input may still be available in the final message.",
          };
          if (!toolInputFlushRaf) {
            toolInputFlushRaf = requestAnimationFrame(() =>
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
