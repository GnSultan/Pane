import { useEffect, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { sendToClaude } from "../lib/tauri-commands";
import type { ClaudeStreamEvent, ClaudeStreamMessage } from "../lib/claude-types";

/**
 * Warms up Claude CLI for a project by sending an initial message.
 * This initializes the Claude process and session before the user types anything,
 * eliminating the delay on first user message and allowing model detection.
 */
export function useClaudeWarmup(projectId: string) {
  const hasWarmedUp = useRef(false);

  useEffect(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);

    // Only warmup if:
    // 1. Haven't warmed up yet
    // 2. Project exists
    // 3. No existing session (not restored)
    // 4. Not already ready
    if (
      hasWarmedUp.current ||
      !project ||
      project.conversation.sessionId ||
      project.conversation.isReady
    ) {
      return;
    }

    hasWarmedUp.current = true;

    const warmup = async () => {
      let sessionId: string | null = null;
      let model: string | null = null;

      const handleEvent = (event: ClaudeStreamEvent) => {
        // Capture init message to get session and model info
        if (event.event === "message") {
          try {
            const msg: ClaudeStreamMessage =
              event.data.parsed ?? JSON.parse(event.data.raw_json!);

            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              sessionId = msg.session_id;
              model = msg.model || null;

              // Set session and model immediately so header shows model
              store.setConversationSessionId(projectId, sessionId);
              if (model) {
                store.setConversationModel(projectId, model);
              }

              // Mark as ready immediately when model appears - don't wait for processEnded
              store.setConversationReady(projectId, true);
            }
          } catch (e) {
            console.error("Failed to parse warmup message:", e);
          }
        }

        // Wait for process to fully complete (Claude has responded)
        if (event.event === "processEnded") {
          // Clear the warmup conversation
          const currentProject = store.projects.get(projectId);
          if (currentProject && currentProject.conversation.messages.length > 0) {
            store.clearConversation(projectId);
            // Restore session info after clearing
            if (sessionId) {
              store.setConversationSessionId(projectId, sessionId);
            }
            if (model) {
              store.setConversationModel(projectId, model);
            }
          }
        }
      };

      try {
        // Send a minimal warmup message
        await sendToClaude(
          projectId,
          "ready",
          project.root,
          null,
          handleEvent,
        );
      } catch (err) {
        console.error("[pane] Claude warmup failed:", err);
        // Mark as ready anyway so user isn't stuck
        store.setConversationReady(projectId, true);
      }
    };

    warmup();
  }, [projectId]);
}
