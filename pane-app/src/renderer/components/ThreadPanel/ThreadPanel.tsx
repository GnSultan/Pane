import { useEffect, useCallback } from "react";
import { ProjectList } from "./ProjectList";
import { useProjectsStore } from "../../stores/projects";
import { Menu, type PaneMode } from "./Menu";

// --- ThreadPanel ---

export function ThreadPanel() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setMode = useProjectsStore((s) => s.setMode);

  const mode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const isGitRepo = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.git.isGitRepo ?? false;
  });
  const hasUnreadLens = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.hasUnreadLens ?? false;
  });
  // If we're somehow in git mode but the project isn't a git repo, go to conversation
  useEffect(() => {
    if (mode === "git" && !isGitRepo && activeProjectId) {
      setMode(activeProjectId, "conversation");
    }
  }, [isGitRepo, mode, activeProjectId]);

  const handleSetMode = useCallback((newMode: PaneMode) => {
    if (!activeProjectId) return;
    if (mode === newMode) return;
    setMode(activeProjectId, newMode);
    // Defer focus until after React has committed the DOM change and removed
    // display:none from the target panel. Focusing inside display:none is a
    // no-op in Chromium — the rAF fires after the browser's layout pass.
    if (newMode === "conversation") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-input")));
    else if (newMode === "viewer") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-editor")));
    else if (newMode === "search") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-search")));
    else if (newMode === "filesearch") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-filesearch")));
  }, [activeProjectId, mode, setMode]);

  return (
    <div
      className="no-select flex flex-col h-full rounded-xl font-panel outline-none relative bg-pane-bg overflow-hidden"
      data-panel="thread"
      tabIndex={0}
    >
      {/* Thread list — fills the full panel height, edge to edge.
           pt-12 leaves room for macOS traffic lights to float over the content surface. */}
      <div className="absolute inset-0 overflow-y-auto pt-12 px-2 pb-10">
        <ProjectList />
      </div>

      {/* Menu — overlaid at the bottom, floats over the content surface.
           px-1.5 pb-1.5 matches the InputBar '+' attach button padding (p-1.5). */}
      <div className="absolute bottom-0 left-0 right-0 px-1.5 pb-1.5">
        <Menu
          currentMode={mode}
          isGitRepo={isGitRepo}
          hasUnreadLens={hasUnreadLens}
          onSelectMode={handleSetMode}
        />
      </div>
    </div>
  );
}
