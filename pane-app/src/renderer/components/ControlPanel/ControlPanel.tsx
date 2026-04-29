import { useEffect, useCallback } from "react";
import { ProjectList } from "./ProjectList";
import { useProjectsStore } from "../../stores/projects";
import { Menu, type PaneMode } from "./Menu";

// --- ControlPanel ---

export function ControlPanel() {
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
      className="no-select flex flex-col h-full bg-pane-bg rounded-xl font-panel outline-none ring-1 ring-pane-border/40"
      data-panel="control"
      tabIndex={0}
    >
      {/* Spacer for macOS traffic lights — enough room so they sit inside the panel */}
      <div className="h-12 shrink-0" />

      {/* Thread list — fills available space between traffic lights and toolbar */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        <ProjectList />
      </div>

      {/* Menu — icon at bottom, items expand upward from it */}
      <div className="px-2 shrink-0 flex flex-col justify-end min-h-9">
        <Menu
          currentMode={mode}
          isGitRepo={isGitRepo}
          hasUnreadLens={hasUnreadLens}
          onSelectMode={handleSetMode}
          position="sidebar"
        />
      </div>
    </div>
  );
}
