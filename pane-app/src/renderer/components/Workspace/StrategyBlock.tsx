import { useState } from "react";
import type { StrategyBlock } from "../../lib/claude-types";

function modelShortName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus"))   return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku"))  return "haiku";
  if (lower.includes("flash"))  return "flash";
  if (lower.includes("o3"))     return "o3";
  if (lower.includes("o4"))     return "o4-mini";
  if (lower.includes("gpt-4o")) return "gpt-4o";
  if (lower.includes("pro"))    return "pro";
  if (lower.includes("r1"))     return "r1";
  const slug = model.split("/").pop() || model;
  return slug.split("-").slice(0, 2).join("-");
}

const TASK_TYPE_LABEL: Record<string, string> = {
  debug:          "debugging",
  implement:      "implementation",
  explain:        "explanation",
  architect:      "architecture",
  refactor:       "refactoring",
  review:         "code review",
  conversation:   "conversation",
  "quick-answer": "quick answer",
  other:          "general task",
};

const COMPLEXITY_LABEL: Record<string, string> = {
  low:    "straightforward",
  medium: "moderate complexity",
  high:   "high complexity",
};

function humanSummary(block: StrategyBlock): string {
  const model = modelShortName(block.model);
  const lines: string[] = [];

  // Local intelligence path — Qwen produced a real decision
  if (block.localIntelUsed && block.localTaskType) {
    const taskLabel = TASK_TYPE_LABEL[block.localTaskType] ?? block.localTaskType;
    const complexityLabel = block.localComplexity ? COMPLEXITY_LABEL[block.localComplexity] ?? block.localComplexity : null;

    // Lead with what Qwen actually understood
    const desc = complexityLabel ? `${complexityLabel} ${taskLabel}` : taskLabel;

    if (block.mode === "orchestrate") {
      lines.push(`${desc} — breaking into steps before executing with ${model}.`);
      if (block.discovery) lines.push("Checking scope before committing — the task boundaries aren't fully clear yet.");
    } else if (block.mode === "discuss") {
      lines.push(`${desc} — treating as a conversation with ${model}.`);
      if (block.discovery) lines.push("This could shift direction, keeping it open.");
    } else {
      lines.push(`${desc} — executing directly with ${model}.`);
    }

    // Surface atom hints: what the brain flagged as relevant context
    if (block.localAtomHints && block.localAtomHints.length > 0) {
      lines.push(`Context pulled: ${block.localAtomHints.join(", ")}.`);
    }

    // Reasoning depth
    if (block.reasoning === "deep") {
      lines.push("Thinking this through carefully before responding.");
    }
  } else {
    // Heuristic fallback path — no Qwen decision
    if (block.mode === "orchestrate") {
      lines.push(
        `Breaking this into a plan first, then executing with ${model}.` +
        (block.discovery ? " Checking alignment before starting." : "")
      );
    } else if (block.mode === "discuss") {
      lines.push(`Conversation with ${model}.`);
    } else {
      lines.push(`Direct execution with ${model}.`);
    }
    if (block.reasoning === "deep") lines.push("Deep reasoning mode.");
  }

  // Oracle override — always surface if it changed the model
  if (block.oracleUsed && block.oracleConfidence != null) {
    if (block.oracleExploring) {
      lines.push(`Trying ${model} on this type of task — gathering performance data.`);
    } else {
      const pct = Math.round(block.oracleConfidence * 100);
      lines.push(`${model} chosen from prior performance on similar tasks (${pct}% confidence).`);
    }
  }

  return lines.join(" ");
}

export function StrategyBlockDisplay({ block }: { block: StrategyBlock }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left px-0.5 py-0.5 group"
      >
        {/* Faint label — same register as thinking blocks */}
        <span
          className="font-mono text-pane-text-secondary/30 group-hover:text-pane-text-secondary/50 transition-colors"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          pane route
        </span>
        <span
          className="font-mono text-pane-text-secondary/15 group-hover:text-pane-text-secondary/30 transition-colors"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      {expanded && (
        <div
          className="mt-1 ml-0.5 px-3 py-2.5 rounded-md bg-pane-text/[0.02] border border-pane-text-secondary/[0.06]"
        >
          <p
            className="font-mono text-pane-text-secondary/50 leading-relaxed"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {humanSummary(block)}
          </p>
        </div>
      )}
    </div>
  );
}
