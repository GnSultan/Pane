import { useState, useCallback } from "react";
import type {
  ConversationMessage,
  ToolUseBlock,
  ToolResultBlock,
} from "../../lib/claude-types";
import { ToolActivity } from "./ToolActivity";
import { MarkdownText } from "./MarkdownText";

function getMessageText(message: ConversationMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

function CopyButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`opacity-0 group-hover:opacity-100 btn-press
        w-7 h-7 flex items-center justify-center rounded shrink-0
        ${copied
          ? "text-pane-text-secondary"
          : "text-pane-text-secondary/30 hover:text-pane-text-secondary hover:bg-pane-text/[0.06]"
        }`}
      title="Copy"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 8.5 6.5 12 13 4" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
          <path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
        </svg>
      )}
    </button>
  );
}

interface MessageBubbleProps {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
}

export function MessageBubble({ message, toolResults }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = getMessageText(message);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [message]);

  if (message.type === "user") {
    const text = getMessageText(message);

    return (
      <div className="mb-10 group animate-fadeSlideUp">
        <p
          className="text-pane-text font-mono leading-[1.75] whitespace-pre-wrap"
          style={{ fontSize: "var(--pane-font-size)", maxWidth: "65ch" }}
        >
          {text}
        </p>
        <div className="flex justify-end mt-1">
          <CopyButton onClick={handleCopy} copied={copied} />
        </div>
      </div>
    );
  }

  // System messages (tool results) are hidden — matched to their parent tool_use
  if (message.type === "system") {
    return null;
  }

  if (message.type === "assistant") {
    // Group consecutive blocks by type: text blocks get the conversation border,
    // tool_use blocks break out with their own terminal accent
    const groups: { type: "text" | "tools"; blocks: typeof message.content }[] = [];
    for (const block of message.content) {
      const groupType = block.type === "tool_use" ? "tools" : "text";
      const last = groups[groups.length - 1];
      if (last && last.type === groupType) {
        last.blocks.push(block);
      } else {
        groups.push({ type: groupType, blocks: [block] });
      }
    }

    const hasText = message.content.some((b) => b.type === "text");

    return (
      <div className={`group animate-fadeSlideUp ${hasText ? "mb-10" : "mb-1"}`}>
        {groups.map((group, gi) => {
          if (group.type === "text") {
            return (
              <div key={gi} className="border-l-2 border-pane-text/20 pl-6 font-sans font-light">
                {group.blocks.map((block, i) => {
                  const text = (block as { type: "text"; text: string }).text;
                  const isLastBlock = gi === groups.length - 1 && i === group.blocks.length - 1;
                  return (
                    <div key={i}>
                      <MarkdownText text={text} />
                      {message.isStreaming && isLastBlock && (
                        <span className="inline-block w-[2px] h-[14px] bg-pane-text/70 ml-0.5 align-middle animate-pulse" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          }

          return (
            <div key={gi} className="my-0.5">
              {group.blocks.map((block, i) => {
                const toolBlock = block as ToolUseBlock;
                const result = toolResults.get(toolBlock.id);
                return (
                  <ToolActivity key={i} toolUse={toolBlock} toolResult={result} />
                );
              })}
            </div>
          );
        })}

        {/* Footer: cost/duration + copy */}
        {!message.isStreaming && (
          <div className="mt-4 flex items-center gap-4 pl-6">
            {(message.costUsd !== undefined || message.durationMs !== undefined) && (
              <div className="flex gap-4 text-[10px] font-mono text-pane-text-secondary/50 tracking-wider">
                {message.costUsd !== undefined && (
                  <span>${message.costUsd.toFixed(4)}</span>
                )}
                {message.durationMs !== undefined && (
                  <span>{(message.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
            )}
            <div className="ml-auto">
              <CopyButton onClick={handleCopy} copied={copied} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}
