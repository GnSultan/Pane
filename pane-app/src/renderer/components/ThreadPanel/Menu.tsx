import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

export type PaneMode = "conversation" | "viewer" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";

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

function ChangeHistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M8 5v3.5l2.5 1.5" />
    </svg>
  );
}

function MenuTriggerIcon() {
  // Three horizontal bars, left-aligned, longest at top — suggesting a menu.
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5h12" />
      <path d="M2 8h9" />
      <path d="M2 11.5h6" />
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
  { id: "conversation", label: "Threads", icon: <ConversationIcon /> },
  { id: "viewer", label: "Files", icon: <FileIcon /> },
  { id: "search", label: "Search", icon: <SearchIcon /> },
  { id: "git", label: "Git", icon: <GitIcon />, requiresGit: true },
  { id: "history", label: "History", icon: <ChangeHistoryIcon /> },
  { id: "lens", label: "Lens", icon: <LensIcon /> },
  { id: "mind", label: "Mind", icon: <MindIcon /> },
  { id: "profile", label: "Profile", icon: <ProfileIcon /> },
];

// ─── Menu Component ──────────────────────────────────────────────────────────

interface MenuProps {
  currentMode: PaneMode;
  isGitRepo: boolean;
  hasUnreadLens: boolean;
  onSelectMode: (mode: PaneMode) => void;
}

export function Menu({ currentMode, isGitRepo, hasUnreadLens, onSelectMode }: MenuProps) {
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

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleSelect = useCallback(
    (mode: PaneMode) => {
      onSelectMode(mode);
      setOpen(false);
    },
    [onSelectMode],
  );

  return (
    <div ref={menuRef} className="w-full">
      {open ? (
        /* Menu items replace the icon — same spot, full width */
        <div className="bg-pane-bg rounded-lg ring-1 ring-pane-border/40 shadow-lg">
          <div className="flex flex-col py-1 px-0.5 w-full">
            {MODES.map((m) => {
              if (m.requiresGit && !isGitRepo) return null;
              const isActive = currentMode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => handleSelect(m.id)}
                  className={`pointer-events-auto w-full flex items-center gap-3 px-2.5 h-8 text-left transition-colors relative rounded-md
                    ${isActive
                      ? "text-pane-text bg-pane-accent/[0.10]"
                      : "text-pane-text-secondary hover:text-pane-text hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40"
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
        </div>
      ) : (
        /* Icon button — only visible when closed */
        <button
          onClick={handleToggle}
          className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md text-pane-text-secondary hover:text-pane-text transition-colors btn-press"
          title="modes"
        >
          <MenuTriggerIcon />
        </button>
      )}
    </div>
  );
}
