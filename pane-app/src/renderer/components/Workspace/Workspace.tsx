import { useState, useEffect, useRef, memo } from "react";
import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { Profile } from "./Profile";
import { Mind } from "./Mind";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";

// Visibility is toggled via direct DOM manipulation — bypasses React entirely.
// The Conversation inside is memo'd + never subscribes to activeProjectId,
// so switching projects triggers zero re-renders in the conversation subtree.
const ConversationLayer = memo(function ConversationLayer({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = (activeId: string | null) => {
      if (!ref.current) return;
      const isActive = activeId === projectId;
      ref.current.style.visibility = isActive ? "" : "hidden";
      if (isActive) {
        window.dispatchEvent(new CustomEvent("pane:conversation-activated", { detail: { projectId } }));
      }
    };
    apply(useProjectsStore.getState().activeProjectId);
    return useProjectsStore.subscribe((state, prev) => {
      if (state.activeProjectId !== prev.activeProjectId) {
        apply(state.activeProjectId);
      }
    });
  }, [projectId]);

  return (
    <div ref={ref} className="absolute inset-0 flex" style={{ visibility: "hidden" }}>
      <Conversation projectId={projectId} />
    </div>
  );
});

function ProjectTerminal({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  if (!root) return null;
  return <Terminal projectId={projectId} workingDir={root} />;
}

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const profileOpen = useWorkspaceStore((s) => s.profileOpen);
  const mindOpen = useWorkspaceStore((s) => s.mindOpen);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });

  const claudeUpdateState = useWorkspaceStore((s) => s.claudeUpdateState);
  const triggerClaudeUpdate = useWorkspaceStore((s) => s.triggerClaudeUpdate);
  const geminiUpdateState = useWorkspaceStore((s) => s.geminiUpdateState);
  const triggerGeminiUpdate = useWorkspaceStore((s) => s.triggerGeminiUpdate);

  // Keep-alive: pre-mount ALL projects at startup so every switch is a
  // zero-cost visibility flip. New projects added later get mounted on first visit.
  const [mountedIds, setMountedIds] = useState<Set<string>>(
    () => new Set(useProjectsStore.getState().projectOrder)
  );
  useEffect(() => {
    if (activeProjectId && !mountedIds.has(activeProjectId)) {
      setMountedIds((prev) => new Set(prev).add(activeProjectId));
    }
  }, [activeProjectId]);

  const showUpdate = (!!claudeUpdateState || !!geminiUpdateState) && activeMode !== "viewer";

  return (
    <div className="h-full relative">
      {/* Top Notification Bar — floats over content, only for system-level alerts */}
      {showUpdate && (
        <div className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end px-4 z-50 pointer-events-none gap-2">
          {/* Claude Update Pill */}
          {claudeUpdateState && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-pane-bg/80 backdrop-blur-md ring-1 ring-pane-border/40 shadow-sm pointer-events-auto animate-fadeSlideDown">
              {claudeUpdateState === "available" && (
                <button
                  onClick={() => triggerClaudeUpdate()}
                  className="flex items-center gap-2 text-[11px] font-mono text-pane-text-secondary hover:text-pane-text btn-press transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-pane-status-modified shrink-0 shadow-[0_0_8px_rgba(var(--pane-status-modified-rgb),0.4)]" />
                  claude update available
                </button>
              )}
              {claudeUpdateState === "updating" && (
                <span className="text-[11px] font-mono text-pane-text-secondary animate-pulse">
                  installing claude...
                </span>
              )}
              {claudeUpdateState === "updated" && (
                <span className="text-[11px] font-mono text-pane-status-added">
                  claude complete
                </span>
              )}
              {claudeUpdateState === "restart" && (
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center gap-2 text-[11px] font-mono text-pane-text hover:text-pane-text-secondary btn-press transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-pane-status-added shrink-0" />
                  restart claude
                </button>
              )}
            </div>
          )}

          {/* Gemini Update Pill */}
          {geminiUpdateState && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-pane-bg/80 backdrop-blur-md ring-1 ring-pane-border/40 shadow-sm pointer-events-auto animate-fadeSlideDown">
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

      {/* Content — one view at a time, using absolute + visibility so the
          browser keeps layout cached and mode switching is instant both ways. */}
      <div className="h-full relative">
        <div className={`absolute inset-0 ${activeMode !== "conversation" || profileOpen ? "invisible" : ""}`}>
          {[...mountedIds].map((id) => (
            <ConversationLayer key={id} projectId={id} />
          ))}
        </div>

        <div className={`absolute inset-0 flex flex-col ${activeMode !== "viewer" || profileOpen ? "invisible" : ""}`}>
          <FileViewer />
        </div>

        <div className={`absolute inset-0 flex ${activeMode !== "terminal" || profileOpen ? "invisible" : ""}`}>
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

        {/* Mind — takes over workspace when open */}
        <div className={`absolute inset-0 bg-pane-bg ${!mindOpen ? "invisible" : ""}`}>
          <Mind />
        </div>

        {/* Profile — takes over workspace when open */}
        <div className={`absolute inset-0 bg-pane-bg ${!profileOpen ? "invisible" : ""}`}>
          <Profile />
        </div>
      </div>
    </div>
  );
}
