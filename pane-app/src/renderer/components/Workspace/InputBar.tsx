import { useState, useCallback, useRef, useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
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

const AVAILABLE_MODELS = [
  { value: "opus", label: "Opus" },
  { value: "opusplan", label: "Opus Plan" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = AVAILABLE_MODELS.find((m) => m.value === value);

  // Collapse on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="flex items-center gap-3">
      {open ? (
        AVAILABLE_MODELS.map((model) => (
          <button
            key={model.value}
            onClick={() => { onChange(model.value); setOpen(false); }}
            className={`flex items-center gap-1.5 btn-press select-none transition-colors ${
              model.value === value
                ? "text-pane-text"
                : "text-pane-text-secondary hover:text-pane-text"
            }`}
          >
            <span className={`w-1 h-1 rounded-full shrink-0 transition-opacity ${
              model.value === value ? "bg-pane-text opacity-100" : "opacity-0"
            }`} />
            {model.label.toLowerCase()}
          </button>
        ))
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-pane-text btn-press select-none"
        >
          <span className="w-1 h-1 rounded-full bg-pane-text shrink-0" />
          {current?.label.toLowerCase()}
        </button>
      )}
    </div>
  );
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
  const selectedModel = useWorkspaceStore((s) => s.selectedModel);
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const claudeUpdateState = useWorkspaceStore((s) => s.claudeUpdateState);
  const triggerClaudeUpdate = useWorkspaceStore((s) => s.triggerClaudeUpdate);

  const [planRejected, setPlanRejected] = useState(false);

  // Handle graceful fadeout of processing indicator
  useEffect(() => {
    if (!isProcessing && !isFadingOut) {
      setIsFadingOut(true);
      const timer = setTimeout(() => setIsFadingOut(false), 1500);
      return () => clearTimeout(timer);
    } else if (isProcessing) {
      setIsFadingOut(false);
    }
  }, [isProcessing, isFadingOut]);

  // Auto-focus when not processing
  useEffect(() => {
    if (!isProcessing && textareaRef.current && isConversationVisible()) {
      textareaRef.current.focus();
    }
  }, [isProcessing]);

  // Cmd+K focus
  useEffect(() => {
    const handler = () => {
      if (textareaRef.current && isConversationVisible()) {
        textareaRef.current.focus();
      }
    };
    window.addEventListener("pane:focus-input", handler);
    return () => window.removeEventListener("pane:focus-input", handler);
  }, []);

  // Auto-resize textarea
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
    <div className="shrink-0 px-4 bg-transparent">

      {/* Processing indicator — only exists when active, no reserved space */}
      {(isProcessing || isFadingOut) && !pendingPlanApproval && (
        <div className={`flex items-center gap-3 px-1 pb-3 ${isFadingOut ? 'animate-fadeOut' : 'animate-fadeIn'}`}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-pane-text-secondary shrink-0"
          >
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
                : todoPanelOpen
                  ? `${todos.filter((t) => t.status === "completed").length}/${todos.length}`
                  : `task ${todos.filter((t) => t.status === "completed").length}/${todos.length}`}
            </button>
          )}
          <button
            onClick={onAbort}
            className="text-pane-text-secondary font-mono hover:text-pane-text ml-auto btn-press"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            esc
          </button>
        </div>
      )}

      {/* Plan approval */}
      {pendingPlanApproval && (
        <div className="px-1 pb-3 animate-fadeSlideUp">
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
              good to go
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
              className="text-pane-text-secondary font-mono hover:text-pane-text ml-auto btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              esc
            </button>
          </div>
        </div>
      )}

      {todoPanelOpen && todos.length > 0 && (
        <TodoPanel projectId={projectId} onCollapse={() => setTodoPanelOpen(false)} />
      )}

      {/* The unified card — textarea body + toolbar strip */}
      {!pendingPlanApproval && (
        <div className="bg-pane-bg rounded-3xl ring-1 ring-pane-border/40 overflow-hidden">
          {/* Writing area */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isProcessing ? "" : planRejected ? "what should change..." : "write to claude..."}
            className="w-full bg-transparent text-pane-text font-mono
                       resize-none outline-none placeholder:text-pane-text-secondary
                       leading-[1.75] px-5 pt-4 pb-3 min-h-[96px] max-h-[40vh] overflow-y-auto"
            style={{ fontSize: "var(--pane-font-size)" }}
          />

          {/* Toolbar strip */}
          <div
            className="h-9 flex items-center px-5 border-t border-pane-border shrink-0 bg-transparent font-mono text-pane-text-secondary"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            <div className="flex-1" />
            {claudeUpdateState === 'available' && (
              <button
                onClick={() => triggerClaudeUpdate()}
                className="flex items-center gap-1.5 hover:text-pane-text btn-press transition-colors mr-5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-pane-status-modified shrink-0" />
                update available
              </button>
            )}
            {claudeUpdateState === 'updating' && (
              <span className="mr-5">updating...</span>
            )}
            {claudeUpdateState === 'updated' && (
              <span className="mr-5">updated</span>
            )}
            {claudeUpdateState === 'restart' && (
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-1.5 hover:text-pane-text btn-press transition-colors mr-5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-pane-status-added shrink-0" />
                restart
              </button>
            )}
            <ModelPicker value={selectedModel} onChange={setSelectedModel} />
          </div>
        </div>
      )}
    </div>
  );
}
