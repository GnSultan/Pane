import { useEffect, useRef, useState, useCallback, memo } from "react";
import { Conversation } from "./Conversation";
import { FileExplorer } from "./FileExplorer";
import { Terminal } from "./Terminal";
import { Profile } from "./Profile";
import { Mind } from "./Mind";
import { ChangeHistoryPanel } from "./ChangeHistoryPanel";
import { GitStatus } from "../ControlPanel/GitStatus";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { detectProjectRoot } from "../../lib/tauri-commands";

import type { ElectronAPI } from '../../lib/electron';

const electronAPI = window.electronAPI as ElectronAPI;

// z-index stacking for thread switching — zero-cost compositor operation.
// All ConversationLayers are always visible and GPU-composited. Switching threads
// just changes z-index (active=1, inactive=0) + pointer-events. No visibility toggle,
// no layout read, no reflow, no layer teardown. The compositor reorders existing layers
// without repainting — sub-millisecond at any refresh rate.
const ConversationLayer = memo(function ConversationLayer({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const store = useProjectsStore.getState();
  const initiallyActive =
    store.activeProjectId === projectId &&
    (store.projects.get(projectId)?.mode ?? "conversation") === "conversation";

  useEffect(() => {
    const apply = (state: ReturnType<typeof useProjectsStore.getState>) => {
      if (!ref.current) return;
      const isActive = state.activeProjectId === projectId;
      const mode = state.projects.get(projectId)?.mode ?? "conversation";
      const shouldShow = isActive && mode === "conversation";
      ref.current.style.zIndex = shouldShow ? "1" : "0";
      ref.current.style.pointerEvents = shouldShow ? "auto" : "none";
    };

    apply(useProjectsStore.getState());
    return useProjectsStore.subscribe((state, prev) => {
      const activeChanged = state.activeProjectId !== prev.activeProjectId;
      const modeChanged =
        state.projects.get(projectId)?.mode !== prev.projects.get(projectId)?.mode;
      if (activeChanged || modeChanged) apply(state);
    });
  }, [projectId]);

  return (
    <div
      ref={ref}
      className="absolute inset-0 flex bg-pane-bg"
      style={{
        zIndex: initiallyActive ? 1 : 0,
        pointerEvents: initiallyActive ? "auto" : "none",
      }}
    >
      <Conversation projectId={projectId} />
    </div>
  );
});

function ProjectTerminal({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  if (!root) return null;
  return <Terminal projectId={projectId} workingDir={root} />;
}


// Empty state — shown when no threads exist.
// Centered input: type what you're working on → directory picker → thread created → message sent.
function EmptyState() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addProject = useProjectsStore((s) => s.addProject);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = value.trim();
    // Open directory picker
    const selected = await electronAPI.invoke("open-directory-dialog");
    if (!selected || typeof selected !== "string") return;

    const root = await detectProjectRoot(selected);
    const projectId = addProject(root);

    // If user typed something, send it as the first message after a tick
    // (let the conversation mount first)
    if (text) {
      setTimeout(() => {
        const store = useProjectsStore.getState();
        const project = store.projects.get(projectId);
        if (project) {
          // Dispatch a custom event that Conversation's InputBar can pick up,
          // or directly call the send function via the store
          window.dispatchEvent(new CustomEvent("pane:send-message", {
            detail: { projectId, message: text }
          }));
        }
      }, 200);
    }
  }, [value, addProject]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="absolute inset-0 flex items-center justify-center" data-no-drag>
      <div className="w-full max-w-xl px-10">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="what are you working on"
          rows={1}
          className="w-full bg-transparent text-pane-text font-mono resize-none outline-none placeholder:text-pane-text-secondary/40 leading-relaxed"
          style={{ fontSize: "var(--pane-font-size)" }}
        />
      </div>
    </div>
  );
}

function GitView({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root);
  if (!root) return null;
  return <GitStatus root={root} projectId={projectId} />;
}

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const geminiUpdateState = useWorkspaceStore((s) => s.geminiUpdateState);
  const triggerGeminiUpdate = useWorkspaceStore((s) => s.triggerGeminiUpdate);
  const showUpdate = !!geminiUpdateState;
  const wsRef = useRef<HTMLDivElement>(null);

  // Single store subscription → single data-mode DOM write → CSS handles all page visibility.
  // No React re-render on mode switch. All pages transition in one style recalc, one paint frame.
  useEffect(() => {
    const applyMode = (state: ReturnType<typeof useProjectsStore.getState>) => {
      if (!wsRef.current) return;
      const id = state.activeProjectId;
      const mode = id ? state.projects.get(id)?.mode ?? "conversation" : "conversation";
      wsRef.current.dataset.mode = mode;
    };
    applyMode(useProjectsStore.getState());
    return useProjectsStore.subscribe((state, prev) => {
      const activeChanged = state.activeProjectId !== prev.activeProjectId;
      const modeChanged = state.activeProjectId
        ? state.projects.get(state.activeProjectId)?.mode !==
          prev.projects.get(state.activeProjectId ?? "")?.mode
        : false;
      if (activeChanged || modeChanged) applyMode(state);
    });
  }, []);

  return (
    <div ref={wsRef} data-mode="conversation" className="h-full relative bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
      {/* Empty state — no threads yet */}
      {projectOrder.length === 0 && (
        <EmptyState />
      )}

      {/* Conversation layers — self-managing visibility via store subscription */}
      {projectOrder.map((id) => (
        <ConversationLayer key={id} projectId={id} />
      ))}

      <div data-page="viewer" className="absolute inset-0 flex flex-col bg-pane-bg">
        <FileExplorer />
      </div>

      <div data-page="terminal" className="absolute inset-0 flex bg-pane-bg">
        {projectOrder.map((id) => (
          <div
            key={id}
            className="flex-1 min-h-0 min-w-0 flex flex-col"
            style={{ display: id === activeProjectId ? "flex" : "none" }}
          >
            <ProjectTerminal projectId={id} />
          </div>
        ))}
      </div>

      <div data-page="git" className="absolute inset-0 flex flex-col bg-pane-bg">
        {projectOrder.map((id) => (
          <div
            key={id}
            className="absolute inset-0 flex flex-col"
            style={{ display: id === activeProjectId ? "flex" : "none" }}
          >
            <GitView projectId={id} />
          </div>
        ))}
      </div>

      <div data-page="mind" className="absolute inset-0 bg-pane-bg">
        <Mind />
      </div>

      <div data-page="profile" className="absolute inset-0 bg-pane-bg">
        <Profile />
      </div>

      {activeProjectId && (
        <div data-page="history" className="absolute inset-0 bg-pane-bg">
          <ChangeHistoryPanel projectId={activeProjectId} />
        </div>
      )}

      {/* Update notification pills — inside the workspace border, top-right corner */}
      {showUpdate && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-2 z-40 pointer-events-none">

          {geminiUpdateState && (
            <div
              data-no-drag
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-pane-bg/80 backdrop-blur-md ring-1 ring-pane-border/40 pointer-events-auto animate-fadeSlideDown"
            >
              {geminiUpdateState === "available" && (
                <button
                  onClick={() => triggerGeminiUpdate()}
                  className="flex items-center gap-2 text-[11px] font-mono text-pane-text-secondary hover:text-pane-text btn-press transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-pane-status-modified shrink-0 shadow-[0_0_8px_rgba(var(--pane-status-modified-rgb),0.4)]" />
                  gemini update available
                </button>
              )}
              {geminiUpdateState === "updating" && (
                <span className="text-[11px] font-mono text-pane-text-secondary animate-pulse">
                  installing gemini...
                </span>
              )}
              {geminiUpdateState === "updated" && (
                <span className="text-[11px] font-mono text-pane-status-added">
                  gemini complete
                </span>
              )}
              {geminiUpdateState === "restart" && (
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center gap-2 text-[11px] font-mono text-pane-text hover:text-pane-text-secondary btn-press transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-pane-status-added shrink-0" />
                  restart gemini
                </button>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
