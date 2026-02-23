import { useState, useCallback, type ReactNode } from "react";
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
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
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
          ? "text-pane-text-secondary/15 cursor-default"
          : active
            ? "text-pane-text bg-pane-text/[0.08]"
            : "text-pane-text-secondary/40 hover:text-pane-text-secondary hover:bg-pane-text/[0.04]"
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

  const [gitExpanded, setGitExpanded] = useState(false);

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
    setGitExpanded((prev) => !prev);
  }, []);

  return (
    <div className="no-select flex flex-col h-full bg-pane-surface rounded-lg font-panel">
      {/* Spacer for macOS traffic lights — enough room so they sit inside the panel */}
      <div className="h-12 shrink-0" />

      {/* Project list */}
      <div className="border-b border-pane-border py-2">
        <ProjectList />
      </div>

      <FileTree />

      {/* Git status — expands above toolbar */}
      {gitExpanded && isGitRepo && root && activeProjectId && (
        <div className="border-t border-pane-border">
          <GitStatus root={root} projectId={activeProjectId} />
        </div>
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
            active={gitExpanded}
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
