import { useEffect, useCallback } from "react";
import { ProjectList } from "./ProjectList";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { Menu, type PaneMode } from "./Menu";

// --- ThreadPanel ---

export function ThreadPanel() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setMode = useProjectsStore((s) => s.setMode);
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);

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
      className="no-select flex flex-col h-full rounded-xl font-panel outline-none relative bg-pane-bg overflow-hidden ring-1 ring-inset ring-pane-border/40 w-80"
      data-panel="thread"
      tabIndex={0}
    >
      {/* Thread list — fills the full panel height, edge to edge.
           pt-12 leaves room for macOS traffic lights to float over the content surface. */}
      <div className="absolute inset-0 overflow-y-auto pt-12 px-2 pb-10">
        <ProjectList />
      </div>

      {/* Bottom bar — Menu on the left, collapse toggle on the right.
           px-1.5 pb-1.5 matches the InputBar '+' attach button padding (p-1.5). */}
      <div className="absolute bottom-0 left-0 right-0 px-1.5 pb-1.5 flex items-end justify-between">
        <Menu
          currentMode={mode}
          isGitRepo={isGitRepo}
          hasUnreadLens={hasUnreadLens}
          onSelectMode={handleSetMode}
        />
        {/* Sidebar collapse toggle — bare glyph with no chrome. Low opacity until you look for it. */}
        <button
          onClick={toggleSidebar}
          className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md text-pane-text-secondary/35 hover:text-pane-text-secondary/70 transition-colors btn-press shrink-0"
          title={sidebarCollapsed ? "Show threads" : "Hide threads"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: sidebarCollapsed ? "rotate(0deg)" : "rotate(180deg)",
              transition: "transform 200ms ease-out",
            }}
          >
            <path d="M10 4 6 8l4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
