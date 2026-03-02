import { useState, useEffect } from "react";
import { Conversation } from "./Conversation";
import { FileViewer } from "./FileViewer";
import { Terminal } from "./Terminal";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { getClaudePlanInfo, updateClaude } from "../../lib/tauri-commands";

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
  const claudeNewVersion = useWorkspaceStore((s) => s.claudeNewVersion);

  const [plan, setPlan] = useState<string | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; output: string } | null>(null);

  useEffect(() => {
    getClaudePlanInfo().then(setPlan).catch(() => setPlan(null));
  }, []);

  const handleUpdate = async () => {
    setUpdating(true);
    setUpdateResult(null);
    const result = await updateClaude();
    setUpdating(false);
    setUpdateResult({ success: result.success, output: result.output });
    if (result.success) {
      setTimeout(() => {
        setShowUpdateModal(false);
        useWorkspaceStore.getState().checkForClaudeUpdate();
      }, 2000);
    }
  };

  const modelDisplay = formatModelName(model);
  const showHeader = !!(modelDisplay || plan);

  return (
    <div className="h-full overflow-hidden relative">
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

      {/* Update Modal */}
      {showUpdateModal && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-pane-bg border border-pane-border rounded-lg p-6 w-[480px] max-w-[90%]">
            <h2 className="text-lg font-medium mb-2">Update Claude Code</h2>
            {!updateResult ? (
              <>
                <p className="text-sm text-pane-text/70 mb-4">
                  {updating
                    ? "Updating..."
                    : `Claude Code ${claudeNewVersion} is available. Update now?`}
                </p>
                <div className="flex gap-2 justify-end">
                  {!updating && (
                    <button
                      onClick={() => setShowUpdateModal(false)}
                      className="px-4 py-2 text-sm rounded hover:bg-pane-text/5 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={handleUpdate}
                    disabled={updating}
                    className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {updating ? "Updating..." : "Update"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={`text-sm mb-4 ${updateResult.success ? "text-green-400" : "text-red-400"}`}>
                  {updateResult.success ? "Update successful!" : "Update failed"}
                </p>
                <pre className="text-xs bg-pane-text/5 p-3 rounded overflow-auto max-h-48 mb-4">
                  {updateResult.output}
                </pre>
                {!updateResult.success && (
                  <button
                    onClick={() => setShowUpdateModal(false)}
                    className="w-full px-4 py-2 text-sm bg-pane-text/10 rounded hover:bg-pane-text/20 transition-colors"
                  >
                    Close
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Content — one view at a time */}
      <div className="h-full flex flex-col">
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
              <Conversation
                projectId={id}
                onUpdateClick={() => setShowUpdateModal(true)}
              />
            </div>
          ))}
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
