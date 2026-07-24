import { useEffect } from "react";
import { setWindowTitle } from "./lib/tauri-commands";
import { resolveBindings, matchAction } from "./lib/keybindings";
import { ThreadPanel } from "./components/ThreadPanel/ThreadPanel";
import { Workspace } from "./components/Workspace/Workspace";
import { TaskNotification } from "./components/shared/TaskNotification";
import { useWorkspaceStore } from "./stores/workspace";
import { useProjectsStore } from "./stores/projects";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useGitStatus } from "./hooks/useGitStatus";
import { useSettingsPersistence } from "./hooks/useSettingsPersistence";

function App() {
  // Sidebar visibility derived from active mode — shown only in conversation mode.
  // When no project exists (empty state), sidebar is visible to show the thread list.
  const sidebarVisible = useProjectsStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.get(id)?.mode === "conversation" : true;
  });
  const toggleMind = () => {
    const { activeProjectId, setMode } = useProjectsStore.getState();
    if (activeProjectId) setMode(activeProjectId, "mind");
  };

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  useFileWatcher();
  useGitStatus();
  useSettingsPersistence();

  // Fetch models on app launch
  useEffect(() => {
    useWorkspaceStore.getState().fetchAllModels();
  }, []);

  // Update window title when active project changes
  useEffect(() => {
    const project = activeProjectId
      ? useProjectsStore.getState().projects.get(activeProjectId)
      : undefined;
    const title = project ? `${project.name} — Pane` : "Pane";
    setWindowTitle(title).catch(console.error);
  }, [activeProjectId]);

  // Notify punks when the user opens or switches to a project so they can
  // Punks are now on-demand via Lens review — no proactive scheduling needed.

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+M — toggle Mind (hardcoded, not rebindable)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleMind();
        return;
      }

      // Cmd+1-9 — project switching (hardcoded, not rebindable)
      // Sorted by lastActivityAt descending to match the visual order in ProjectList
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key) - 1;
        const state = useProjectsStore.getState();
        const { projects, projectOrder, setActiveProject } = state;
        const sortedOrder = [...projectOrder]
          .filter((id) => !projects.get(id)?.archived)
          .sort((a, b) => {
          const aTime = projects.get(a)?.lastActivityAt ?? null;
          const bTime = projects.get(b)?.lastActivityAt ?? null;
          if (aTime !== null && bTime !== null) return bTime - aTime;
          if (aTime !== null) return -1;
          if (bTime !== null) return 1;
          return projectOrder.indexOf(a) - projectOrder.indexOf(b);
        });
        if (index < sortedOrder.length) {
          e.preventDefault();
          setActiveProject(sortedOrder[index]!);
        }
        return;
      }

      const bindings = resolveBindings(
        useWorkspaceStore.getState().keybindings,
      );
      const action = matchAction(e, bindings);

      // Special-case: Cmd+/ (and Ctrl+/) MUST be blocked to prevent Ace from commenting code.
      const isCmdSlash =
        (e.metaKey || e.ctrlKey) && (e.key === "/" || e.code === "Slash");
      if (isCmdSlash) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (!action && !isCmdSlash) return;

      // Always prevent default for recognized actions to avoid editor side-effects
      if (action) {
        e.preventDefault();
        e.stopPropagation();
      }

      const finalAction = action || (isCmdSlash ? "toggle-mode" : null);
      if (!finalAction) return;

      switch (finalAction) {
        case "toggle-panel": {
          // Cmd+B now goes to conversation mode — the conceptual equivalent of "showing the sidebar"
          const { activeProjectId: pid, setMode: sm } = useProjectsStore.getState();
          if (pid) {
            sm(pid, "conversation");
            requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-input")));
          }
          break;
        }
        case "toggle-mode": {
          const { activeProjectId, projects, toggleMode } =
            useProjectsStore.getState();
          if (activeProjectId) {
            const project = projects.get(activeProjectId);
            if (!project) return;

            // Toggle between conversation and viewer modes
            toggleMode(activeProjectId);

            // Dispatch focus events based on the NEW mode (need to get it after toggle)
            setTimeout(() => {
              const updatedProject = useProjectsStore
                .getState()
                .projects.get(activeProjectId);
              if (updatedProject?.mode === "viewer") {
                window.dispatchEvent(new CustomEvent("pane:focus-editor"));
              } else if (updatedProject?.mode === "conversation") {
                window.dispatchEvent(new CustomEvent("pane:focus-input"));
              }
            }, 0);
          }
          break;
        }
        case "fuzzy-finder": {
          const { activeProjectId: pid, projects, setMode: sm } = useProjectsStore.getState();
          if (pid) {
            sm(pid, projects.get(pid)?.mode === "search" ? "conversation" : "search");
          }
          break;
        }
        case "file-search": {
          const { activeProjectId: pid2, projects: p2, setMode: sm2 } = useProjectsStore.getState();
          if (pid2) {
            sm2(pid2, p2.get(pid2)?.mode === "filesearch" ? "conversation" : "filesearch");
          }
          break;
        }
        case "focus-chat":
          window.dispatchEvent(new CustomEvent("pane:focus-input"));
          break;
        case "new-file": {
          const { activeProjectId: pid2, projects, setMode: sm2 } = useProjectsStore.getState();
          const project = pid2 ? projects.get(pid2) : null;
          if (project?.mode !== "conversation") {
            if (pid2) sm2(pid2, "conversation");
            setTimeout(
              () => window.dispatchEvent(new CustomEvent("pane:new-file")),
              100,
            );
          } else {
            window.dispatchEvent(new CustomEvent("pane:new-file"));
          }
          break;
        }
        case "settings": {
          const { activeProjectId, setMode } = useProjectsStore.getState();
          if (activeProjectId) setMode(activeProjectId, "profile");
          break;
        }
        case "cycle-theme":
          useWorkspaceStore.getState().toggleTheme();
          break;
        case "font-size-increase": {
          const { activeProjectId, projects } = useProjectsStore.getState();
          const project = activeProjectId
            ? projects.get(activeProjectId)
            : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="thread"]');

          if (isInPanel) {
            useWorkspaceStore.getState().increasePanelFontSize();
          } else if (project?.mode === "viewer") {
            useWorkspaceStore.getState().increaseEditorFontSize();
          } else {
            useWorkspaceStore.getState().increaseFontSize();
          }
          break;
        }
        case "font-size-decrease": {
          const { activeProjectId, projects } = useProjectsStore.getState();
          const project = activeProjectId
            ? projects.get(activeProjectId)
            : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="thread"]');

          if (isInPanel) {
            useWorkspaceStore.getState().decreasePanelFontSize();
          } else if (project?.mode === "viewer") {
            useWorkspaceStore.getState().decreaseEditorFontSize();
          } else {
            useWorkspaceStore.getState().decreaseFontSize();
          }
          break;
        }
        case "font-size-reset": {
          const { activeProjectId, projects } = useProjectsStore.getState();
          const project = activeProjectId
            ? projects.get(activeProjectId)
            : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="thread"]');

          if (isInPanel) {
            useWorkspaceStore.getState().resetPanelFontSize();
          } else if (project?.mode === "viewer") {
            useWorkspaceStore.getState().resetEditorFontSize();
          } else {
            useWorkspaceStore.getState().resetFontSize();
          }
          break;
        }

      }
    };
    // Capture phase so shortcuts fire before Ace editor eats them (e.g. Cmd+/)
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return (
    <div className="relative h-screen w-screen bg-pane-bg">
      {/* Titlebar drag region — must stay at App root level for full-width coverage.
           z-30 sits above active pages (z-20), below interactive headers (z-40).
           Uses app-region: drag (not -webkit-app-region — dead since Chromium 118+).
           No background needed — app-region works regardless of element opacity. */}
      <div
        className="absolute top-0 left-0 right-0 h-[50px] z-30"
        data-tauri-drag-region
      />
      <div className="flex h-full pt-2 pb-2 pl-2 gap-1">
        {sidebarVisible && (
          <div className="shrink-0 w-80">
            <ThreadPanel />
          </div>
        )}
        <div className="flex-1 min-w-0 pr-2 h-full relative">
          <Workspace />
        </div>
      </div>

      <TaskNotification />
    </div>
  );
}

export default App;
