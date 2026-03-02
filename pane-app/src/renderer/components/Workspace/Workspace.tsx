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
  // claude-sonnet-4-5-20250929 -> Sonnet 4.5
  const match = model.match(/(haiku|sonnet|opus)-(\d+)-(\d+)/i);
  if (match) {
    const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
    const major = match[2];
    const minor = match[3];
    return `${name} ${major}.${minor}`;
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
  const showInfo = modelDisplay || plan;

  return (
    <div className="h-full overflow-hidden bg-pane-bg flex flex-col">
      {/* Combined titlebar spacer + header */}
      {showInfo ? (
        <div className="h-8 shrink-0 flex items-center justify-end px-4 text-xs text-pane-text/80 font-medium">
          <div className="flex items-center gap-2">
            {plan && <span>Claude {plan}</span>}
            {plan && modelDisplay && <span className="text-pane-text/40">·</span>}
            {modelDisplay && <span>{modelDisplay}</span>}
          </div>
        </div>
      ) : (
        <div className="h-4 shrink-0" />
      )}

      {/* Content — one view at a time */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Conversation pane */}
        <div
          className="flex-1 min-h-0"
          style={{ display: activeMode === "conversation" ? "flex" : "none" }}
        >
          {projectOrder.map((id) => (
            <div
              key={id}
              className="flex-1 min-h-0 min-w-0"
              style={{ display: id === activeProjectId ? "flex" : "none" }}
            >
              <Conversation projectId={id} />
            </div>
          ))}
        </div>

        {/* File viewer pane */}
        <div
          className="flex-1 min-h-0 flex flex-col"
          style={{ display: activeMode === "viewer" ? "flex" : "none" }}
        >
          <FileViewer />
        </div>

        {/* Terminal pane — per-project, like conversation */}
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
