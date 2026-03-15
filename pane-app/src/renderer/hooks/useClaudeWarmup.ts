import { useEffect } from "react";
import { useProjectsStore } from "../stores/projects";
import { useWorkspaceStore } from "../stores/workspace";
import { sendToPunk, abortPunk } from "../lib/tauri-commands";
import type { PunkStreamEvent, PunkStreamMessage } from "../lib/punk-types";

/**
 * Warms up the Punk engine for a project by sending an initial message.
 */
export function usePunkWarmup(projectId: string) {
  // Subscribe to project existence and restoration state
  const project = useProjectsStore((s) => s.projects.get(projectId));
  const isRestored = project?.conversation.isRestored ?? false;
  const isReady = project?.conversation.isReady ?? false;
  const hasModel = !!project?.conversation.model;

  useEffect(() => {
    const store = useProjectsStore.getState();
    
    // CRITICAL: Wait until the project exists AND has been restored from disk.
    // If we start warmup before restoration, we risk overwriting the history.
    if (!project || !isRestored) return;

    // Skip if model is already known and we're ready (saved from disk)
    if (hasModel && isReady) return;

    // We use a local flag to prevent double-warmup within the same mount cycle
    // but the hook itself will re-run if isRestored or projectId changes.
    let warmingUp = false;

    const warmup = async () => {
      if (warmingUp) return;
      warmingUp = true;

      let capturedSessionId: string | null = null;
      let capturedModel: string | null = null;
      let warmupSafetyTimer: ReturnType<typeof setTimeout> | null = null;

      const finishWarmup = () => {
        if (warmupSafetyTimer) {
          clearTimeout(warmupSafetyTimer);
          warmupSafetyTimer = null;
        }
        store.setConversationReady(projectId, true);
        warmingUp = false;
      };

      // Set a safety timer — if Gemini hangs during warmup, don't leave the UI spinning forever
      warmupSafetyTimer = setTimeout(() => {
        console.warn(`[pane] Warmup safety timer triggered for project ${projectId}`);
        finishWarmup();
        abortPunk(projectId).catch(() => {});
      }, 5000); // 5s max for warmup

      const handleEvent = (event: PunkStreamEvent) => {
        if (event.event === "message") {
          try {
            const msg: PunkStreamMessage =
              event.data.parsed ?? JSON.parse(event.data.raw_json!);

            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              capturedSessionId = msg.session_id;
              capturedModel = msg.model || null;

              store.setConversationSessionId(projectId, capturedSessionId);
              if (capturedModel) store.setConversationModel(projectId, capturedModel);
              
              const currentProject = useProjectsStore.getState().projects.get(projectId);
              const hasHistory = (currentProject?.conversation.messages.length || 0) > 0;

              if (hasHistory) {
                // Session resumed — abort immediately after getting metadata
                abortPunk(projectId).catch(() => {});
                finishWarmup();
              }
            }
          } catch (e) {
            console.error("Failed to parse warmup message:", e);
          }
        }

        if (event.event === "error") {
          console.error("[pane] Punk warmup error event:", event.data.message);
          finishWarmup();
        }

        if (event.event === "processEnded") {
          const currentProject = useProjectsStore.getState().projects.get(projectId);
          const hasHistory = (currentProject?.conversation.messages.length || 0) > 0;

          // Fresh session: clear the "ready" response after it finishes
          if (!hasHistory) {
            if (
              currentProject &&
              !currentProject.conversation.isProcessing &&
              currentProject.conversation.messages.length > 0
            ) {
              store.clearConversation(projectId);
              if (capturedSessionId) store.setConversationSessionId(projectId, capturedSessionId);
              if (capturedModel) store.setConversationModel(projectId, capturedModel);
            }
          }
          
          finishWarmup();
        }
      };

      try {
        const selectedModel = useWorkspaceStore.getState().selectedModel;
        const currentProject = useProjectsStore.getState().projects.get(projectId);
        const hasHistoryInitially = (currentProject?.conversation.messages.length || 0) > 0;

        await sendToPunk(
          projectId,
          "ready",
          project.root,
          hasHistoryInitially ? project.conversation.sessionId : null,
          selectedModel,
          handleEvent,
        );
      } catch (err) {
        console.error("[pane] Punk warmup failed:", err);
        finishWarmup();
      }
    };

    warmup();
  }, [projectId, isRestored, hasModel, isReady]);
}

// Backwards-compatible alias while we complete the rename across the app.
export const useClaudeWarmup = usePunkWarmup;
