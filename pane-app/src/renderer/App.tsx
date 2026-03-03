import { useEffect, useCallback, useState } from "react";
import { setWindowTitle, destroyPty } from "./lib/tauri-commands";
import { resolveBindings, matchAction } from "./lib/keybindings";
import { ControlPanel } from "./components/ControlPanel/ControlPanel";
import { Workspace } from "./components/Workspace/Workspace";
import { FuzzyFinder } from "./components/FuzzyFinder/FuzzyFinder";
import { FileSearch } from "./components/FileSearch/FileSearch";
import { Settings } from "./components/Settings/Settings";
import { TaskNotification } from "./components/shared/TaskNotification";
import { useWorkspaceStore } from "./stores/workspace";
import { useProjectsStore } from "./stores/projects";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useGitStatus } from "./hooks/useGitStatus";
import { useSettingsPersistence } from "./hooks/useSettingsPersistence";

function ResizeHandle() {
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useWorkspaceStore.getState().controlPanelWidth;

    const handlePointerMove = (e: PointerEvent) => {
      const newWidth = startWidth + (e.clientX - startX);
      useWorkspaceStore.getState().setControlPanelWidth(newWidth);
    };

    const handlePointerUp = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  }, []);

  return (
    <div
      onPointerDown={handlePointerDown}
      className="w-1.5 shrink-0 cursor-col-resize hover:bg-pane-text/[0.06]
                 flex items-center justify-center"
    >
      <div className="w-[2px] h-8 bg-transparent group-hover:bg-pane-border" />
    </div>
  );
}

function App() {
  const controlPanelVisible = useWorkspaceStore((s) => s.controlPanelVisible);
  const controlPanelWidth = useWorkspaceStore((s) => s.controlPanelWidth);
  const toggleControlPanel = useWorkspaceStore((s) => s.toggleControlPanel);
  const toggleFuzzyFinder = useWorkspaceStore((s) => s.toggleFuzzyFinder);
  const fuzzyFinderOpen = useWorkspaceStore((s) => s.fuzzyFinderOpen);
  const toggleFileSearch = useWorkspaceStore((s) => s.toggleFileSearch);
  const fileSearchOpen = useWorkspaceStore((s) => s.fileSearchOpen);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  useFileWatcher();
  useGitStatus();
  useSettingsPersistence();

  // Check for Claude updates on app launch
  useEffect(() => {
    useWorkspaceStore.getState().checkForClaudeUpdate();
  }, []);

  // Listen for settings open event (from toolbar button)
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("pane:open-settings", handler);
    return () => window.removeEventListener("pane:open-settings", handler);
  }, []);

  // Update window title when active project changes
  useEffect(() => {
    const project = activeProjectId ? useProjectsStore.getState().projects.get(activeProjectId) : undefined;
    const title = project ? `${project.name} — Pane` : "Pane";
    setWindowTitle(title).catch(console.error);
  }, [activeProjectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+1-9 — project switching (hardcoded, not rebindable)
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key) - 1;
        const { projectOrder, setActiveProject } = useProjectsStore.getState();
        if (index < projectOrder.length) {
          e.preventDefault();
          setActiveProject(projectOrder[index]!);
        }
        return;
      }

      const bindings = resolveBindings(useWorkspaceStore.getState().keybindings);
      const action = matchAction(e, bindings);
      if (!action) return;

      e.preventDefault();

      switch (action) {
        case "toggle-panel":
          toggleControlPanel();
          break;
        case "toggle-mode": {
          const { activeProjectId, setMode, projects } = useProjectsStore.getState();
          if (activeProjectId) {
            const project = projects.get(activeProjectId);
            if (!project) return;
            // Only toggle between conversation and viewer — requires an open file
            if (project.mode === "conversation") {
              if (!project.activeFilePath) return;
              setMode(activeProjectId, "viewer");
              window.dispatchEvent(new CustomEvent("pane:focus-editor"));
            } else {
              setMode(activeProjectId, "conversation");
              window.dispatchEvent(new CustomEvent("pane:focus-input"));
            }
          }
          break;
        }
        case "fuzzy-finder":
          toggleFuzzyFinder();
          break;
        case "file-search":
          toggleFileSearch();
          break;
        case "focus-chat":
          window.dispatchEvent(new CustomEvent("pane:focus-input"));
          break;
        case "new-file": {
          const ws = useWorkspaceStore.getState();
          if (!ws.controlPanelVisible) {
            ws.toggleControlPanel();
            setTimeout(() => window.dispatchEvent(new CustomEvent("pane:new-file")), 100);
          } else {
            window.dispatchEvent(new CustomEvent("pane:new-file"));
          }
          break;
        }
        case "settings":
          setSettingsOpen((prev) => !prev);
          break;
        case "cycle-theme":
          useWorkspaceStore.getState().toggleTheme();
          break;
        case "font-size-increase": {
          const { activeProjectId, projects } = useProjectsStore.getState();
          const project = activeProjectId ? projects.get(activeProjectId) : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="control"]');

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
          const project = activeProjectId ? projects.get(activeProjectId) : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="control"]');

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
          const project = activeProjectId ? projects.get(activeProjectId) : undefined;
          const target = e.target as HTMLElement;
          const isInPanel = target.closest('[data-panel="control"]');

          if (isInPanel) {
            useWorkspaceStore.getState().resetPanelFontSize();
          } else if (project?.mode === "viewer") {
            useWorkspaceStore.getState().resetEditorFontSize();
          } else {
            useWorkspaceStore.getState().resetFontSize();
          }
          break;
        }
        case "terminal-new-tab": {
          const store = useProjectsStore.getState();
          const proj = store.activeProjectId ? store.projects.get(store.activeProjectId) : undefined;
          if (proj?.mode === "terminal") {
            const tabId = `pty-${proj.id}-${Date.now()}`;
            const title = proj.terminalTabs.length === 0 ? "zsh" : `zsh (${proj.terminalTabs.length + 1})`;
            // PTY is created by TerminalTabContent on mount — just add to store
            store.addTerminalTab(proj.id, { id: tabId, title, isAlive: true });
          }
          break;
        }
        case "terminal-close-tab": {
          const store = useProjectsStore.getState();
          const proj = store.activeProjectId ? store.projects.get(store.activeProjectId) : undefined;
          if (proj?.mode === "terminal" && proj.activeTerminalTabId) {
            destroyPty(proj.activeTerminalTabId).catch(() => {});
            store.removeTerminalTab(proj.id, proj.activeTerminalTabId);
          }
          break;
        }
        case "terminal-next-tab": {
          const store = useProjectsStore.getState();
          const proj = store.activeProjectId ? store.projects.get(store.activeProjectId) : undefined;
          if (proj?.mode === "terminal" && proj.terminalTabs.length > 1 && proj.activeTerminalTabId) {
            const idx = proj.terminalTabs.findIndex((t) => t.id === proj.activeTerminalTabId);
            const nextIdx = (idx + 1) % proj.terminalTabs.length;
            store.setActiveTerminalTab(proj.id, proj.terminalTabs[nextIdx]!.id);
          }
          break;
        }
        case "terminal-prev-tab": {
          const store = useProjectsStore.getState();
          const proj = store.activeProjectId ? store.projects.get(store.activeProjectId) : undefined;
          if (proj?.mode === "terminal" && proj.terminalTabs.length > 1 && proj.activeTerminalTabId) {
            const idx = proj.terminalTabs.findIndex((t) => t.id === proj.activeTerminalTabId);
            const prevIdx = (idx - 1 + proj.terminalTabs.length) % proj.terminalTabs.length;
            store.setActiveTerminalTab(proj.id, proj.terminalTabs[prevIdx]!.id);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleControlPanel, toggleFuzzyFinder, toggleFileSearch]);

  return (
    <div className="relative h-screen w-screen bg-pane-bg overflow-hidden">
      {/* Full-width titlebar drag region */}
      <div className="absolute top-0 left-0 right-0 h-12 z-10" data-tauri-drag-region />

      <div className="flex h-full pt-2 pb-2 pl-2 gap-1">
        {controlPanelVisible && (
          <>
            <div className="shrink-0" style={{ width: controlPanelWidth }}>
              <ControlPanel />
            </div>
            <ResizeHandle />
          </>
        )}
        <div className="flex-1 min-w-0 pr-2 h-full">
          <Workspace />
        </div>
      </div>

      {fuzzyFinderOpen && <FuzzyFinder />}
      {fileSearchOpen && <FileSearch />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      <TaskNotification />
    </div>
  );
}

export default App;
