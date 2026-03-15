import { useState } from "react";
import type { ThinkingBlock } from "../../lib/claude-types";
import { MarkdownText } from "./MarkdownText";

interface ThinkingBlockProps {
  block: ThinkingBlock;
  isStreaming: boolean;
}

export function ThinkingBlockDisplay({ block, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const thinkingText = block.thinking;

  if (!thinkingText.trim() && !isStreaming) return null;

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
          className={`w-1 h-1 rounded-full shrink-0 ${isStreaming ? "animate-fadeIn" : ""}`}
          style={{
            backgroundColor: isStreaming
              ? "color-mix(in srgb, var(--pane-text-secondary) 60%, transparent)"
              : "color-mix(in srgb, var(--pane-text-secondary) 25%, transparent)",
            animation: isStreaming ? "breathe 4s ease-in-out infinite" : "none",
          }}
        />
        <span className="opacity-50">thinking</span>
        {isStreaming && (
          <span
            className="inline-block w-[2px] h-[10px] bg-pane-text-secondary/40 ml-0.5"
            style={{ animation: "breathe 3s ease-in-out infinite" }}
          />
        )}
      </button>

      {expanded && (
        <div
          className="mt-1 mb-2 pl-3 border-l border-pane-text-secondary/15
                     text-pane-text-secondary/50 font-mono leading-[1.7]
                     max-h-[300px] overflow-y-auto"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          <MarkdownText text={thinkingText} isStreaming={isStreaming} />
          {isStreaming && (
            <span
              className="inline-block w-[2px] h-[10px] bg-pane-text-secondary/40 ml-0.5"
              style={{ animation: "breathe 3s ease-in-out infinite" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
