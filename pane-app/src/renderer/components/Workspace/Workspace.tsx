import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { useProjectsStore } from "../../stores/projects";

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const activeRoot = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.root ?? null;
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

        {/* Terminal pane */}
        <div
          className="flex-1 min-h-0 flex flex-col"
          style={{ display: activeMode === "terminal" ? "flex" : "none" }}
        >
          {activeProjectId && activeRoot && (
            <Terminal projectId={activeProjectId} workingDir={activeRoot} />
          )}
        </div>
      </div>
    </div>
  );
}
