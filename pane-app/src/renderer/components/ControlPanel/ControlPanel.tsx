import { useState, useCallback, useEffect, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { ProjectList } from "./ProjectList";
import { GitStatus } from "./GitStatus";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";

// --- Inline SVG icons (16x16, stroke-based, currentColor) ---

function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1C8.5 4.5 11.5 7.5 15 8C11.5 8.5 8.5 11.5 8 15C7.5 11.5 4.5 8.5 1 8C4.5 7.5 7.5 4.5 8 1Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1.5H4.5A1 1 0 003.5 2.5v11a1 1 0 001 1h7a1 1 0 001-1V5L9 1.5z" />
      <polyline points="9 1.5 9 5 12.5 5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4" />
      <line x1="10" y1="10" x2="14" y2="14" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2" />
      <path d="M6.83 2.17a.5.5 0 0 1 .49-.4h1.36a.5.5 0 0 1 .49.4l.2 1.18a4.5 4.5 0 0 1 1.09.63l1.12-.38a.5.5 0 0 1 .58.2l.68 1.18a.5.5 0 0 1-.1.6l-.92.8a4.5 4.5 0 0 1 0 1.24l.92.8a.5.5 0 0 1 .1.6l-.68 1.18a.5.5 0 0 1-.58.2l-1.12-.38a4.5 4.5 0 0 1-1.09.63l-.2 1.18a.5.5 0 0 1-.49.4H7.32a.5.5 0 0 1-.49-.4l-.2-1.18a4.5 4.5 0 0 1-1.09-.63l-1.12.38a.5.5 0 0 1-.58-.2l-.68-1.18a.5.5 0 0 1 .1-.6l.92-.8a4.5 4.5 0 0 1 0-1.24l-.92-.8a.5.5 0 0 1-.1-.6l.68-1.18a.5.5 0 0 1 .58-.2l1.12.38a4.5 4.5 0 0 1 1.09-.63l.2-1.18z" />
    </svg>
  );
}

function GitBranchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5.5v5M9.5 6c-1.5 0-4.5 1-4.5 4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5h12v9H2z" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8 9.5h3" />
    </svg>
  );
}

// --- Toolbar button ---

function ToolbarButton({ icon, active, disabled, onClick }: {
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-7 h-7 flex items-center justify-center rounded
        ${disabled
          ? "text-pane-text-secondary/25 cursor-default"
          : active
            ? "text-pane-text bg-pane-text/[0.08]"
            : "text-pane-text-secondary/60 hover:text-pane-text-secondary hover:bg-pane-text/[0.04]"
        }`}
    >
      {icon}
    </button>
  );
}

// --- ControlPanel ---

export function ControlPanel() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setMode = useProjectsStore((s) => s.setMode);

  const mode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const activeFilePath = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.activeFilePath ?? null;
  });
  const isGitRepo = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.git.isGitRepo ?? false;
  });
  const root = useProjectsStore((s) => {
    if (!s.activeProjectId) return undefined;
    return s.projects.get(s.activeProjectId)?.root;
  });

  const [gitPanelActive, setGitPanelActive] = useState(false);

  // Auto-close git panel when project changes or isn't a git repo
  useEffect(() => {
    setGitPanelActive(false);
  }, [activeProjectId, isGitRepo]);

  const handleSetMode = useCallback((newMode: "conversation" | "viewer" | "terminal") => {
    if (!activeProjectId || mode === newMode) return;
    if (newMode === "viewer" && !activeFilePath) return;
    setMode(activeProjectId, newMode);
    if (newMode === "conversation") {
      window.dispatchEvent(new CustomEvent("pane:focus-input"));
    } else if (newMode === "viewer") {
      window.dispatchEvent(new CustomEvent("pane:focus-editor"));
    }
    // Terminal handles its own focus
  }, [activeProjectId, mode, activeFilePath, setMode]);

  const toggleGit = useCallback(() => {
    setGitPanelActive((prev) => !prev);
  }, []);

  return (
    <div className="no-select flex flex-col h-full bg-pane-surface rounded-lg font-panel">
      {/* Spacer for macOS traffic lights — enough room so they sit inside the panel */}
      <div className="h-12 shrink-0" />

      {/* Project list */}
      <div className="border-b border-pane-border py-2">
        <ProjectList />
      </div>

      {/* FileTree and GitStatus are mutually exclusive — git takes over the panel */}
      {gitPanelActive && isGitRepo && root && activeProjectId ? (
        <GitStatus root={root} />
      ) : (
        <FileTree />
      )}

      {/* Toolbar */}
      <div className="h-9 flex items-center gap-1 px-2 border-t border-pane-border shrink-0">
        <ToolbarButton
          icon={<SparkleIcon />}
          active={mode === "conversation"}
          onClick={() => handleSetMode("conversation")}
        />
        <ToolbarButton
          icon={<FileIcon />}
          active={mode === "viewer"}
          disabled={!activeFilePath}
          onClick={() => handleSetMode("viewer")}
        />
        <ToolbarButton
          icon={<TerminalIcon />}
          active={mode === "terminal"}
          onClick={() => handleSetMode("terminal")}
        />
        <ToolbarButton
          icon={<SearchIcon />}
          onClick={() => useWorkspaceStore.getState().toggleFuzzyFinder()}
        />
        {isGitRepo && (
          <ToolbarButton
            icon={<GitBranchIcon />}
            active={gitPanelActive}
            onClick={toggleGit}
          />
        )}
        <div className="ml-auto">
          <ToolbarButton
            icon={<SettingsIcon />}
            onClick={() => window.dispatchEvent(new CustomEvent("pane:open-settings"))}
          />
        </div>
      </div>
    </div>
  );
}
