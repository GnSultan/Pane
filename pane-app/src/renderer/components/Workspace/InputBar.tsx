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
  const [isFadingOut, setIsFadingOut] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const todos = useProjectsStore(
    useShallow((s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS)
  );
  const pendingPlanApproval = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.pendingPlanApproval ?? false
  );
  const isPlanning = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.isPlanning ?? false
  );
  const [planRejected, setPlanRejected] = useState(false);

  // Handle graceful fadeout of processing indicator
  useEffect(() => {
    if (!isProcessing && !isFadingOut) {
      // Start fadeout
      setIsFadingOut(true);
      // Clear fadeout state after animation completes
      const timer = setTimeout(() => setIsFadingOut(false), 1500);
      return () => clearTimeout(timer);
    } else if (isProcessing) {
      setIsFadingOut(false);
    }
  }, [isProcessing, isFadingOut]);
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
          setPlanRejected(false);
        }
      }
      if (e.key === "Escape" && isProcessing) {
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, onSend, onAbort],
  );

  const handleAcceptPlan = useCallback(() => {
    useProjectsStore.getState().setPendingPlanApproval(projectId, false);
    onSend("go");
  }, [projectId, onSend]);

  const handleRejectPlan = useCallback(() => {
    useProjectsStore.getState().setPendingPlanApproval(projectId, false);
    setPlanRejected(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [projectId]);

  return (
    <div className="shrink-0 px-4 pt-2">
      {(isProcessing || isFadingOut) && !pendingPlanApproval && (
        <div className={`flex items-center gap-3 px-2 pb-3 ${isFadingOut ? 'animate-fadeOut' : 'animate-fadeIn'}`}>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-pane-text-secondary"
          >
            {/* The circle pulses - simple, minimal, Pane */}
            <circle
              cx="12"
              cy="12"
              r="7"
              fill="none"
              className="animate-circle-pulse"
              style={{ strokeWidth: 'var(--circle-stroke-width, 1.5)' }}
            />
          </svg>
          {isPlanning && (
            <span
              className="text-pane-text-secondary font-mono"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              planning
            </span>
          )}
          {todos.length > 0 && (
            <button
              onClick={() => setTodoPanelOpen((v) => !v)}
              className="text-pane-text-secondary font-mono hover:text-pane-text btn-press shrink-0"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {todos.every((t) => t.status === "completed")
                ? "done"
                : `todo ${todos.filter((t) => t.status === "completed").length}/${todos.length}`}
            </button>
          )}
          <button
            onClick={onAbort}
            className="text-pane-text-secondary font-mono
                       hover:text-pane-text ml-auto btn-press"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            esc
          </button>
        </div>
      )}
      {pendingPlanApproval && (
        <div className="px-2 pb-3 animate-fadeSlideUp">
          <div className="flex items-center gap-3">
            <span
              className="text-pane-text font-mono"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              plan above — proceed?
            </span>
            <button
              onClick={handleAcceptPlan}
              className="px-3 py-1 rounded font-mono text-pane-status-added
                         hover:bg-pane-status-added/10 btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              go
            </button>
            <button
              onClick={handleRejectPlan}
              className="px-3 py-1 rounded font-mono text-pane-text-secondary
                         hover:text-pane-text hover:bg-pane-text/[0.06] btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              revise
            </button>
            <button
              onClick={onAbort}
              className="text-pane-text-secondary font-mono
                         hover:text-pane-text ml-auto btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              esc
            </button>
          </div>
        </div>
      )}
      {todoPanelOpen && todos.length > 0 && (
        <TodoPanel projectId={projectId} />
      )}
      {!pendingPlanApproval && (
        <div className="bg-pane-surface rounded-lg">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isProcessing ? "" : planRejected ? "what should change..." : "write to claude..."}
            className="w-full bg-transparent text-pane-text font-mono
                       resize-none outline-none placeholder:text-pane-text-secondary
                       leading-[1.75] px-5 py-4 min-h-[160px] max-h-[40vh] overflow-y-auto"
            style={{ fontSize: "var(--pane-font-size)" }}
          />
        </div>
      )}
    </div>
  );
}
