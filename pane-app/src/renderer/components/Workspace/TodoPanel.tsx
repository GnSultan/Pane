import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import type { Todo } from "../../lib/claude-types";

const EMPTY_TODOS: Todo[] = [];

export function TodoPanel({ projectId }: { projectId: string }) {
  const todos = useProjectsStore(
    useShallow((s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS)
  );

  if (todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="px-4 py-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-pane-text">Tasks</h3>
        <span className="text-xs text-pane-text-secondary/50">
          {completedCount}/{todos.length}
        </span>
      </div>

      {/* Todo list */}
      <div className="space-y-1.5">
        {todos.map((todo, i) => (
          <div
            key={i}
            className="flex items-start gap-2.5 text-sm"
          >
            {/* Status indicator */}
            <div className="shrink-0 mt-1">
              {todo.status === "completed" ? (
                <div className="w-1.5 h-1.5 rounded-full bg-pane-text-secondary/40" />
              ) : todo.status === "in_progress" ? (
                <div className="w-1.5 h-1.5 rounded-full bg-pane-accent-secondary pane-pulse" />
              ) : (
                <div className="w-1.5 h-1.5 rounded-full bg-pane-text-secondary/20" />
              )}
            </div>

            {/* Task content */}
            <div className="flex-1 min-w-0">
              <p
                className={`${
                  todo.status === "completed"
                    ? "text-pane-text-secondary/50 line-through"
                    : todo.status === "in_progress"
                      ? "text-pane-text"
                      : "text-pane-text-secondary/70"
                }`}
              >
                {todo.status === "in_progress"
                  ? todo.activeForm || todo.content
                  : todo.content}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
