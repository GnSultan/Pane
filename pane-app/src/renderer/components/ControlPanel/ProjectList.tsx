import { useState, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "../../stores/projects";
import { NewThreadPicker } from "./NewThreadPicker";
import { rebindProject, detectProjectRoot } from "../../lib/tauri-commands";

const electronAPI = (window as any).electronAPI;

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h";
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + "d";
  if (diff < 2_592_000_000) return Math.floor(diff / 604_800_000) + "w";
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Each row subscribes to its own primitive data — no inline objects in selectors
function ProjectRow({ id }: { id: string }) {
  const name = useProjectsStore((s) => s.projects.get(id)?.name ?? "");
  const hasUnread = useProjectsStore(
    (s) => s.projects.get(id)?.hasUnreadCompletion ?? false,
  );
  const isActive = useProjectsStore((s) => s.activeProjectId === id);
  const rootMissing = useProjectsStore(
    (s) => s.projects.get(id)?.rootMissing ?? false,
  );
  const root = useProjectsStore((s) => s.projects.get(id)?.root ?? "");
  const lastUserPromptText = useProjectsStore(
    (s) => s.projects.get(id)?.lastUserPromptText ?? null,
  );
  const lastResponseSummary = useProjectsStore(
    (s) => s.projects.get(id)?.lastResponseSummary ?? null,
  );
  const lastActivityAt = useProjectsStore(
    (s) => s.projects.get(id)?.lastActivityAt ?? null,
  );
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);
  const renameProject = useProjectsStore((s) => s.renameProject);
  const storeRebindProject = useProjectsStore((s) => s.rebindProject);
  const markRootMissing = useProjectsStore((s) => s.markRootMissing);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isRebinding, setIsRebinding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasActivity = lastActivityAt !== null;
  const excerpt = hasActivity
    ? lastUserPromptText || lastResponseSummary || ""
    : "";
  const truncatedExcerpt =
    excerpt.length > 80 ? excerpt.slice(0, 80) + "…" : excerpt;
  const relativeTime = hasActivity ? formatRelativeTime(lastActivityAt!) : "";

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) renameProject(id, trimmed);
    setEditing(false);
  };

  const handleRebind = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRebinding(true);
    try {
      const selected = await electronAPI.invoke("open-directory-dialog");
      if (!selected || typeof selected !== "string") return;
      const newRoot = await detectProjectRoot(selected);
      const result = await rebindProject(id, root, newRoot);
      if (result.success) {
        storeRebindProject(id, newRoot);
        markRootMissing(id, false);
      }
    } finally {
      setIsRebinding(false);
    }
  };

  // Missing root: show a compact rebind row
  if (rootMissing) {
    return (
      <div
        className={`w-full flex items-center gap-1.5 h-8 px-2 rounded-md ${
          isActive ? "bg-pane-text/[0.08]" : ""
        }`}
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      >
        <span className="truncate flex-1 text-left text-pane-text-secondary/50 line-through">
          {name}
        </span>
        <button
          onClick={handleRebind}
          disabled={isRebinding}
          className="shrink-0 font-mono text-pane-status-modified hover:text-pane-text transition-colors disabled:opacity-40"
          style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
          title={`Folder not found at ${root} — click to rebind`}
        >
          {isRebinding ? "..." : "rebind"}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`
        w-full flex flex-col gap-0 px-2.5 py-2 rounded-md group btn-press cursor-pointer
        ${
          isActive
            ? "bg-pane-text/[0.08] text-pane-text"
            : "text-pane-text-secondary hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40 hover:rounded-md hover:text-pane-text"
        }
      `}
      onClick={() => !editing && setActiveProject(id)}
    >
      {/* Header row: name left, timestamp right */}
      <div className="flex items-center justify-between min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={commitEdit}
            className="flex-1 min-w-0 bg-transparent outline-none text-pane-text"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          />
        ) : (
          <span
            className="truncate text-pane-text font-medium"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            {name}
          </span>
        )}

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {hasActivity && !editing && (
            <span
              className="text-pane-text-secondary/40 whitespace-nowrap"
              style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
            >
              {relativeTime}
            </span>
          )}
          {hasUnread && !editing && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-pane-status-added shrink-0 animate-pulse" />
          )}
          {!editing && (
            <span
              onPointerDown={startEdit}
              className="shrink-0 text-pane-text-secondary/30 opacity-0 group-hover:opacity-100 hover:text-pane-text cursor-pointer flex items-center justify-center w-3.5 h-3.5 btn-press"
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 1.5l1.5 1.5-5.5 5.5H1.5V7L7 1.5z" />
              </svg>
            </span>
          )}
        </div>
      </div>

      {/* Excerpt row — only when the thread has activity */}
      {hasActivity && (
        <span
          className="truncate text-pane-text-secondary/50 leading-tight mt-0.5"
          style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
        >
          {truncatedExcerpt}
        </span>
      )}
    </div>
  );
}

export function ProjectList() {
  const sortedOrder = useProjectsStore(
    useShallow((s) => {
      const order = s.projectOrder;
      const map = s.projects;
      return [...order].sort((a, b) => {
        const aTime = map.get(a)?.lastActivityAt ?? null;
        const bTime = map.get(b)?.lastActivityAt ?? null;
        // Both have activity: most recent first
        if (aTime !== null && bTime !== null) return bTime - aTime;
        // Active threads come before inactive ones
        if (aTime !== null) return -1;
        if (bTime !== null) return 1;
        // Both inactive: insertion order
        return order.indexOf(a) - order.indexOf(b);
      });
    }),
  );

  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="px-2 py-1.5 space-y-0.5">
      {sortedOrder.map((id) => (
        <ProjectRow key={id} id={id} />
      ))}

      {pickerOpen ? (
        <NewThreadPicker onClose={() => setPickerOpen(false)} />
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center h-8 px-2 rounded-md btn-press text-pane-text-secondary hover:bg-pane-text/[0.08] hover:text-pane-text active:bg-pane-text/[0.12]"
          style={{ fontSize: "var(--pane-panel-font-size)" }}
        >
          + new thread
        </button>
      )}
    </div>
  );
}
