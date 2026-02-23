import { useCallback, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { sendToClaude, abortClaude } from "../lib/tauri-commands";
import type {
  ClaudeStreamEvent,
  ClaudeStreamMessage,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
} from "../lib/claude-types";

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
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

      const handleEvent = (event: ClaudeStreamEvent) => {
        switch (event.event) {
          case "processStarted":
            break;

          case "message": {
            try {
              const msg: ClaudeStreamMessage = JSON.parse(
                event.data.raw_json,
              );
              assistantMessageAdded = handleClaudeMessage(
                msg,
                projectId,
                assistantMessageAdded,
              );
            } catch (e) {
              console.error("Failed to parse claude message:", e);
            }
            break;
          }

          case "processEnded": {
            const s = useProjectsStore.getState();
            s.setConversationProcessing(projectId, false);
            s.setLastMessageStreamingDone(projectId);

            // Show notification badge if this isn't the active project
            if (s.activeProjectId !== projectId) {
              const project = s.projects.get(projectId);
              if (project) {
                // Set the unread completion flag to show badge on project
                s.setHasUnreadCompletion(projectId, true);

                // Also dispatch event for toast notification
                const event = new CustomEvent("pane:task-complete", {
                  detail: { projectId, projectName: project.name },
                });
                window.dispatchEvent(event);
              }
            }
            break;
          }

          case "error": {
            const s = useProjectsStore.getState();
            s.setConversationError(projectId, event.data.message);
            s.setConversationProcessing(projectId, false);
            break;
          }
        }
      };

      try {
        await sendToClaude(
          projectId,
          prompt,
          project.root,
          sessionId,
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

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) {
        store.setConversationSessionId(projectId, msg.session_id);
      }
      return assistantMessageExists;
    }

    case "assistant": {
      const finalContent = msg.message.content as ContentBlock[];
      if (assistantMessageExists) {
        // Merge: preserve any streamed text blocks that aren't in the final content
        const project = store.projects.get(projectId);
        if (project) {
          const msgs = project.conversation.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const streamedTextBlocks = last.content.filter(
              (b) => b.type === "text",
            );
            const finalHasText = finalContent.some((b) => b.type === "text");
            // If we streamed text but the final message has no text blocks,
            // keep the streamed text and append the final content (tool_use blocks)
            if (streamedTextBlocks.length > 0 && !finalHasText) {
              const merged = [...streamedTextBlocks, ...finalContent];
              store.updateLastAssistantContent(projectId, merged);
            } else {
              store.updateLastAssistantContent(projectId, finalContent);
            }
          } else {
            store.updateLastAssistantContent(projectId, finalContent);
          }
        } else {
          store.updateLastAssistantContent(projectId, finalContent);
        }
        store.setLastMessageStreamingDone(projectId);
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
        );
      } else if (msg.subtype !== "success") {
        store.setConversationError(
          projectId,
          msg.result || "Claude returned an error",
        );
      }
      return assistantMessageExists;
    }

    case "stream_event": {
      const evt = msg.event;

      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.text
      ) {
        if (!assistantMessageExists) {
          // Create streaming placeholder
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
          store.appendToLastAssistantText(projectId, evt.delta.text);
          return true;
        }
      }

      if (
        evt.type === "content_block_start" &&
        evt.content_block?.type === "tool_use"
      ) {
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

              // Parse TodoWrite tool calls
              const toolBlock = evt.content_block as ToolUseBlock;
              if (toolBlock.name === "TodoWrite" && toolBlock.input?.todos) {
                store.setConversationTodos(projectId, toolBlock.input.todos);
              }
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
