import { useCallback, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { useWorkspaceStore } from "../stores/workspace";
import { sendToClaude, abortClaude } from "../lib/tauri-commands";
import type {
  ClaudeStreamEvent,
  ClaudeStreamMessage,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
} from "../lib/claude-types";

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

// Accumulates partial JSON fragments for streaming tool inputs.
// Safe as module-level: JS is single-threaded, tool blocks stream sequentially,
// and isProcessing guard prevents concurrent streams per project.
let pendingToolJson = "";

// Throttle streaming text/thinking deltas to batch rapid updates into single renders.
// Accumulates text and flushes via rAF so we get at most one store update per frame.
let pendingTextDelta = "";
let pendingThinkingDelta = "";
let textFlushRaf = 0;
let thinkingFlushRaf = 0;

// rAF throttle for tool input mutations — same pattern as text/thinking.
// Accumulates parsed tool input, flushes once per frame instead of on every delta.
let pendingToolInput: Record<string, unknown> | null = null;
let toolInputFlushRaf = 0;

// rAF throttle for TodoWrite updates — ensures todos update smoothly during streaming
// instead of batching all updates until the end.
let pendingTodos: import("../lib/claude-types").Todo[] | null = null;
let todosFlushRaf = 0;

function flushToolInput(projectId: string) {
  if (pendingToolInput) {
    useProjectsStore.getState().updateLastToolUseInput(projectId, pendingToolInput);
    pendingToolInput = null;
  }
  toolInputFlushRaf = 0;
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
    useProjectsStore.getState().appendToLastAssistantText(projectId, pendingTextDelta);
    pendingTextDelta = "";
  }
  textFlushRaf = 0;
}

function flushThinkingDelta(projectId: string) {
  if (pendingThinkingDelta) {
    useProjectsStore.getState().appendToLastAssistantThinking(projectId, pendingThinkingDelta);
    pendingThinkingDelta = "";
  }
  thinkingFlushRaf = 0;
}

/**
 * Close unclosed delimiters in partial JSON so incomplete streaming input
 * can be parsed and displayed progressively. Same approach as Zed's partial_json_fixer.
 */
function fixPartialJson(s: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let result = s;
  if (inString) result += '"';
  while (stack.length) result += stack.pop();
  return result;
}

export function useClaude(projectId: string) {
  const abortingRef = useRef(false);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const store = useProjectsStore.getState();
      const project = store.projects.get(projectId);
      if (!project) return;
      if (project.conversation.isProcessing) return;

      // Add user message
      const userMessage: ConversationMessage = {
        id: nextMessageId(),
        type: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
        isStreaming: false,
      };
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
        const s = useProjectsStore.getState();
        s.setConversationProcessing(projectId, false);
        s.setLastMessageStreamingDone(projectId);
        s.setIsPlanning(projectId, false);

        // Play completion sound when processing finishes
        useWorkspaceStore.getState().playCompletionSound();

        // Show notification badge if this isn't the active project
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
        switch (event.event) {
          case "processStarted":
            break;

          case "message": {
            try {
              // Main process pre-parses JSON; fall back to raw_json if needed
              const msg: ClaudeStreamMessage =
                event.data.parsed ?? JSON.parse(event.data.raw_json!);
              assistantMessageAdded = handleClaudeMessage(
                msg,
                projectId,
                assistantMessageAdded,
              );

              // Safety: if Claude sent a final result but the process hangs,
              // force-clear processing state after 5 seconds.
              if (msg.type === "result" && !resultSafetyTimer) {
                resultSafetyTimer = setTimeout(() => {
                  console.warn("[pane] Process hung after result — force-clearing processing state");
                  finishProcessing();
                }, 5000);
              }
            } catch (e) {
              console.error("Failed to parse claude message:", e);
            }
            break;
          }

          case "processEnded": {
            finishProcessing();
            break;
          }

          case "error": {
            const s = useProjectsStore.getState();
            s.setConversationError(projectId, event.data.message);
            s.setConversationProcessing(projectId, false);
            s.setIsPlanning(projectId, false);
            break;
          }
        }
      };

      try {
        const selectedModel = useWorkspaceStore.getState().selectedModel;
        await sendToClaude(
          projectId,
          prompt,
          project.root,
          sessionId,
          selectedModel,
          handleEvent,
        );
      } catch (err) {
        console.error("[pane] sendToClaude error:", err);
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
      await abortClaude(projectId);
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
  }, [projectId]);

  return { sendMessage, abortMessage, clearConversation };
}

/**
 * Process a parsed stream-json message and update the store.
 * Returns whether an assistant message now exists in the conversation.
 */
function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  projectId: string,
  assistantMessageExists: boolean,
): boolean {
  const store = useProjectsStore.getState();

  // Flush any buffered streaming deltas before processing a new message type
  // (assistant/user/result messages replace or finalize content)
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
  }

  // Large messages (>100KB) are skipped in the worker to avoid structured clone freeze.
  // They send a stub with { type, skipped: true } — nothing to render.
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
        // Mark conversation as ready once we have the model
        store.setConversationReady(projectId, true);
      }
      return assistantMessageExists;
    }

    case "assistant": {
      const finalContent = msg.message.content as ContentBlock[];
      if (assistantMessageExists) {
        // Merge: preserve streamed blocks that aren't in the final content
        const project = store.projects.get(projectId);
        if (project) {
          const msgs = project.conversation.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const streamedTextBlocks = last.content.filter((b) => b.type === "text");
            const streamedThinkingBlocks = last.content.filter((b) => b.type === "thinking");
            const finalHasText = finalContent.some((b) => b.type === "text");
            const finalHasThinking = finalContent.some((b) => b.type === "thinking");

            let merged = finalContent;
            // If we streamed thinking but final has none, prepend streamed thinking
            if (streamedThinkingBlocks.length > 0 && !finalHasThinking) {
              merged = [...streamedThinkingBlocks, ...merged];
            }
            // If we streamed text but final has no text blocks, prepend streamed text
            if (streamedTextBlocks.length > 0 && !finalHasText) {
              // Insert text blocks after any thinking blocks
              const thinkingEnd = merged.findIndex((b) => b.type !== "thinking");
              const insertAt = thinkingEnd === -1 ? merged.length : thinkingEnd;
              merged = [...merged.slice(0, insertAt), ...streamedTextBlocks, ...merged.slice(insertAt)];
            }
            store.updateLastAssistantContent(projectId, merged);
          } else {
            store.updateLastAssistantContent(projectId, finalContent);
          }
        } else {
          store.updateLastAssistantContent(projectId, finalContent);
        }
        store.setLastMessageStreamingDone(projectId);

        // Auto-clear todos if all completed
        if (project) {
          const todos = project.conversation.todos;
          if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
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
      // Auto-generated tool results — add as system type for rendering
      const toolResultMsg: ConversationMessage = {
        id: nextMessageId(),
        type: "system",
        content: msg.message.content as ContentBlock[],
        timestamp: Date.now(),
        isStreaming: false,
      };
      store.addConversationMessage(projectId, toolResultMsg);
      // Next assistant turn starts fresh
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

        // Text-based plan detection: with --dangerously-skip-permissions,
        // EnterPlanMode/ExitPlanMode tools won't fire. Detect plan from text.
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
            // Detect plan prompts like "Ready to proceed" / "send 'go'" etc.
            if (
              /ready to proceed|send ['"]go['"]/i.test(
                fullText.slice(-200),
              )
            ) {
              store.setPendingPlanApproval(projectId, true);
            }
          }
        }
      } else if (msg.subtype !== "success") {
        // Don't overwrite a more specific error already set by the error event
        // (stderr output arrives as an error event before the result message)
        const existing = store.projects.get(projectId)?.conversation.error;
        if (!existing) {
          store.setConversationError(
            projectId,
            msg.result || msg.error || "Claude returned an error",
          );
        }
      }
      return assistantMessageExists;
    }

    case "stream_event": {
      const evt = msg.event;

      // Flush pending deltas before any content_block_start
      // (new blocks need the accumulated text written first)
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

      // Streaming text — throttled to one store update per animation frame
      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.text
      ) {
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
            textFlushRaf = requestAnimationFrame(() => flushTextDelta(projectId));
          }
          return true;
        }
      }

      // Streaming thinking — throttled to one store update per animation frame
      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "thinking_delta" &&
        evt.delta.thinking
      ) {
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
            thinkingFlushRaf = requestAnimationFrame(() => flushThinkingDelta(projectId));
          }
          return true;
        }
      }

      // Thinking signature
      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "signature_delta" &&
        evt.delta.signature
      ) {
        if (assistantMessageExists) {
          store.setLastThinkingSignature(projectId, evt.delta.signature);
        }
        return assistantMessageExists;
      }

      // Thinking block start
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
              const newContent = [...last.content, evt.content_block as ThinkingBlock];
              store.updateLastAssistantContent(projectId, newContent);
            }
          }
        }
        return assistantMessageExists;
      }

      // Tool use block start
      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "tool_use"
      ) {
        pendingToolJson = "";
        if (assistantMessageExists) {
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const newContent = [
                ...last.content,
                evt.content_block as ToolUseBlock,
              ];
              store.updateLastAssistantContent(projectId, newContent);

              const toolBlock = evt.content_block as ToolUseBlock;
              if (toolBlock.name === "EnterPlanMode") {
                store.setIsPlanning(projectId, true);
              }
              if (toolBlock.name === "ExitPlanMode") {
                store.setPendingPlanApproval(projectId, true);
                store.setIsPlanning(projectId, false);
              }
              // With --dangerously-skip-permissions, plan tools won't fire.
              // Plan detection via text pattern happens in the "result" handler.
            }
          }
        }
        return assistantMessageExists;
      }

      // Streaming tool input (input_json_delta)
      // Uses fixPartialJson to close unclosed delimiters so partial inputs
      // are visible during streaming. Store updates are rAF-throttled.
      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "input_json_delta" &&
        evt.delta.partial_json
      ) {
        pendingToolJson += evt.delta.partial_json;
        const fixed = fixPartialJson(pendingToolJson);
        try {
          const parsed = JSON.parse(fixed);

          // TodoWrite detection stays inline — it only fires when input
          // is fully parseable and triggers a different store method.
          const project = store.projects.get(projectId);
          if (project) {
            const msgs = project.conversation.messages;
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const lastTool = [...last.content]
                .reverse()
                .find((b) => b.type === "tool_use") as ToolUseBlock | undefined;
              if (lastTool?.name === "TodoWrite" && parsed.todos) {
                // Throttle todo updates via rAF to prevent React 18 batching all updates
                // Deep clone to ensure Zustand detects updates even within todo objects
                pendingTodos = (parsed.todos as import("../lib/claude-types").Todo[]).map(t => ({ ...t }));
                if (!todosFlushRaf) {
                  todosFlushRaf = requestAnimationFrame(() => flushTodos(projectId));
                }
              }
            }
          }

          // Throttle store update to once per animation frame
          pendingToolInput = parsed;
          if (!toolInputFlushRaf) {
            toolInputFlushRaf = requestAnimationFrame(() => flushToolInput(projectId));
          }
        } catch {
          // Even fixed JSON failed — truly unparseable fragment, wait for more
        }
        return assistantMessageExists;
      }

      // Server tool use block start (web search, etc.)
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
              const newContent = [...last.content, evt.content_block as ServerToolUseBlock];
              store.updateLastAssistantContent(projectId, newContent);
            }
          }
        }
        return assistantMessageExists;
      }

      // Web search tool result
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
              const newContent = [...last.content, evt.content_block as WebSearchToolResultBlock];
              store.updateLastAssistantContent(projectId, newContent);
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
