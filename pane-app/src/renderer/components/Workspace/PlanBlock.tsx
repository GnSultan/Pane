import { useState } from "react";
import type { PlanData, PlanStep } from "../../lib/claude-types";
import { MicroIndicator } from "../shared";

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
      <span
        className="shrink-0 text-pane-text-secondary/40 font-mono tabular-nums w-4 text-right mt-px"
        style={{ fontSize: "11px" }}
      >
        {step.index}
      </span>
      <span
        className={`shrink-0 font-mono uppercase tracking-wider mt-px ${tag.className}`}
        style={{ fontSize: "10px", minWidth: "36px" }}
      >
        {tag.label}
      </span>
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
  const [expanded, setExpanded] = useState(false);

  const stepCount = planData.steps.length;
  const summary = planData.task.length > 72
    ? planData.task.slice(0, 72) + "…"
    : planData.task;

  return (
    <div
      className={`rounded-md border transition-all duration-200 ${
        expanded
          ? "border-[var(--pane-border-soft)] bg-[var(--pane-bg)] mb-2"
          : "border-transparent hover:border-[var(--pane-border-soft)] mb-0.5"
      }`}
    >
      {/* Header row — always visible, collapses/expands on click */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-4 group"
        style={{ fontSize: "var(--pane-font-size-sm)", minHeight: "2.5rem" }}
      >
        <MicroIndicator variant="subtle" size={5} ariaLabel="plan ready" />
        <span className="shrink-0 opacity-70" style={{ color: "var(--pane-terminal)" }}>
          plan
        </span>
        <span className="truncate">{summary}</span>
        <span className="shrink-0 text-pane-text-secondary/40 ml-1">
          {stepCount} {stepCount === 1 ? "step" : "steps"}
        </span>
        {planData.planningModel && (
          <span className="shrink-0 text-pane-text-secondary/30 ml-1">
            {planData.planningModel.split("/").pop()}
          </span>
        )}
        <span
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-pane-text-secondary/10 px-4 py-3">
          {/* Steps */}
          <div className="border-l-2 border-pane-border/40 pl-3 space-y-0">
            {planData.steps.map((step) => (
              <StepRow key={step.index} step={step} />
            ))}
          </div>

          {/* Execution model */}
          {planData.executionModel && (
            <p
              className="mt-3 text-pane-text-secondary/30 font-mono"
              style={{ fontSize: "10px" }}
            >
              executing with {planData.executionModel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
