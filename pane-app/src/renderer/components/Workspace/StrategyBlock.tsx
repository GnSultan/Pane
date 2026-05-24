import { useState } from "react";
import type { StrategyBlock } from "../../lib/punk-types";
import { MicroIndicator } from "../shared";

const ESCALATION_RECOVERY: Record<string, string[]> = {
  debug: [
    "Verifying every assumption before acting — no guessing at the fix until the cause is confirmed.",
    "Root cause analysis: tracing what invariant broke and where, walking backward from the failure.",
    "Reading the full call chain cold, separating what's known from what's assumed.",
    "Adversarial audit of every prior assumption — the answer is likely in a cross-component interaction.",
  ],
  architect: [
    "Stepping back from the code — reasoning about system boundaries and responsibilities first.",
    "Mapping what changes downstream before proposing anything — working backward from consequences.",
    "Fresh design perspective: reading every module in scope, then asking what the ideal shape looks like.",
    "Full system audit before touching anything — real architecture vs. ideal, minimum viable path to close the gap.",
  ],
  implement: [
    "Reading the actual contracts and interfaces before writing — implementing to what's real, not assumed.",
    "Mapping every caller and dependency — no assumptions about what's safe to rely on.",
    "Tracing every place this touches before writing a line.",
    "Starting from scratch with a cold read — deriving the implementation from observation, not memory.",
  ],
  refactor: [
    "Defining exactly what behavior must be preserved — semantic equivalence as the hard constraint.",
    "Finding every caller and verifying actual usages before touching anything.",
    "Building a complete call graph and reading the tests — every invariant accounted for.",
    "Full reference audit — no change is safe until every dependency is mapped.",
  ],
  explain: [
    "Rebuilding the explanation from first principles — simplest true statement first.",
    "Completely different framing — whatever angle was tried before, going the other way.",
    "Identifying what prerequisite understanding is missing and starting one level below that.",
    "Abandoning all previous framings and finding the one question that makes everything else obvious.",
  ],
};

const DEFAULT_RECOVERY = [
  "Approaching this from a different angle — not more effort, a different model of the problem.",
  "Re-examining what the problem actually is before acting.",
  "Reading everything relevant cold, deriving from what's observed rather than what's remembered.",
  "Full audit of every prior assumption before anything else.",
];

function escalationDetail(block: StrategyBlock): string {
  const domain = block.localTaskType ?? null;
  const tier   = block.escalationLevel ?? 1;
  const shifts = (domain && ESCALATION_RECOVERY[domain]) ? ESCALATION_RECOVERY[domain] : DEFAULT_RECOVERY;
  return shifts[Math.min(tier - 1, shifts.length - 1)] ?? shifts[0] ?? "";
}

export function StrategyBlockDisplay({ block }: { block: StrategyBlock }) {
  const [expanded, setExpanded] = useState(false);
  const escalation  = block.escalationLevel ?? 0;
  const isEscalated = escalation >= 1;

  const reason = block.reason
    ? (block.reason.endsWith(".") ? block.reason.slice(0, -1) : block.reason)
    : null;

  const expandedText = [
    reason,
    isEscalated ? escalationDetail(block) : null,
  ].filter(Boolean).join("\n\n");

  return (
    <div
      className={`group rounded-md border transition-all duration-200 ${
        expanded
          ? "border-[var(--pane-border-soft)] bg-[var(--pane-bg)] mb-6"
          : "border-transparent hover:border-[var(--pane-border-soft)] mb-4"
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 h-12 leading-none px-6 hover:text-pane-text transition-colors w-full text-left"
        style={{ minHeight: "3rem" }}
      >
        <MicroIndicator variant="subtle" animate={false} size={5} ariaLabel="pane reasoner" />
        <span
          className="font-mono mr-1"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          <span className="text-pane-text-secondary/20">pane</span>
          <span className="text-pane-text-secondary/30"> reasoner</span>
        </span>
        <span
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && (
        <div
          className="px-10 py-8 space-y-3
                     text-pane-text-secondary/60 leading-[1.8]
                     max-h-[500px] overflow-y-auto selection:bg-pane-text-secondary/10"
          style={{
            fontSize: "var(--pane-font-size-sm)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {expandedText}
        </div>
      )}
    </div>
  );
}
