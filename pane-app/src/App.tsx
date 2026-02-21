import { useEffect, useCallback, useState } from "react";
import { setWindowTitle } from "./lib/tauri-commands";
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
  const projects = useProjectsStore((s) => s.projects);

  useFileWatcher();
  useGitStatus();
  useSettingsPersistence();

  // Listen for settings open event (from toolbar button)
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("pane:open-settings", handler);
    return () => window.removeEventListener("pane:open-settings", handler);
  }, []);

  // Update window title when active project changes
  useEffect(() => {
    const project = activeProjectId ? projects.get(activeProjectId) : undefined;
    const title = project ? `${project.name} — Pane` : "Pane";
    setWindowTitle(title).catch(console.error);
  }, [activeProjectId, projects]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleControlPanel();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        const { activeProjectId, toggleMode, projects } = useProjectsStore.getState();
        if (activeProjectId) {
          const project = projects.get(activeProjectId);
          // Don't switch to viewer if no file is open
          if (project?.mode === "conversation" && !project.activeFilePath) return;
          toggleMode(activeProjectId);
          const newMode = project?.mode === "conversation" ? "viewer" : "conversation";
          if (newMode === "conversation") {
            window.dispatchEvent(new CustomEvent("pane:focus-input"));
          } else {
            window.dispatchEvent(new CustomEvent("pane:focus-editor"));
          }
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        toggleFuzzyFinder();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        toggleFileSearch();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("pane:focus-input"));
      }
      // Cmd+N — new file (ensure panel is visible first)
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        const ws = useWorkspaceStore.getState();
        if (!ws.controlPanelVisible) {
          ws.toggleControlPanel();
          // Wait for FileTree to mount before dispatching
          setTimeout(() => window.dispatchEvent(new CustomEvent("pane:new-file")), 100);
        } else {
          window.dispatchEvent(new CustomEvent("pane:new-file"));
        }
      }
      // Cmd+, — settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
      // Cmd+Shift+T — toggle theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "t") {
        e.preventDefault();
        useWorkspaceStore.getState().toggleTheme();
      }
      // Cmd+=/- — font size
      if ((e.metaKey || e.ctrlKey) && e.key === "=") {
        e.preventDefault();
        useWorkspaceStore.getState().increaseFontSize();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        useWorkspaceStore.getState().decreaseFontSize();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        useWorkspaceStore.getState().resetFontSize();
      }
      // Cmd+1/2/3 — switch projects
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key) - 1;
        const { projectOrder, setActiveProject } = useProjectsStore.getState();
        if (index < projectOrder.length) {
          e.preventDefault();
          setActiveProject(projectOrder[index]);
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
        <div className="flex-1 min-w-0 pr-2">
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
