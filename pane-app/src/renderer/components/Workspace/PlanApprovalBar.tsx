import { useState, useRef, useEffect, useCallback } from "react";
import { respondToTool } from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";

interface PlanApprovalBarProps {
  projectId: string;
  toolId: string;
  question: string | null;
  inputType: "plan_approval" | "question";
}

/**
 * Renders when Claude calls ExitPlanMode or AskUserQuestion and execution is
 * suspended waiting for the user. Sends the user's response back via IPC,
 * which resolves the Promise in the tool executor and lets Claude continue.
 */
export function PlanApprovalBar({ projectId, toolId, question, inputType }: PlanApprovalBarProps) {
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<"default" | "rejecting">("default");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount for question mode, or rejection mode once open
  useEffect(() => {
    if (inputType === "question" || mode === "rejecting") {
      inputRef.current?.focus();
    }
  }, [inputType, mode]);

  const respond = useCallback(async (response: string) => {
    if (submitted) return;
    setSubmitted(true);
    try {
      await respondToTool(projectId, toolId, response);
    } catch {
      // IPC failed — let the user retry
      setSubmitted(false);
      return;
    }
    useProjectsStore.getState().clearPendingInput(projectId);
  }, [submitted, projectId, toolId]);

  const handleApprove = () => respond("approved");

  const handleReject = () => {
    if (mode !== "rejecting") {
      setMode("rejecting");
      return;
    }
    respond(`rejected: ${feedback.trim()}`);
  };

  const handleQuestionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim()) return;
    respond(feedback.trim());
  };

  if (submitted) return null;

  // ── Question mode ──────────────────────────────────────────────────────────
  if (inputType === "question") {
    return (
      <div className="px-4 pb-3">
        <div
          className="rounded-xl bg-pane-surface/60 ring-1 ring-pane-border/20 px-4 py-3 font-mono animate-fade-in"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {question && (
            <div className="text-pane-text mb-3 leading-[1.6]">{question}</div>
          )}
          <form onSubmit={handleQuestionSubmit} className="flex gap-2 items-center">
            <input
              ref={inputRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="your answer"
              className="flex-1 bg-transparent outline-none text-pane-text placeholder:text-pane-text-secondary/40"
            />
            <button
              type="submit"
              disabled={!feedback.trim()}
              className="shrink-0 text-[var(--pane-terminal)] disabled:opacity-30 transition-opacity hover:opacity-70"
            >
              send
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Plan approval mode ─────────────────────────────────────────────────────
  return (
    <div className="px-4 pb-3">
      <div
        className="rounded-xl bg-pane-surface/60 ring-1 ring-pane-border/20 px-4 py-3 font-mono animate-fade-in"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        <div className="flex items-center gap-3">
          <span
            className="shrink-0 opacity-60"
            style={{ color: "var(--pane-terminal)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            plan
          </span>

          {mode === "default" ? (
            <div className="flex items-center gap-3 flex-1">
              <span className="text-pane-text-secondary truncate">
                review the plan above, then approve or request changes
              </span>
              <div className="flex gap-3 shrink-0 ml-auto">
                <button
                  onClick={handleApprove}
                  className="text-[var(--pane-status-added)] hover:opacity-70 transition-opacity"
                >
                  approve
                </button>
                <button
                  onClick={handleReject}
                  className="text-pane-text-secondary hover:text-pane-text transition-colors"
                >
                  request changes
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); handleReject(); }}
              className="flex gap-2 items-center flex-1"
            >
              <input
                ref={inputRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="what should change?"
                className="flex-1 bg-transparent outline-none text-pane-text placeholder:text-pane-text-secondary/40"
              />
              <button
                type="submit"
                disabled={!feedback.trim()}
                className="shrink-0 text-[var(--pane-terminal)] disabled:opacity-30 transition-opacity hover:opacity-70"
              >
                send
              </button>
              <button
                type="button"
                onClick={() => setMode("default")}
                className="shrink-0 text-pane-text-secondary/40 hover:text-pane-text-secondary transition-colors"
              >
                cancel
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
