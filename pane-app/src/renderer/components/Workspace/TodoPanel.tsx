import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import type { Todo } from "../../lib/claude-types";

const EMPTY_TODOS: Todo[] = [];

interface TodoPanelProps {
  projectId: string;
  onCollapse: () => void;
}

export function TodoPanel({ projectId, onCollapse }: TodoPanelProps) {
  const todos = useProjectsStore(
    useShallow((s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS)
  );

  if (todos.length === 0) return null;

  return (
    <div className="mb-2 bg-pane-bg rounded-2xl ring-1 ring-pane-border/40 overflow-hidden animate-fadeSlideUp">
      <div className="px-5 pt-4 pb-2 space-y-2.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="shrink-0 mt-[3px]">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                className={
                  todo.status === "in_progress"
                    ? "text-pane-text-secondary"
                    : todo.status === "completed"
                      ? "text-pane-text-secondary/25"
                      : "text-pane-text-secondary/15"
                }
              >
                <circle
                  cx="12"
                  cy="12"
                  r="7"
                  fill="none"
                  strokeWidth="1.5"
                  className={todo.status === "in_progress" ? "animate-circle-pulse" : ""}
                  style={todo.status === "in_progress" ? { strokeWidth: 'var(--circle-stroke-width, 1.5)' } : undefined}
                />
              </svg>
            </div>
            <span
              className={`font-mono leading-snug ${
                todo.status === "completed"
                  ? "text-pane-text-secondary/35 line-through"
                  : todo.status === "in_progress"
                    ? "text-pane-text"
                    : "text-pane-text-secondary/50"
              }`}
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {todo.status === "in_progress"
                ? todo.activeForm || todo.content
                : todo.content}
            </span>
          </div>
        ))}
      </div>

      {/* Collapse handle at the bottom */}
      <button
        onClick={onCollapse}
        className="w-full flex items-center justify-start py-2.5 px-1
                   text-pane-text-secondary/25 hover:text-pane-text-secondary/50
                   transition-colors btn-press"
      >
        <svg width="12" height="7" viewBox="0 0 12 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 1L6 6L11 1" />
        </svg>
      </button>
    </div>
  );
}
