import { useState } from "react";
import type { ThinkingBlock } from "../../lib/claude-types";

interface ThinkingBlockProps {
  block: ThinkingBlock;
  isStreaming: boolean;
}

export function ThinkingBlockDisplay({ block, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const thinkingText = block.thinking;

  if (!thinkingText.trim() && !isStreaming) return null;

  const firstLine = thinkingText.split("\n").find((l) => l.trim().length > 0) || "";
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-pane-text-secondary/50 font-mono
                   hover:text-pane-text-secondary w-full text-left
                   h-5 leading-none"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        <span
          className={`w-1 h-1 rounded-full shrink-0 ${isStreaming ? "animate-pulse" : ""}`}
          style={{
            backgroundColor: isStreaming
              ? "color-mix(in srgb, var(--pane-text-secondary) 60%, transparent)"
              : "color-mix(in srgb, var(--pane-text-secondary) 25%, transparent)",
          }}
        />
        <span className="shrink-0 opacity-50">thinking</span>
        {!expanded && <span className="truncate opacity-40">{preview}</span>}
        {isStreaming && !expanded && (
          <span className="inline-block w-[2px] h-[10px] bg-pane-text-secondary/40 ml-0.5 animate-pulse" />
        )}
      </button>

      {expanded && (
        <div
          className="mt-1 mb-2 pl-3 border-l border-pane-text-secondary/15
                     text-pane-text-secondary/50 font-mono leading-[1.7]
                     max-h-[300px] overflow-y-auto whitespace-pre-wrap"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {thinkingText}
          {isStreaming && (
            <span className="inline-block w-[2px] h-[10px] bg-pane-text-secondary/40 ml-0.5 animate-pulse" />
          )}
        </div>
      )}
    </div>
  );
}
