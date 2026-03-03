import { useState, useEffect } from "react";
import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { useProjectsStore } from "../../stores/projects";
import { getClaudePlanInfo } from "../../lib/tauri-commands";

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

      {/* Content — one view at a time */}
      <div className="h-full flex flex-col">
        <div
          className="flex-1 min-h-0"
          style={{ display: activeMode === "conversation" ? "flex" : "none" }}
        >
          {/* Only mount the active conversation — state lives in Zustand so nothing
              is lost. All-conversations-in-DOM was causing a heavy reflow on every
              project switch. key= ensures clean remount per project. */}
          {activeProjectId && (
            <div key={activeProjectId} className="flex-1 min-h-0 min-w-0 flex">
              <Conversation projectId={activeProjectId} />
            </div>
          )}
        </div>

        <div
          className="flex-1 min-h-0 flex flex-col"
          style={{ display: activeMode === "viewer" ? "flex" : "none" }}
        >
          <FileViewer />
        </div>

        <div
          className="flex-1 min-h-0"
          style={{ display: activeMode === "terminal" ? "flex" : "none" }}
        >
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
