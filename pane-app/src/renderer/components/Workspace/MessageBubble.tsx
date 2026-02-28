import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ConversationMessage,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
} from "../../lib/claude-types";
import { ToolActivity, ServerToolActivity } from "./ToolActivity";
import { MarkdownText } from "./MarkdownText";
import { ThinkingBlockDisplay } from "./ThinkingBlock";

// No CSS containment — content-visibility: auto causes visible pop-in stutter
// when messages scroll into view, which is worse than the layout cost it saves.
// With memo'd React components, the DOM is stable and scroll is compositor-driven.

function getMessageText(message: ConversationMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function CopyButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`opacity-0 group-hover:opacity-100 btn-press
        w-7 h-7 flex items-center justify-center rounded shrink-0
        ${copied
          ? "text-pane-text-secondary"
          : "text-pane-text-secondary/50 hover:text-pane-text-secondary hover:bg-pane-text/[0.06]"
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
  // Only animate on first mount — not when scrolling through old messages
  const isNewRef = useRef(true);
  useEffect(() => { isNewRef.current = false; }, []);
  const animClass = isNewRef.current ? "animate-fadeSlideUp" : "";

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
      <div className={`mb-10 group flex flex-col items-end ${animClass}`}>
        <div
          className="px-5 py-4 bg-pane-surface rounded-lg"
          style={{ maxWidth: "65ch" }}
        >
          <p
            className="text-pane-text font-mono leading-[1.75] whitespace-pre-wrap"
            style={{ fontSize: "var(--pane-font-size)" }}
          >
            {text}
          </p>
        </div>
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
    // Filter out TodoWrite tool calls — they render in TodoPanel only
    const filteredContent = message.content.filter(
      (b) => b.type !== "tool_use" || (b as ToolUseBlock).name !== "TodoWrite"
    );

    // Group consecutive blocks by type: text, tools, or thinking
    type GroupType = "text" | "tools" | "thinking";
    const groups: { type: GroupType; blocks: typeof message.content }[] = [];
    for (const block of filteredContent) {
      let groupType: GroupType;
      if (block.type === "thinking") {
        groupType = "thinking";
      } else if (
        block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "web_search_tool_result"
      ) {
        groupType = "tools";
      } else {
        groupType = "text";
      }
      const last = groups[groups.length - 1];
      if (last && last.type === groupType) {
        last.blocks.push(block);
      } else {
        groups.push({ type: groupType, blocks: [block] });
      }
    }

    const hasText = message.content.some((b) => b.type === "text");

    // Collect all tool_use block IDs to determine which are "last 3"
    const allToolUseIds: string[] = [];
    for (const block of filteredContent) {
      if (block.type === "tool_use") allToolUseIds.push((block as ToolUseBlock).id);
    }
    const recentToolIds = new Set(allToolUseIds.slice(-3));

    return (
      <div className={`group ${animClass} ${hasText ? "mb-10" : "mb-1"}`}>
        {groups.map((group, gi) => {
          if (group.type === "thinking") {
            return (
              <div key={gi}>
                {group.blocks.map((block, i) => (
                  <ThinkingBlockDisplay
                    key={i}
                    block={block as ThinkingBlock}
                    isStreaming={message.isStreaming}
                  />
                ))}
              </div>
            );
          }

          if (group.type === "text") {
            return (
              <div key={gi} className="font-sans" style={{ fontWeight: "var(--pane-font-weight)" }}>
                {group.blocks.map((block, i) => {
                  const text = (block as { type: "text"; text: string }).text;
                  const isLastBlock = gi === groups.length - 1 && i === group.blocks.length - 1;
                  return (
                    <div key={i}>
                      <MarkdownText text={text} isStreaming={message.isStreaming} />
                      {message.isStreaming && isLastBlock && (
                        <span className="inline-block w-[2px] h-[14px] bg-pane-text/70 ml-0.5 align-middle animate-pulse" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          }

          // tools group
          return (
            <div key={gi} className="my-0.5">
              {group.blocks.map((block) => {
                if (block.type === "tool_use") {
                  const toolBlock = block as ToolUseBlock;
                  const result = toolResults.get(toolBlock.id);
                  return (
                    <ToolActivity
                      key={toolBlock.id}
                      toolUse={toolBlock}
                      toolResult={result}
                      forceExpanded={recentToolIds.has(toolBlock.id)}
                    />
                  );
                }
                if (block.type === "server_tool_use") {
                  const serverBlock = block as ServerToolUseBlock;
                  // Find matching web_search_tool_result in the same message
                  const searchResult = message.content.find(
                    (b) =>
                      b.type === "web_search_tool_result" &&
                      (b as WebSearchToolResultBlock).tool_use_id === serverBlock.id,
                  ) as WebSearchToolResultBlock | undefined;
                  return (
                    <ServerToolActivity
                      key={serverBlock.id}
                      block={serverBlock}
                      searchResult={searchResult}
                    />
                  );
                }
                // web_search_tool_result rendered by its parent server_tool_use
                return null;
              })}
            </div>
          );
        })}

        {/* Footer: cost/duration/tokens + copy */}
        {!message.isStreaming && (
          <div className="mt-4 flex items-center gap-4 pl-6">
            {(message.costUsd !== undefined || message.durationMs !== undefined) && (
              <div className="flex gap-4 text-[10px] font-mono text-pane-text-secondary tracking-wider">
                {message.costUsd !== undefined && (
                  <span>${message.costUsd.toFixed(4)}</span>
                )}
                {message.durationMs !== undefined && (
                  <span>{(message.durationMs / 1000).toFixed(1)}s</span>
                )}
                {message.inputTokens !== undefined && message.outputTokens !== undefined && (
                  <span>
                    {formatTokenCount(message.inputTokens)} in / {formatTokenCount(message.outputTokens)} out
                  </span>
                )}
                {message.numTurns !== undefined && message.numTurns > 1 && (
                  <span>{message.numTurns} turns</span>
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
