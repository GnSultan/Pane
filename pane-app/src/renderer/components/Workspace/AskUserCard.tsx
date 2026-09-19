/**
 * In-flow marker for a suspended ask_user turn.
 *
 * The backend pauses the tool loop after ask_user (awaiting_input event) and
 * resumes when the next user message arrives. The question itself already
 * renders as a normal assistant message right above this marker — so the
 * marker never repeats it. It is only the suspended-turn signal in the
 * conversation flow: the agent's move ended with a question, the next move
 * is yours, typed in the main input.
 */
export function AskUserCard() {
  return (
    <div className="mb-10 flex flex-col items-start animate-fadeIn">
      <div
        className="inline-flex items-center gap-2.5 font-mono text-pane-text-secondary"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="shrink-0"
        >
          <circle
            cx="12"
            cy="12"
            r="7"
            fill="none"
            className="animate-circle-pulse"
          />
        </svg>
        <span>waiting for your answer</span>
      </div>
    </div>
  );
}
