import { useState, useRef, useEffect, useCallback } from "react";

interface AskUserCardProps {
  projectId: string;
  toolId: string;
  question: string | null;
  /** Sends the answer through the normal message path — same as typing in InputBar. */
  onReply?: (message: string) => void;
}

/**
 * Renders when the agent pauses on ask_user and waits for the user's answer.
 *
 * The http backend's tool loop pauses after ask_user (awaiting_input event)
 * and resumes when the next user message arrives — so the answer is just a
 * normal message. onReply is wired to the conversation's send path.
 */
export function AskUserCard({ question, onReply }: AskUserCardProps) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input as soon as the card mounts — the agent is waiting.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const respond = useCallback(
    (response: string) => {
      if (submitted) return;
      setSubmitted(true);
      // pendingInput is cleared by the send path once the user message lands —
      // not here — so the card can't outlive its answer.
      onReply?.(response);
    },
    [submitted, onReply],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!answer.trim()) return;
    respond(answer.trim());
  };

  if (submitted) return null;

  return (
    <div className="px-4 pb-3">
      <div
        className="rounded-xl bg-pane-surface/60 ring-1 ring-pane-border/20 px-4 py-3 font-mono animate-fade-in"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <span
            className="shrink-0 opacity-60"
            style={{
              color: "var(--pane-terminal)",
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            your move
          </span>
        </div>
        {question && (
          <div className="text-pane-text mb-3 leading-[1.6] whitespace-pre-wrap">
            {question}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-2 items-center">
          <input
            ref={inputRef}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="type your answer"
            className="flex-1 bg-transparent outline-none text-pane-text placeholder:text-pane-text-secondary/40"
          />
          <button
            type="submit"
            disabled={!answer.trim()}
            className="shrink-0 text-[var(--pane-terminal)] disabled:opacity-30 transition-opacity hover:opacity-70"
          >
            send
          </button>
        </form>
      </div>
    </div>
  );
}
