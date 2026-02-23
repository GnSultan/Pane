import { useState, useCallback, useRef, useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { TodoPanel } from "./TodoPanel";
import type { Todo } from "../../lib/claude-types";

const EMPTY_TODOS: Todo[] = [];

interface InputBarProps {
  projectId: string;
  onSend: (message: string) => void;
  onAbort: () => void;
  isProcessing: boolean;
}

function isConversationVisible(): boolean {
  const { activeProjectId, projects } = useProjectsStore.getState();
  if (!activeProjectId) return false;
  const project = projects.get(activeProjectId);
  return project?.mode === "conversation";
}

export function InputBar({ projectId, onSend, onAbort, isProcessing }: InputBarProps) {
  const [value, setValue] = useState("");
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const todos = useProjectsStore(
    useShallow((s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS)
  );

  // Auto-focus when not processing — but only if conversation mode is active
  useEffect(() => {
    if (!isProcessing && textareaRef.current && isConversationVisible()) {
      textareaRef.current.focus();
    }
  }, [isProcessing]);

  // Listen for Cmd+K focus event
  useEffect(() => {
    const handler = () => {
      if (textareaRef.current && isConversationVisible()) {
        textareaRef.current.focus();
      }
    };
    window.addEventListener("pane:focus-input", handler);
    return () => window.removeEventListener("pane:focus-input", handler);
  }, []);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxH = window.innerHeight * 0.4;
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) return;
        const trimmed = value.trim();
        if (trimmed) {
          onSend(trimmed);
          setValue("");
        }
      }
      if (e.key === "Escape" && isProcessing) {
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, onSend, onAbort],
  );

  return (
    <div className="shrink-0 px-4 pt-2">
      {isProcessing && (
        <div className="flex items-center gap-3 px-2 pb-3 animate-fadeSlideUp">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-pane-text/60 pane-pulse" />
          <span
            className="text-pane-text/70 font-sans font-medium"
            style={{ fontSize: "var(--pane-font-size)" }}
          >
            claude is working
          </span>
          {todos.length > 0 && (
            <button
              onClick={() => setTodoPanelOpen((v) => !v)}
              className="text-pane-text-secondary/50 font-mono hover:text-pane-text-secondary btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              todo
            </button>
          )}
          <button
            onClick={onAbort}
            className="text-pane-text-secondary/40 font-mono
                       hover:text-pane-text ml-auto btn-press"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            esc
          </button>
        </div>
      )}
      {todoPanelOpen && todos.length > 0 && (
        <TodoPanel projectId={projectId} />
      )}
      <div className="bg-pane-surface border border-pane-border rounded-lg">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isProcessing ? "" : "write to claude..."}
          className="w-full bg-transparent text-pane-text font-mono
                     resize-none outline-none placeholder:text-pane-text-secondary/30
                     leading-[1.75] px-5 py-4 min-h-[160px] max-h-[40vh] overflow-y-auto"
          style={{ fontSize: "var(--pane-font-size)" }}
        />
      </div>
    </div>
  );
}
