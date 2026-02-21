import { useState, useCallback } from "react";
import { useProjectsStore } from "../../stores/projects";
import { open } from "@tauri-apps/plugin-dialog";
import { detectProjectRoot } from "../../lib/tauri-commands";

export function ProjectList() {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);
  const addProject = useProjectsStore((s) => s.addProject);
  const removeProject = useProjectsStore((s) => s.removeProject);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const handleAddProject = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      const root = await detectProjectRoot(selected);
      addProject(root);
    }
  };

  const handleRemoveProject = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeProject(id);
  };

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
      {projectOrder.map((id, index) => {
        const project = projects.get(id);
        if (!project) return null;
        const isActive = id === activeProjectId;
        const isDragging = dragIndex === index;
        const isDropTarget = dragIndex !== null && dropIndex === index && dragIndex !== index;
        const showBadge = project.hasUnreadCompletion;

        return (
          <button
            key={id}
            data-project-index={index}
            onClick={() => setActiveProject(id)}
            onPointerDown={(e) => handlePointerDown(e, index)}
            className={`
              w-full flex items-center gap-1.5 h-8 px-2 truncate group btn-press
              ${isActive ? "bg-pane-text/[0.10] text-pane-text" : "text-pane-text-secondary hover:bg-pane-text/[0.08] hover:text-pane-text active:bg-pane-text/[0.12]"}
              ${isDragging ? "opacity-40" : ""}
              ${isDropTarget ? "border-t-2 border-pane-text/30" : "border-t-2 border-transparent"}
            `}
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            <span className="text-pane-text-secondary w-3 shrink-0"
                  style={{ fontSize: "var(--pane-panel-font-size-xs)" }}>
              {index + 1}
            </span>
            <span className="truncate flex-1 text-left">{project.name}</span>

            {/* Pulsing notification badge when task completes in background */}
            {showBadge && (
              <span className="inline-block w-2 h-2 rounded-full bg-pane-status-added shrink-0 animate-pulse" />
            )}

            <span
              onPointerDown={(e) => {
                e.stopPropagation(); // Prevent parent's drag handler
                handleRemoveProject(e as any, id);
              }}
              className="shrink-0 text-pane-text-secondary opacity-0 group-hover:opacity-100 hover:text-pane-error cursor-pointer flex items-center justify-center w-4 h-4 btn-press"
              style={{ fontSize: "var(--pane-panel-font-size)" }}
            >
              ×
            </span>
          </button>
        );
      })}

      <button
        onClick={handleAddProject}
        className="w-full flex items-center h-8 px-2 btn-press text-pane-text-secondary hover:bg-pane-text/[0.08] hover:text-pane-text active:bg-pane-text/[0.12]"
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      >
        + add project
      </button>
    </div>
  );
}
