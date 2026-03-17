import { useState, useEffect, useRef, memo } from "react";
import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { Profile } from "./Profile";
import { Mind } from "./Mind";
import { ChangeHistoryPanel } from "./ChangeHistoryPanel";
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
  const mindOpen = useWorkspaceStore((s) => s.mindOpen);
  const profileOpen = useWorkspaceStore((s) => s.profileOpen);
  const changeHistoryOpen = useWorkspaceStore((s) => s.changeHistoryOpen);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });

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

  return (
    <div className="h-full relative bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
      {/* Content — one view at a time, using absolute + visibility so the
          browser keeps layout cached and mode switching is instant both ways. */}
      <div className={`absolute inset-0 ${activeMode !== "conversation" || profileOpen || mindOpen || changeHistoryOpen ? "hidden" : ""}`}>
        {[...mountedIds].map((id) => (
          <ConversationLayer key={id} projectId={id} />
        ))}
      </div>

        <div className={`absolute inset-0 flex flex-col ${activeMode !== "viewer" || profileOpen || mindOpen || changeHistoryOpen ? "hidden" : ""}`}>
          <FileViewer />
        </div>

        <div className={`absolute inset-0 flex ${activeMode !== "terminal" || profileOpen || mindOpen || changeHistoryOpen ? "hidden" : ""}`}>
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
        <div className={`absolute inset-0 ${!mindOpen ? "hidden" : ""}`}>
          <Mind />
        </div>

      {/* Profile — takes over workspace when open */}
      <div className={`absolute inset-0 ${!profileOpen ? "hidden" : ""}`}>
        <Profile />
      </div>

      {/* ChangeHistory — takes over workspace when open */}
      {activeProjectId && (
        <div className={`absolute inset-0 bg-pane-bg z-10 ${!changeHistoryOpen ? "hidden" : ""}`}>
          <ChangeHistoryPanel
            projectId={activeProjectId}
            onCollapse={() => useWorkspaceStore.getState().closeChangeHistory()}
          />
        </div>
      )}
    </div>
  );
}
