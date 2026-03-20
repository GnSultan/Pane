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

function humanSummary(block: StrategyBlock): string {
  const model = modelShortName(block.model);
  const lines: string[] = [];

  // What pane is doing and with which model
  if (block.mode === "orchestrate") {
    lines.push(
      `Breaking this into a plan first, then executing with ${model}.` +
      (block.discovery
        ? " Checking alignment before starting — the direction needs a bit more clarity."
        : " The scope is large enough to benefit from a structured approach.")
    );
  } else if (block.mode === "discuss") {
    lines.push(
      block.discovery
        ? `Treating this as a conversation with ${model}, with the current task in mind — this looks like it could shift direction.`
        : `Having a conversation with ${model}. No code changes expected right now.`
    );
  } else {
    // direct
    lines.push(`Answering directly with ${model}.`);
  }

  // Oracle insight — only if it actually overrode the heuristic
  if (block.oracleUsed && block.oracleConfidence != null) {
    if (block.oracleExploring) {
      lines.push(`Trying ${model} here — testing whether it handles this type of work well.`);
    } else {
      const pct = Math.round(block.oracleConfidence * 100);
      lines.push(`${model} was chosen based on past performance on similar tasks (${pct}% confidence).`);
    }
  }

  // Reasoning depth — only mention if it's notable
  if (block.reasoning === "deep" && block.mode !== "discuss") {
    lines.push("Taking time to think this through carefully.");
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
