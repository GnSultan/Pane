import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { useProjectsStore } from "../../stores/projects";

export function Workspace() {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);

  const activeProject = activeProjectId ? projects.get(activeProjectId) : undefined;
  const activeMode = activeProject?.mode ?? "conversation";

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
          {projectOrder.map((id) => {
            const project = projects.get(id);
            if (!project) return null;
            const isActive = id === activeProjectId;
            return (
              <div
                key={id}
                className="flex-1 min-h-0 min-w-0"
                style={{ display: isActive ? "flex" : "none" }}
              >
                <Conversation projectId={id} />
              </div>
            );
          })}
        </div>

        {/* File viewer pane */}
        <div
          className="flex-1 min-h-0 flex flex-col"
          style={{ display: activeMode === "viewer" ? "flex" : "none" }}
        >
          <FileViewer />
        </div>
      </div>
    </div>
  );
}
