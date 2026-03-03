import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ConversationMessage,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
} from "../../lib/claude-types";
import { restoreCheckpoint, getCheckpointDiff } from "../../lib/tauri-commands";
import type { CheckpointDiffFile } from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import { setRestoreInProgress } from "../../hooks/useFileWatcher";
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

function CheckpointIndicator({
  checkpointId,
  projectId,
}: {
  checkpointId: string;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<CheckpointDiffFile[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const isProcessing = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.isProcessing ?? false,
  );

  const handleExpand = async () => {
    if (restored) return;
    if (!expanded) {
      setExpanded(true);
      const project = useProjectsStore.getState().projects.get(projectId);
      if (project) {
        try {
          const d = await getCheckpointDiff(projectId, checkpointId, project.root);
          setDiff(d.files);
        } catch {
          setDiff([]);
        }
      }
    } else {
      setExpanded(false);
    }
  };

  const handleRestore = async () => {
    if (restoring || isProcessing) return;
    const project = useProjectsStore.getState().projects.get(projectId);
    if (!project) return;

    setRestoring(true);
    setRestoreInProgress(true);
    try {
      await restoreCheckpoint(projectId, checkpointId, project.root);
      setRestored(true);
    } finally {
      setRestoring(false);
      setTimeout(() => setRestoreInProgress(false), 1000);
    }
  };

  if (restored) {
    return (
      <div className="flex items-center gap-1.5 mt-1.5 mr-1">
        <span
          className="text-pane-text-secondary/50 font-mono"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          files restored
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5 mr-1">
      <button
        onClick={handleExpand}
        className="flex items-center gap-1 text-pane-text-secondary/40
                   hover:text-pane-text-secondary font-mono btn-press"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        <span className="w-1 h-1 rounded-full" style={{ background: "var(--pane-terminal)" }} />
        checkpoint
      </button>
      {expanded && diff !== null && (
        <>
          {diff.length > 0 ? (
            <>
              <span
                className="text-pane-text-secondary/40 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                {diff.length} file{diff.length !== 1 ? "s" : ""} changed
              </span>
              <button
                onClick={handleRestore}
                disabled={restoring || isProcessing}
                className="text-pane-status-modified hover:text-pane-text font-mono btn-press
                           disabled:opacity-30 disabled:pointer-events-none"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                {restoring ? "restoring..." : "restore"}
              </button>
            </>
          ) : (
            <span
              className="text-pane-text-secondary/40 font-mono"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              no changes
            </span>
          )}
        </>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
  projectId: string;
}

export function MessageBubble({ message, toolResults, projectId }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  // Only animate on first mount — not when scrolling through old messages
  const isNewRef = useRef(true);
  useEffect(() => { isNewRef.current = false; }, []);
  const animClass = isNewRef.current ? "animate-fadeSlideUp" : "";

  // Graceful completion: track when streaming just ended to add settle animation
  const wasStreamingRef = useRef(message.isStreaming);
  const [justCompleted, setJustCompleted] = useState(false);

  useEffect(() => {
    if (wasStreamingRef.current && !message.isStreaming) {
      // Streaming just ended — trigger settle state
      setJustCompleted(true);
      const timer = setTimeout(() => setJustCompleted(false), 600);
      return () => clearTimeout(timer);
    }
    wasStreamingRef.current = message.isStreaming;
  }, [message.isStreaming]);

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
          className="px-5 py-4 rounded-3xl ring-1 ring-pane-border/40"
          style={{ maxWidth: "65ch" }}
        >
          <p
            className="text-pane-text font-mono leading-[1.75] whitespace-pre-wrap"
            style={{ fontSize: "var(--pane-font-size)" }}
          >
            {text}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 mt-1">
          {message.checkpointId && (
            <CheckpointIndicator checkpointId={message.checkpointId} projectId={projectId} />
          )}
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

    // Group consecutive text/thinking blocks, but tools always get their own group
    type GroupType = "text" | "tool" | "thinking";
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
        groupType = "tool";
      } else {
        groupType = "text";
      }
      const last = groups[groups.length - 1];
      // Only group consecutive text or thinking blocks together
      // Tools always get their own group (one tool per line)
      if (last && last.type === groupType && groupType !== "tool") {
        last.blocks.push(block);
      } else {
        groups.push({ type: groupType, blocks: [block] });
      }
    }

    const hasText = message.content.some((b) => b.type === "text");

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
                  return (
                    <div key={i}>
                      <MarkdownText text={text} isStreaming={message.isStreaming} />
                    </div>
                  );
                })}
              </div>
            );
          }

          // tool group (each tool has its own group, one per line)
          const block = group.blocks[0]!;
          if (block.type === "tool_use") {
            const toolBlock = block as ToolUseBlock;
            const result = toolResults.get(toolBlock.id);
            return (
              <div key={toolBlock.id} className="my-0.5">
                <ToolActivity
                  toolUse={toolBlock}
                  toolResult={result}
                />
              </div>
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
              <div key={serverBlock.id} className="my-0.5">
                <ServerToolActivity
                  block={serverBlock}
                  searchResult={searchResult}
                />
              </div>
            );
          }
          // web_search_tool_result rendered by its parent server_tool_use
          return null;
        })}

        {/* Footer: cost/duration/tokens + copy */}
        {!message.isStreaming && (
          <div
            className={`mt-4 flex items-center gap-4 pl-6 transition-opacity duration-500 ${
              justCompleted ? "opacity-0" : "opacity-100"
            }`}
          >
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
