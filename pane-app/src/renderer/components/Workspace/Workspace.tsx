import { useState, useEffect, useRef, memo } from "react";
import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { useProjectsStore } from "../../stores/projects";
import { getClaudePlanInfo } from "../../lib/tauri-commands";

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

function formatModelName(model: string | null): string {
  if (!model) return "";
  const match = model.match(/(haiku|sonnet|opus)-(\d+)-(\d+)/i);
  if (match) {
    const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
    return `${name} ${match[2]}.${match[3]}`;
  }
  return model;
}

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const model = useProjectsStore((s) =>
    s.activeProjectId ? s.projects.get(s.activeProjectId)?.conversation.model ?? null : null
  );
  const [plan, setPlan] = useState<string | null>(null);

  // Keep-alive: mount conversations on first visit, keep them in DOM after.
  // First switch pays the mount cost; every switch after is just a visibility flip.
  const [mountedIds, setMountedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (activeProjectId && !mountedIds.has(activeProjectId)) {
      setMountedIds((prev) => new Set(prev).add(activeProjectId));
    }
  }, [activeProjectId]);

  useEffect(() => {
    getClaudePlanInfo().then(setPlan).catch(() => setPlan(null));
  }, []);

  const modelDisplay = formatModelName(model);
  const showHeader = !!(modelDisplay || plan) && activeMode !== "viewer";

  return (
    <div className="h-full relative">
      {/* Header — floats over content, no layout displacement */}
      {showHeader && (
        <div className="absolute top-0 right-0 h-8 flex items-center justify-end px-4 text-xs text-pane-text/80 font-medium z-10 pointer-events-none">
          <div className="flex items-center gap-2">
            {plan && <span>Claude {plan}</span>}
            {plan && modelDisplay && <span className="text-pane-text/40">·</span>}
            {modelDisplay && <span>{modelDisplay}</span>}
          </div>
        </div>
      )}

      {/* Content — one view at a time, using absolute + visibility so the
          browser keeps layout cached and mode switching is instant both ways. */}
      <div className="h-full relative">
        <div className={`absolute inset-0 ${activeMode !== "conversation" ? "invisible" : ""}`}>
          {[...mountedIds].map((id) => (
            <ConversationLayer key={id} projectId={id} />
          ))}
        </div>

        <div className={`absolute inset-0 flex flex-col ${activeMode !== "viewer" ? "invisible" : ""}`}>
          <FileViewer />
        </div>

        <div className={`absolute inset-0 flex ${activeMode !== "terminal" ? "invisible" : ""}`}>
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
      </div>
    </div>
  );
}
