import type { PlanData, PlanStep } from "../../lib/claude-types";

// Type tag colors follow terminal accent for machine-produced context
const TYPE_STYLES: Record<PlanStep["type"], { label: string; className: string }> = {
  read:   { label: "read",   className: "text-[var(--pane-terminal)]" },
  write:  { label: "write",  className: "text-pane-status-modified" },
  verify: { label: "verify", className: "text-pane-status-added" },
  plan:   { label: "plan",   className: "text-pane-text-secondary/60" },
};

function StepRow({ step }: { step: PlanStep }) {
  const tag = TYPE_STYLES[step.type] ?? TYPE_STYLES.plan;

  return (
    <div className="flex items-start gap-3 py-1.5">
      {/* Step number */}
      <span
        className="shrink-0 text-pane-text-secondary/40 font-mono tabular-nums w-4 text-right mt-px"
        style={{ fontSize: "11px" }}
      >
        {step.index}
      </span>

      {/* Type tag */}
      <span
        className={`shrink-0 font-mono uppercase tracking-wider mt-px ${tag.className}`}
        style={{ fontSize: "10px", minWidth: "36px" }}
      >
        {tag.label}
      </span>

      {/* Action */}
      <div className="flex-1 min-w-0">
        <span
          className="text-pane-text leading-relaxed"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {step.action}
        </span>
        {step.files.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {step.files.map((f) => (
              <span
                key={f}
                className="font-mono text-pane-text-secondary/50 truncate"
                style={{ fontSize: "10px" }}
              >
                {f.split("/").pop()}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PlanBlockProps {
  planData: PlanData;
}

export function PlanBlock({ planData }: PlanBlockProps) {
  return (
    <div className="my-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="font-mono text-[var(--pane-terminal)] uppercase tracking-wider"
          style={{ fontSize: "10px" }}
        >
          plan
        </span>
        <span
          className="text-pane-text-secondary/40 font-mono"
          style={{ fontSize: "10px" }}
        >
          {planData.steps.length} steps
        </span>
        {planData.planningModel && (
          <span
            className="ml-auto text-pane-text-secondary/30 font-mono"
            style={{ fontSize: "10px" }}
          >
            {planData.planningModel}
          </span>
        )}
      </div>

      {/* Task summary */}
      <p
        className="text-pane-text font-mono mb-3"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        {planData.task}
      </p>

      {/* Steps */}
      <div className="border-l-2 border-pane-border/40 pl-3 space-y-0">
        {planData.steps.map((step) => (
          <StepRow key={step.index} step={step} />
        ))}
      </div>

      {/* Execution model hint */}
      {planData.executionModel && (
        <p
          className="mt-2 text-pane-text-secondary/30 font-mono"
          style={{ fontSize: "10px" }}
        >
          executing with {planData.executionModel}
        </p>
      )}
    </div>
  );
}
