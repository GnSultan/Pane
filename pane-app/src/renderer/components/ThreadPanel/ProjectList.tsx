import { useState, useRef, memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "../../stores/projects";
import { NewThreadPicker } from "./NewThreadPicker";
import { rebindProject, detectProjectRoot } from "../../lib/tauri-commands";

const electronAPI = window.electronAPI;

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

/** Slow three-dot processing indicator — replaces the timestamp when a model is running. */
function ProcessingDots() {
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
    >
      <span className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40" />
      <span
        className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40"
        style={{ animationDelay: "0.4s" }}
      />
      <span
        className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40"
        style={{ animationDelay: "0.8s" }}
      />
    </span>
  );
}

/** Active thread row — same as before with the addition of an archive icon. */
const ProjectRow = memo(function ProjectRow({ id }: { id: string }) {
  const name = useProjectsStore((s) => s.projects.get(id)?.name ?? "");
  const isProcessing = useProjectsStore(
    (s) => s.projects.get(id)?.conversation.isProcessing ?? false,
  );
  const hasUnread = useProjectsStore(
    (s) => s.projects.get(id)?.hasUnreadCompletion ?? false,
  );
  const isActive = useProjectsStore((s) => s.activeProjectId === id);
  const root = useProjectsStore((s) => s.projects.get(id)?.root ?? "");

  const rootMissing = useProjectsStore(
    (s) => s.projects.get(id)?.rootMissing ?? false,
  );
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
  const archiveProject = useProjectsStore((s) => s.archiveProject);
  const storeRebindProject = useProjectsStore((s) => s.rebindProject);
  const markRootMissing = useProjectsStore((s) => s.markRootMissing);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isRebinding, setIsRebinding] = useState(false);
  const [bindExpanded, setBindExpanded] = useState(false);
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

  const handleCreateFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRebinding(true);
    try {
      const created = await electronAPI.invoke("create-directory", "~/" + name);
      const newRoot = await detectProjectRoot(created as string);
      const result = await rebindProject(id, root, newRoot);
      if (result.success) {
        storeRebindProject(id, newRoot);
        markRootMissing(id, false);
      }
    } finally {
      setIsRebinding(false);
    }
  };

  // Missing root (folder was moved/deleted): this is a real error state,
  // keep it visually distinct so the user notices and reconnects it.
  if (rootMissing) {
    return (
      <div
        className={`w-full flex items-center gap-1.5 h-8 px-2 rounded-md ${
          isActive ? "bg-pane-accent/[0.10]" : ""
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
          {isRebinding ? "..." : "bind"}
        </button>
      </div>
    );
  }

  // A thread with no folder bound yet is a natural, unremarkable state —
  // it reads and behaves like any other thread. Binding/creating a folder
  // is offered as low-key text actions instead of an alarming CTA.
  const isUnbound = !root;

  const bindCreateActions = (
    <div
      className="flex items-center gap-1.5 leading-tight"
      style={{ fontSize: "var(--pane-panel-font-size)" }}
    >
      <button
        onClick={handleRebind}
        disabled={isRebinding}
        className="text-pane-text-secondary/40 hover:text-pane-text-secondary/70 transition-colors disabled:opacity-40"
      >
        {isRebinding ? "…" : "bind"}
      </button>
      <span className="text-pane-text-secondary/20">·</span>
      <button
        onClick={handleCreateFolder}
        disabled={isRebinding}
        className="text-pane-text-secondary/40 hover:text-pane-text-secondary/70 transition-colors disabled:opacity-40"
      >
        {isRebinding ? "…" : "new"}
      </button>
    </div>
  );

  return (
    <div
      className={`
        w-full flex flex-col gap-0 px-2.5 py-4 rounded-md group btn-press cursor-pointer
        ${
          isActive
            ? "bg-pane-accent/[0.10] text-pane-text"
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
          <>
            <span
              className="truncate text-pane-text font-medium"
              style={{ fontSize: "var(--pane-panel-font-size)" }}
            >
              {name}
            </span>

          </>
        )}

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {!editing && isProcessing && <ProcessingDots />}
          {hasActivity && !editing && !isProcessing && (
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
            <>
              {/* Archive icon */}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  archiveProject(id);
                }}
                className="shrink-0 text-pane-text-secondary/30 opacity-0 group-hover:opacity-100 hover:text-pane-text cursor-pointer flex items-center justify-center w-3.5 h-3.5 btn-press"
                title="Archive thread"
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
                  <path d="M8.5 8.5h-7v-6h7v6zM3 3V1.5h4V3M1.5 3h7" />
                </svg>
              </span>
              {/* Change folder icon — bind/create for unbound threads lives in
                  the excerpt row below instead, so this is only for rebinding
                  an already-bound thread to a different folder. */}
              {!isUnbound && (
                <span
                  onClick={handleRebind}
                  className="shrink-0 text-pane-text-secondary/30 opacity-0 group-hover:opacity-100 hover:text-pane-text cursor-pointer flex items-center justify-center w-3.5 h-3.5 btn-press"
                  title="Change folder"
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
                    <path d="M1.5 8V2.5L4.5 1l4 1.5V8L5 6.5 1.5 8z" />
                    <path d="M1.5 8V5l3-1.5L8 5v3" />
                  </svg>
                </span>
              )}
              {/* Edit icon */}
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
            </>
          )}
        </div>
      </div>

      {/* Excerpt row. Gated on actual excerpt text, not hasActivity —
          lastActivityAt is seeded at creation (so new threads sort to top),
          so it's true immediately and would otherwise mask the empty state.
          - Unbound, no excerpt yet: show bind/create text actions directly.
          - Unbound, has excerpt: show the excerpt with a hover "bind" toggle
            on the right that expands inline to the same text actions —
            same disclosure pattern as the tool-activity expand/collapse.
          - Bound: excerpt only, as before. */}
      {isUnbound && !truncatedExcerpt && (
        <div className="mt-0.5">{bindCreateActions}</div>
      )}

      {isUnbound && truncatedExcerpt && (
        <div className="flex flex-col gap-1 mt-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate flex-1 text-pane-text-secondary/50 leading-tight"
              style={{ fontSize: "var(--pane-panel-font-size)" }}
            >
              {truncatedExcerpt}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setBindExpanded(!bindExpanded);
              }}
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/30 hover:text-pane-text-secondary/70 font-mono"
              style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
            >
              {bindExpanded ? "collapse" : "expand"}
            </button>
          </div>
          {bindExpanded && bindCreateActions}
        </div>
      )}

      {!isUnbound && truncatedExcerpt && (
        <span
          className="truncate text-pane-text-secondary/50 leading-tight mt-0.5"
          style={{ fontSize: "var(--pane-panel-font-size)" }}
        >
          {truncatedExcerpt}
        </span>
      )}
    </div>
  );
});

/** Compact archived row — name + restore action only, no excerpt or timing. */
const ArchivedRow = memo(function ArchivedRow({ id }: { id: string }) {
  const name = useProjectsStore((s) => s.projects.get(id)?.name ?? "");
  const restoreProject = useProjectsStore((s) => s.restoreProject);

  return (
    <div className="w-full flex items-center gap-1.5 h-7 px-2 rounded-md">
      <span
        className="truncate flex-1 text-left text-pane-text-secondary/50"
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      >
        {name}
      </span>
      <button
        onClick={() => restoreProject(id)}
        className="shrink-0 font-mono text-pane-text-secondary/40 hover:text-pane-status-added transition-colors"
        style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
        title="Restore thread"
      >
        restore
      </button>
    </div>
  );
});

export function ProjectList() {
  return (
    <>
      {/* @keyframes for the processing dot animation — defined once per mount */}
      <style>{`
        .processing-dot {
          animation: pane-dot-pulse 2.4s ease-in-out infinite;
        }
        @keyframes pane-dot-pulse {
          0%, 60%, 100% { opacity: 0.2; }
          30% { opacity: 0.9; }
        }
      `}</style>
      <ProjectListInner />
    </>
  );
}

function ProjectListInner() {
  const sortedOrder = useProjectsStore(
    useShallow((s) => {
      const order = s.projectOrder;
      const map = s.projects;
      const idxMap = new Map(order.map((id, i) => [id, i]));
      return [...order].sort((a, b) => {
        const aTime = map.get(a)?.lastActivityAt ?? null;
        const bTime = map.get(b)?.lastActivityAt ?? null;
        if (aTime !== null && bTime !== null) return bTime - aTime;
        if (aTime !== null) return -1;
        if (bTime !== null) return 1;
        return (idxMap.get(a) ?? 0) - (idxMap.get(b) ?? 0);
      });
    }),
  );

  // Track archived status separately — only fires when a project is archived/restored,
  // not on every text delta during streaming.
  const archivedSet = useProjectsStore(
    useShallow((s) => {
      const ids: string[] = [];
      for (const [id, p] of s.projects) {
        if (p.archived) ids.push(id);
      }
      return ids;
    }),
  );

  const activeIds = sortedOrder.filter((id) => !archivedSet.includes(id));
  const archivedIds = sortedOrder.filter((id) => archivedSet.includes(id));

  const [pickerOpen, setPickerOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
    <div className="py-1.5 space-y-0.5">
      {/* Active threads */}
      {activeIds.map((id) => (
        <ProjectRow key={id} id={id} />
      ))}

      {pickerOpen ? (
        <NewThreadPicker onClose={() => setPickerOpen(false)} />
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full flex flex-col gap-0 px-2.5 py-4 rounded-md group btn-press cursor-pointer text-left text-pane-text-secondary hover:bg-pane-text/[0.08] hover:text-pane-text active:bg-pane-text/[0.12]"
        >
          <span
            className="truncate text-pane-text font-medium"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            New thread +
          </span>
          <span
            className="truncate text-pane-text-secondary/40 leading-tight mt-0.5"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            your journey to production begins here…
          </span>
        </button>
      )}

      {/* Archived section — only shown when there are archived threads */}
      {archivedIds.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setArchivedOpen(!archivedOpen)}
            className="w-full flex items-center gap-1.5 px-2 h-7 text-pane-text-secondary/40 hover:text-pane-text-secondary transition-colors"
            style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
          >
            <span className="font-mono">{archivedOpen ? "▾" : "▸"}</span>
            <span>Archived ({archivedIds.length})</span>
          </button>

          {archivedOpen && (
            <div className="space-y-0.5 mt-1">
              {archivedIds.map((id) => (
                <ArchivedRow key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
