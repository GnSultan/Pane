import { useState, useCallback, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";
import { NewThreadPicker } from "./NewThreadPicker";
import { rebindProject } from "../../lib/tauri-commands";
import { detectProjectRoot } from "../../lib/tauri-commands";

const electronAPI = (window as any).electronAPI;

// Each row subscribes to its own primitive data — no inline objects in selectors
function ProjectRow({
  id,
  index,
  dragIndex,
  dropIndex,
  onPointerDown,
}: {
  id: string;
  index: number;
  dragIndex: number | null;
  dropIndex: number | null;
  onPointerDown: (e: React.PointerEvent, index: number) => void;
}) {
  const name = useProjectsStore((s) => s.projects.get(id)?.name ?? "");
  const hasUnread = useProjectsStore((s) => s.projects.get(id)?.hasUnreadCompletion ?? false);
  const isActive = useProjectsStore((s) => s.activeProjectId === id);
  const rootMissing = useProjectsStore((s) => s.projects.get(id)?.rootMissing ?? false);
  const root = useProjectsStore((s) => s.projects.get(id)?.root ?? "");
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);
  const renameProject = useProjectsStore((s) => s.renameProject);
  const storeRebindProject = useProjectsStore((s) => s.rebindProject);
  const markRootMissing = useProjectsStore((s) => s.markRootMissing);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isRebinding, setIsRebinding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDragging = dragIndex === index;
  const isDropTarget = dragIndex !== null && dropIndex === index && dragIndex !== index;

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

  // Missing root: show a compact rebind row instead of the normal row
  if (rootMissing) {
    return (
      <div
        className={`w-full flex items-center gap-1.5 h-8 px-2 rounded-md ${
          isActive ? "bg-pane-text/[0.08]" : ""
        }`}
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      >
        <span className="text-pane-text-secondary w-3 shrink-0"
              style={{ fontSize: "var(--pane-panel-font-size-xs)" }}>
          {index + 1}
        </span>
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
    <button
      key={id}
      data-project-index={index}
      onClick={() => !editing && setActiveProject(id)}
      onPointerDown={(e) => !editing && onPointerDown(e, index)}
      className={`
        w-full flex items-center gap-1.5 h-8 px-2 truncate group btn-press
        ${isActive ? "bg-pane-text/[0.08] rounded-md text-pane-text" : "text-pane-text-secondary hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40 hover:rounded-md hover:text-pane-text"}
        ${isDragging ? "opacity-40" : ""}
        ${isDropTarget ? "border-t-2 border-pane-text/30" : "border-t-2 border-transparent"}
      `}
      style={{ fontSize: "var(--pane-panel-font-size)" }}
    >
      <span className="text-pane-text-secondary w-3 shrink-0"
            style={{ fontSize: "var(--pane-panel-font-size-xs)" }}>
        {index + 1}
      </span>

      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
          onBlur={commitEdit}
          className="flex-1 min-w-0 bg-transparent outline-none text-pane-text"
          style={{ fontSize: "var(--pane-panel-font-size)" }}
        />
      ) : (
        <span className="truncate flex-1 text-left">{name}</span>
      )}

      {hasUnread && !editing && (
        <span className="inline-block w-2 h-2 rounded-full bg-pane-status-added shrink-0 animate-pulse" />
      )}

      {!editing && (
        <span
          onPointerDown={startEdit}
          className="shrink-0 text-pane-text-secondary opacity-0 group-hover:opacity-100 hover:text-pane-text cursor-pointer flex items-center justify-center w-4 h-4 btn-press"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1.5l1.5 1.5-5.5 5.5H1.5V7L7 1.5z" />
          </svg>
        </span>
      )}
    </button>
  );
}

export function ProjectList() {
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      if (e.button !== 0 || projectOrder.length <= 1) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragIndex(index);
    },
    [projectOrder.length],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragIndex === null) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const item = el?.closest("[data-project-index]");
      if (item) {
        const idx = parseInt(item.getAttribute("data-project-index")!);
        setDropIndex(idx);
      }
    },
    [dragIndex],
  );

  const handlePointerUp = useCallback(() => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      reorderProjects(dragIndex, dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, dropIndex, reorderProjects]);

  return (
    <div
      className="px-2 py-1.5 space-y-0.5"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {projectOrder.map((id, index) => (
        <ProjectRow
          key={id}
          id={id}
          index={index}
          dragIndex={dragIndex}
          dropIndex={dropIndex}
          onPointerDown={handlePointerDown}
        />
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
