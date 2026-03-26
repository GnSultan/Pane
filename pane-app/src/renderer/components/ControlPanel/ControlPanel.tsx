import { useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ProjectList } from "./ProjectList";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useMindStore } from "../../stores/mind";

// --- Inline SVG icons (16x16, outlined) ---
// Pane design language: panel forms, 1.5px stroke, rx="2" matches button radius

function MindIcon() {
  // A pane divided into three compartments — structured intelligence
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M2 8h12" />
      <path d="M8 8v6" />
    </svg>
  );
}

function ConversationIcon() {
  // Rectangular speech pane with a right-angle tail
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="8" rx="2" />
      <path d="M4 10v4h4" />
    </svg>
  );
}

function FileIcon() {
  // Document pane — content lines
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 6h6M5 9h4" />
    </svg>
  );
}

function SearchIcon() {
  // Rectangular search frame with diagonal handle
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="10" height="10" rx="2" />
      <path d="M12 12l2.5 2.5" />
    </svg>
  );
}

function ProfileIcon() {
  // Person inside a pane — head + shoulders, same geometry as every other icon
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <circle cx="8" cy="6.5" r="2" />
      <path d="M4.5 13c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </svg>
  );
}

function GitIcon() {
  // Three square nodes connected — a DAG in pane geometry
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="4" height="4" rx="1.5" />
      <rect x="2" y="10" width="4" height="4" rx="1.5" />
      <rect x="10" y="6" width="4" height="4" rx="1.5" />
      <path d="M4 6v4M6 8H10" />
    </svg>
  );
}

function TerminalIcon() {
  // Terminal window pane with sharp prompt caret and cursor
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M4.5 7l2.5 1.5-2.5 1.5" />
      <path d="M9.5 9.5h3.5" />
    </svg>
  );
}

function ChangeHistoryIcon() {
  // Rectangular clock face — time in a pane
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M8 5v3.5l2.5 1.5" />
    </svg>
  );
}

// --- Toolbar button ---

function ToolbarButton({ icon, active, disabled, onClick, tooltip }: {
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  tooltip?: string;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipTimer, setTooltipTimer] = useState<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (tooltip) {
      setShowTooltip(true);
    }
  };

  const handleMouseLeave = () => {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      setTooltipTimer(null);
    }
    setShowTooltip(false);
  };

  return (
    <div 
      className="relative flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        className={`w-7 h-7 flex items-center justify-center rounded-xl
          ${disabled
            ? "text-pane-text-secondary opacity-30 cursor-default"
            : active
              ? "text-pane-text bg-pane-text/[0.08]"
              : "text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04]"
          }`}
      >
        {icon}
      </button>
      {showTooltip && tooltip && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-pane-bg border border-pane-border/40 rounded-lg text-pane-text-secondary text-[11px] whitespace-nowrap shadow-lg z-50">
          {tooltip}
        </div>
      )}
    </div>
  );
}

// --- Thought Conversations (replaces thread list when in mind chat) ---

function ThoughtConversations() {
  const chatEntryId = useMindStore((s) => s.chatEntryId);
  const entries = useMindStore((s) => s.entries);
  const threadEntryIds = useMindStore((s) => s.threadEntryIds);
  const setChatEntryId = useMindStore((s) => s.setChatEntryId);

  // Stable sort by date — entries never jump positions when switching
  const thoughtEntries = useMemo(() => {
    return entries
      .filter((e) => threadEntryIds.has(e.id) || e.id === chatEntryId)
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
  }, [entries, chatEntryId, threadEntryIds]);

  const label = (content: string) =>
    (content.split("\n")[0] ?? "").slice(0, 48) || "untitled thought";

  return (
    <div>
      {thoughtEntries.map((entry) => {
        const isActive = entry.id === chatEntryId;
        return (
          <button
            key={entry.id}
            onClick={() => setChatEntryId(isActive ? null : entry.id)}
            title={entry.content}
            className={`w-full flex items-center gap-1.5 h-8 px-2 truncate btn-press ${
              isActive
                ? "bg-pane-text/[0.08] rounded-xl text-pane-text"
                : "text-pane-text-secondary hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40 hover:rounded-xl hover:text-pane-text"
            }`}
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            <span className="truncate flex-1 text-left">{label(entry.content)}</span>
          </button>
        );
      })}
    </div>
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
  const mindChatActive = useMindStore((s) => s.chatEntryId !== null);
  const isGitRepo = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.git.isGitRepo ?? false;
  });
  // If we're somehow in git mode but the project isn't a git repo, go to conversation
  useEffect(() => {
    if (mode === "git" && !isGitRepo && activeProjectId) {
      setMode(activeProjectId, "conversation");
    }
  }, [isGitRepo, mode, activeProjectId]);

  const handleSetMode = useCallback((newMode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history") => {
    if (!activeProjectId) return;
    if (mode === newMode) return;
    setMode(activeProjectId, newMode);
    // Defer focus until after React has committed the DOM change and removed
    // display:none from the target panel. Focusing inside display:none is a
    // no-op in Chromium — the rAF fires after the browser's layout pass.
    if (newMode === "conversation") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-input")));
    else if (newMode === "viewer") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-editor")));
  }, [activeProjectId, mode, setMode]);

  return (
    <div
      className="no-select flex flex-col h-full bg-pane-bg rounded-xl font-panel outline-none ring-1 ring-pane-border/40"
      data-panel="control"
      tabIndex={0}
    >
      {/* Spacer for macOS traffic lights — enough room so they sit inside the panel */}
      <div className="h-12 shrink-0" />

      {/* Thread list / thought conversations — fills available space between traffic lights and toolbar */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {mode === "mind" && mindChatActive ? (
          <ThoughtConversations />
        ) : (
          <ProjectList />
        )}
      </div>

      {/* Toolbar */}
      <div className="h-9 flex items-center gap-1 px-2 shrink-0">
        <ToolbarButton
          icon={<ConversationIcon />}
          active={mode === "conversation"}
          onClick={() => handleSetMode("conversation")}
          tooltip="Chat"
        />
        <ToolbarButton
          icon={<FileIcon />}
          active={mode === "viewer"}
          onClick={() => handleSetMode("viewer")}
          tooltip="Files"
        />
        <ToolbarButton
          icon={<SearchIcon />}
          onClick={() => useWorkspaceStore.getState().toggleFuzzyFinder()}
          tooltip="Search"
        />
        {isGitRepo && (
          <ToolbarButton
            icon={<GitIcon />}
            active={mode === "git"}
            onClick={() => handleSetMode("git")}
            tooltip="Git"
          />
        )}
        <ToolbarButton
          icon={<TerminalIcon />}
          active={mode === "terminal"}
          onClick={() => handleSetMode("terminal")}
          tooltip="Terminal"
        />
        <ToolbarButton
          icon={<ChangeHistoryIcon />}
          active={mode === "history"}
          onClick={() => handleSetMode("history")}
          tooltip="History"
        />
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarButton
            icon={<MindIcon />}
            active={mode === "mind"}
            onClick={() => handleSetMode("mind")}
            tooltip="Mind"
          />
          <ToolbarButton
            icon={<ProfileIcon />}
            active={mode === "profile"}
            onClick={() => handleSetMode("profile")}
            tooltip="Profile"
          />
        </div>
      </div>
    </div>
  );
}
