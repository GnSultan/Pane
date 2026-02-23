import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { useProjectsStore } from "../../stores/projects";

function ProjectTerminal({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  if (!root) return null;
  return <Terminal projectId={projectId} workingDir={root} />;
}

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });

  return (
    <div className="h-full overflow-hidden bg-pane-bg flex flex-col">
      {/* Spacer for titlebar */}
      <div className="h-10 shrink-0" />

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
