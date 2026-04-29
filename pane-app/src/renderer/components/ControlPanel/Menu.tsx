import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

export type PaneMode = "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";

// ─── Inline SVG icons (16x16, outlined) ──────────────────────────────────────

function LensIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="11" height="7" rx="2.5" />
      <rect x="4" y="8" width="11" height="7" rx="2.5" />
    </svg>
  );
}

function MindIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M2 8h12" />
      <path d="M8 8v6" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="8" rx="2" />
      <path d="M4 10v4h4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 6h6M5 9h4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="10" height="10" rx="2" />
      <path d="M12 12l2.5 2.5" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <circle cx="8" cy="6.5" r="2" />
      <path d="M4.5 13c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </svg>
  );
}

function GitIcon() {
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
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M4.5 7l2.5 1.5-2.5 1.5" />
      <path d="M9.5 9.5h3.5" />
    </svg>
  );
}

function ChangeHistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M8 5v3.5l2.5 1.5" />
    </svg>
  );
}

function MenuTriggerIcon() {
  // 2×2 grid of panes — represents navigation/modes
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="6" height="6" rx="1.5" />
      <rect x="9" y="1" width="6" height="6" rx="1.5" />
      <rect x="1" y="9" width="6" height="6" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" />
    </svg>
  );
}

// ─── Mode definitions ────────────────────────────────────────────────────────

interface ModeDef {
  id: PaneMode;
  label: string;
  icon: ReactNode;
  requiresGit?: boolean;
}

const MODES: ModeDef[] = [
  { id: "conversation", label: "chat", icon: <ConversationIcon /> },
  { id: "viewer", label: "files", icon: <FileIcon /> },
  { id: "search", label: "search", icon: <SearchIcon /> },
  { id: "git", label: "git", icon: <GitIcon />, requiresGit: true },
  { id: "terminal", label: "terminal", icon: <TerminalIcon /> },
  { id: "history", label: "history", icon: <ChangeHistoryIcon /> },
  { id: "lens", label: "lens", icon: <LensIcon /> },
  { id: "mind", label: "mind", icon: <MindIcon /> },
  { id: "profile", label: "profile", icon: <ProfileIcon /> },
];

// ─── Menu Component ──────────────────────────────────────────────────────────

interface MenuProps {
  currentMode: PaneMode;
  isGitRepo: boolean;
  hasUnreadLens: boolean;
  onSelectMode: (mode: PaneMode) => void;
  position: "sidebar" | "workspace";
}

export function Menu({ currentMode, isGitRepo, hasUnreadLens, onSelectMode, position }: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Delay to avoid the trigger click propagating
    requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const handleSelect = useCallback((mode: PaneMode) => {
    onSelectMode(mode);
    setOpen(false);
  }, [onSelectMode]);

  const triggerSize = position === "workspace" ? "w-8 h-8" : "w-7 h-7";

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`${triggerSize} flex items-center justify-center rounded-xl text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04] relative`}
        title="modes"
      >
        <MenuTriggerIcon />
      </button>

      {/* Expanded menu — positioned upward from trigger */}
      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 min-w-[140px] bg-pane-bg border border-pane-border/40 rounded-xl shadow-xl py-1 z-50"
          style={position === "workspace" ? { left: "0" } : { left: "0" }}
        >
          {MODES.map((m) => {
            if (m.requiresGit && !isGitRepo) return null;
            const isActive = currentMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => handleSelect(m.id)}
                className={`w-full flex items-center gap-3 px-3 py-1.5 font-mono text-left transition-colors relative
                  ${isActive
                    ? "text-pane-text bg-pane-text/[0.08]"
                    : "text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04]"
                  }`}
                style={{ fontSize: "var(--pane-font-size-sm)" }}
              >
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {m.icon}
                </span>
                <span>{m.label}</span>
                {m.id === "lens" && hasUnreadLens && (
                  <span
                    className="w-1.5 h-1.5 rounded-full ml-auto"
                    style={{ background: "var(--pane-terminal)" }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
