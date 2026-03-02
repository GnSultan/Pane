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
  const claudeUpdateAvailable = useWorkspaceStore((s) => s.claudeUpdateAvailable);
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
            {claudeUpdateAvailable && (
              <>
                <span className="text-pane-text/40">·</span>
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 transition-colors"
                >
                  Update available
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="h-4 shrink-0" />
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
