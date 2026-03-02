import { useState, useCallback, useEffect, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { ProjectList } from "./ProjectList";
import { GitStatus } from "./GitStatus";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";

// --- Inline SVG icons (16x16, outlined, unified) ---
// Pane design language: consistent 1.5px stroke, simple geometry, harmonious system

function ConversationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2.5" width="8" height="11" rx="0.5" />
      <path d="M6.5 6h3M6.5 9h3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 2v2M8 12v2M14 8h-2M4 8H2" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5.5v5M5.5 8H12" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5l3 2.5-3 2.5" />
      <path d="M8 10.5h5" />
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
          ? "text-pane-text-secondary opacity-30 cursor-default"
          : active
            ? "text-pane-text bg-pane-text/[0.08]"
            : "text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04]"
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
    <div
      className="no-select flex flex-col h-full bg-pane-bg rounded-lg font-panel outline-none ring-1 ring-pane-border/40"
      data-panel="control"
      tabIndex={0}
    >
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
          icon={<ConversationIcon />}
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
          icon={<SearchIcon />}
          onClick={() => useWorkspaceStore.getState().toggleFuzzyFinder()}
        />
        {isGitRepo && (
          <ToolbarButton
            icon={<GitIcon />}
            active={gitPanelActive}
            onClick={toggleGit}
          />
        )}
        <ToolbarButton
          icon={<TerminalIcon />}
          active={mode === "terminal"}
          onClick={() => handleSetMode("terminal")}
        />
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
