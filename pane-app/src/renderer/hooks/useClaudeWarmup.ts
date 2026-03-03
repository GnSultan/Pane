import { useEffect, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { useWorkspaceStore } from "../stores/workspace";
import { sendToClaude, abortClaude } from "../lib/tauri-commands";
import type { ClaudeStreamEvent, ClaudeStreamMessage } from "../lib/claude-types";

/**
 * Warms up Claude CLI for a project by sending an initial message.
 *
 * Two modes:
 * - Fresh session (no prior messages): sends "ready", waits for full response,
 *   then clears the warmup message. Eliminates first-message cold-start latency.
 * - Restored session (has messages, but model unknown): resumes existing session,
 *   aborts immediately after the init event. Just enough to get the model name
 *   for the header — no message ever appears in the conversation.
 */
export function useClaudeWarmup(projectId: string) {
  const hasWarmedUp = useRef(false);

  useEffect(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);

    // Skip if already done, no project, or model is already known (saved from disk)
    if (
      hasWarmedUp.current ||
      !project ||
      (project.conversation.model && project.conversation.isReady)
    ) {
      return;
    }

    hasWarmedUp.current = true;

    const isRestored = project.conversation.messages.length > 0;

    const warmup = async () => {
      let capturedSessionId: string | null = null;
      let capturedModel: string | null = null;

      const handleEvent = (event: ClaudeStreamEvent) => {
        if (event.event === "message") {
          try {
            const msg: ClaudeStreamMessage =
              event.data.parsed ?? JSON.parse(event.data.raw_json!);

            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              capturedSessionId = msg.session_id;
              capturedModel = msg.model || null;

              store.setConversationSessionId(projectId, capturedSessionId);
              if (capturedModel) store.setConversationModel(projectId, capturedModel);
              store.setConversationReady(projectId, true);

              if (isRestored) {
                // Model captured — abort before Claude processes the message.
                // The "ready" prompt goes to Claude but we stop before any response
                // is added to the conversation. UI stays clean.
                abortClaude(projectId).catch(() => {});
              }
            }
          } catch (e) {
            console.error("Failed to parse warmup message:", e);
          }
        }

        // Fresh session only: clear the warmup message after Claude responds
        if (event.event === "processEnded" && !isRestored) {
          const currentProject = store.projects.get(projectId);
          if (currentProject && currentProject.conversation.messages.length > 0) {
            store.clearConversation(projectId);
            if (capturedSessionId) store.setConversationSessionId(projectId, capturedSessionId);
            if (capturedModel) store.setConversationModel(projectId, capturedModel);
          }
        }
      };

      try {
        const selectedModel = useWorkspaceStore.getState().selectedModel;
        await sendToClaude(
          projectId,
          "ready",
          project.root,
          // Restored sessions resume existing session to avoid starting a new one
          isRestored ? project.conversation.sessionId : null,
          selectedModel,
          handleEvent,
        );
      } catch (err) {
        console.error("[pane] Claude warmup failed:", err);
        store.setConversationReady(projectId, true);
      }
    };

    warmup();
  }, [projectId]);
}
