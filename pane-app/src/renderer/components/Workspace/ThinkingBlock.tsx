import { useRef, useEffect, useState } from "react";
import type { ThinkingBlock } from "../../lib/punk-types";
import { MarkdownText } from "./MarkdownText";
import { MicroIndicator } from "../shared";

interface ThinkingBlockProps {
  block: ThinkingBlock;
  isStreaming: boolean;
}

/**
 * Renders LLM thinking/reasoning blocks as muted text.
 * No redundant "thinking" label — just subtle reasoning context.
 */
export function ThinkingBlockDisplay({
  block,
  isStreaming,
}: ThinkingBlockProps) {
  const thinkingText = block.thinking;
  const contentRef = useRef<HTMLDivElement>(null);
  const [userToggle, setUserToggle] = useState<boolean | null>(null);

  // Start collapsed by default, user can expand to see thinking
  const isExpanded = userToggle !== null ? userToggle : false;

  // Breathing animation during streaming when collapsed
  const [isBreathing, setIsBreathing] = useState(isStreaming);
  useEffect(() => {
    setIsBreathing(isStreaming && !isExpanded);
  }, [isStreaming, isExpanded]);

  // Internal auto-scroll for the thinking block itself
  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [thinkingText, isStreaming]);

  if (!thinkingText.trim() && !isStreaming) return null;

  return (
    <div
      className={`group rounded-md border transition-all duration-200 ${isExpanded ? 'border-[var(--pane-border-soft)] bg-[var(--pane-bg)] mb-6' : 'border-transparent hover:border-[var(--pane-border-soft)] mb-4'}`}
    >
      <button
        onClick={() => setUserToggle(!isExpanded)}
        className="flex items-center gap-2.5 h-12 leading-none px-6 hover:text-pane-text transition-colors w-full text-left"
        style={{ minHeight: '3rem' }}
      >
        <MicroIndicator
          variant={isStreaming ? "strong" : "subtle"}
          animate={isStreaming}
          size={5}
          ariaLabel="contemplating"
        />
        <span
          className="font-mono mr-1"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          <span
            className={
              isBreathing
                ? "text-pane-text-secondary/40 animate-pulse"
                : "text-pane-text-secondary/30"
            }
          >
            contemplating
          </span>
        </span>
        <span 
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {isExpanded ? "collapse" : "expand"}
        </span>
      </button>

      {isExpanded && (
        <div
          ref={contentRef}
          className="px-10 py-8 space-y-3
                     text-pane-text-secondary/60 leading-[1.8]
                     max-h-[500px] overflow-y-auto selection:bg-pane-text-secondary/10"
          style={{
            fontSize: "var(--pane-font-size-sm)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <MarkdownText
            text={thinkingText}
            isStreaming={isStreaming}
            isThinking
          />
        </div>
      )}
    </div>
  );
}
