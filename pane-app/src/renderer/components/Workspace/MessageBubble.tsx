import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ConversationMessage,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  JsonBlock,
  ArbiterVerdict,
} from "../../lib/punk-types";
import { restoreCheckpoint, getCheckpointDiff } from "../../lib/tauri-commands";
import type { CheckpointDiffFile } from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import { setRestoreInProgress } from "../../hooks/useFileWatcher";
import { ToolActivity, ServerToolActivity } from "./ToolActivity";
import { MarkdownText, LazyHighlightedCode, renderInline } from "./MarkdownText";
import { ThinkingBlockDisplay } from "./ThinkingBlock";

// No CSS containment — content-visibility: auto causes visible pop-in stutter
// when messages scroll into view, which is worse than the layout cost it saves.
// With memo'd React components, the DOM is stable and scroll is compositor-driven.

// CSS animations for streaming
const style = document.createElement("style");
style.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .streaming-message {
    animation: slideIn 0.8s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .thinking-pulse {
    animation: pulse 2.0s ease-in-out infinite;
  }
`;
document.head.appendChild(style);

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

function CopyButton({
  onClick,
  copied,
}: {
  onClick: () => void;
  copied: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`opacity-0 group-hover:opacity-100 btn-press
        w-7 h-7 flex items-center justify-center rounded shrink-0
        ${
          copied
            ? "text-pane-text-secondary"
            : "text-pane-text-secondary/50 hover:text-pane-text-secondary hover:bg-pane-text/[0.06]"
        }`}
      title="Copy"
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 8.5 6.5 12 13 4" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5V3.5h-7v7h2" />
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
          const d = await getCheckpointDiff(
            projectId,
            checkpointId,
            project.root,
          );
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
        <span
          className="w-1 h-1 rounded-full"
          style={{ background: "var(--pane-terminal)" }}
        />
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

function JsonBlockDisplay({ block }: { block: JsonBlock }) {
  const jsonStr = block.json ? JSON.stringify(block.json, null, 2) : block.raw ?? "";
  return (
    <div className="my-6">
      <div className="flex items-center gap-2 text-[10px] font-mono text-pane-text-secondary/60 mb-2 uppercase tracking-[0.1em]">
        <span className="w-2 h-2 rounded-full bg-pane-terminal/60" />
        json
      </div>
      <div
        className="font-mono overflow-x-auto leading-[1.75]"
        style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
      >
        <pre className="whitespace-pre-wrap break-words m-0">
          <code>
            <LazyHighlightedCode code={jsonStr} lang="json" />
          </code>
        </pre>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: ArbiterVerdict }) {
  const [expanded, setExpanded] = useState(false);
  const errors = verdict.findings.filter((f) => f.severity === "error");
  const warnings = verdict.findings.filter((f) => f.severity === "warning");
  const hasGuidance = (verdict.guidance?.length ?? 0) > 0;
  const hasExpandable = !verdict.pass || hasGuidance;

  // Green: pass. Yellow: warnings only. Red: errors.
  const color = verdict.pass
    ? "text-emerald-500/70"
    : errors.length > 0
      ? "text-red-400/70"
      : "text-amber-400/70";

  const dot = verdict.pass ? "●" : errors.length > 0 ? "▲" : "▲";

  const label = verdict.pass
    ? "clean"
    : errors.length > 0
      ? `${errors.length} error${errors.length > 1 ? "s" : ""}`
      : `${warnings.length} warning${warnings.length > 1 ? "s" : ""}`;

  return (
    <div className="flex flex-col">
      <button
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 text-[10px] font-mono tracking-wider ${color} ${
          hasExpandable ? "hover:opacity-80 cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="text-[8px]">{dot}</span>
        <span>{label}</span>
        {verdict.score < 100 && (
          <span className="text-pane-text-secondary/40">{verdict.score}</span>
        )}
        {hasGuidance && verdict.pass && (
          <span className="text-[var(--pane-terminal)]/50">
            {verdict.guidance!.length} suggestion{verdict.guidance!.length > 1 ? "s" : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 text-[10px] font-mono leading-relaxed text-pane-text-secondary/60 max-w-lg">
          {verdict.findings.slice(0, 5).map((f, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <span className={f.severity === "error" ? "text-red-400/70" : "text-amber-400/70"}>
                {f.severity === "error" ? "err" : "wrn"}
              </span>
              <span className="text-pane-text-secondary/40">{f.file}:{f.line}</span>
              <span>{f.plain}</span>
            </div>
          ))}
          {verdict.guidance && verdict.guidance.length > 0 && (
            <>
              {verdict.findings.length > 0 && <div className="mt-2 mb-1 border-t border-pane-text/5" />}
              {verdict.guidance.map((g, i) => (
                <div key={`g-${i}`} className="flex gap-2 mb-1">
                  <span className="text-[var(--pane-terminal)]/50">tip</span>
                  <span>{g.plain}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageBubble({
  message,
  toolResults,
  projectId,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);

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
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [message]);

  if (message.type === "user") {
    const text = getMessageText(message);
    const [isExpanded, setIsExpanded] = useState(false);
    // Text-based heuristic avoids scrollHeight DOM read (forces layout reflow on every user message)
    const showExpand = text.split('\n').length > 10 || text.length > 600;

    const truncatedText = isExpanded || !showExpand ? text : text.split('\n').slice(0, 10).join('\n');

    return (
      <div className="mb-10 group flex flex-col items-end">
        <div
          className="rounded-xl ring-1 ring-pane-border/40 relative"
          style={{ maxWidth: "65ch" }}
        >
          <p
            className="text-pane-text font-mono leading-[1.75] whitespace-pre-wrap px-4 py-4"
            style={{
              fontSize: "var(--pane-font-size)",
              maxHeight: isExpanded ? 'none' : 'calc(24px * 10)',
              overflow: isExpanded ? 'visible' : 'hidden',
              paddingBottom: showExpand ? '32px' : undefined,
            }}
          >
            {renderInline(truncatedText)}
          </p>
          {showExpand && (
            <div className="absolute bottom-0 left-0 right-0 p-1.5 pointer-events-none">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="pointer-events-auto inline-flex items-center px-3 py-1.5 rounded-md
                  bg-pane-bg/70 backdrop-blur-sm ring-1 ring-pane-border/25
                  text-pane-text-secondary/50 hover:text-pane-text-secondary
                  font-mono btn-press transition-colors"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                {isExpanded ? 'collapse' : 'expand'}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 mt-1">
          {message.checkpointId && (
            <CheckpointIndicator
              checkpointId={message.checkpointId}
              projectId={projectId}
            />
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
    // Also deduplicate tool_use blocks by ID (robustness against backend issues)
    const seenToolIds = new Set<string>();
    const filteredContent = message.content.filter((b) => {
      if (b.type === "tool_use") {
        const tool = b as ToolUseBlock;
        if (tool.name === "TodoWrite") return false;
        if (seenToolIds.has(tool.id)) return false;
        seenToolIds.add(tool.id);
      }
      return true;
    });

    // Check if this is a DeepSeek R1 response with reasoning
    // const hasThinking = message.content.some((b) => b.type === "thinking");

    // Group consecutive text/thinking blocks, but tools/strategy always get their own group
    type GroupType = "text" | "tool" | "thinking" | "json" | "strategy";
    const groups: { type: GroupType; blocks: typeof message.content }[] = [];
    for (const block of filteredContent) {
      let groupType: GroupType;
      if (block.type === "thinking") {
        groupType = "thinking";
      } else if (block.type === "strategy") {
        groupType = "strategy";
      } else if (
        block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "web_search_tool_result"
      ) {
        groupType = "tool";
      } else if (block.type === "json") {
        groupType = "json";
      } else {
        groupType = "text";
      }
      const last = groups[groups.length - 1];
      // Only group consecutive text or thinking blocks together
      // Tools, JSON, and strategy always get their own group
      if (
        last &&
        last.type === groupType &&
        groupType !== "tool" &&
        groupType !== "json" &&
        groupType !== "strategy"
      ) {
        last.blocks.push(block);
      } else {
        groups.push({ type: groupType, blocks: [block] });
      }
    }

    const hasVisibleContent = message.content.some(
      (b) => b.type === "text" || b.type === "json",
    );
    const isStrategyOnly = message.content.length > 0 &&
      message.content.every(b => b.type === "strategy");

    return (
      <div
        className={`group ${hasVisibleContent ? "mb-12" : isStrategyOnly ? "mb-1" : "mb-4"} ${message.isStreaming ? "streaming-message" : ""}`}
      >
        {groups.map((group, gi) => {
          if (group.type === "thinking") {
            return (
              <div key={gi} className="space-y-3">
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

          if (group.type === "strategy") {
            // Route preview is now shown in the InputBar as the user types.
            // The strategy block in the conversation was redundant — it repeated
            // what the user already saw before sending.
            return null;
          }

          if (group.type === "text") {
            return (
              <div
                key={gi}
                className="font-sans"
                style={{ fontWeight: "var(--pane-font-weight)" }}
              >
                {group.blocks.map((block, i) => {
                  const text = (block as { type: "text"; text: string }).text;
                  if (text == null) return null;
                  return (
                    <div key={i}>
                      <MarkdownText
                        text={text}
                        isStreaming={message.isStreaming}
                        projectId={projectId}
                      />
                    </div>
                  );
                })}
              </div>
            );
          }

          if (group.type === "json") {
            return (
              <div key={gi}>
                {group.blocks.map((block, i) => (
                  <JsonBlockDisplay key={i} block={block as JsonBlock} />
                ))}
              </div>
            );
          }

          // tool group (each tool has its own group, one per line)
          const block = group.blocks[0]!;
          if (block.type === "tool_use") {
            const toolBlock = block as ToolUseBlock;
            const result = toolResults.get(toolBlock.id);
            return (
              <div key={gi} className="my-0.5">
                <ToolActivity toolUse={toolBlock} toolResult={result} isHistorical={message.isHistorical} />
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
              <div key={gi} className="my-0.5">
                <ServerToolActivity
                  block={serverBlock}
                  searchResult={searchResult}
                  isHistorical={message.isHistorical}
                />
              </div>
            );
          }
          // web_search_tool_result rendered by its parent server_tool_use
          return null;
        })}

        {/* Footer: quality verdict + cost/duration/tokens + copy */}
        {!message.isStreaming && (
          <div
            className={`mt-4 flex items-center gap-4 pl-6 transition-opacity duration-500 ${
              justCompleted ? "opacity-0" : "opacity-100"
            }`}
          >
            {message.verdict && (
              <VerdictBadge verdict={message.verdict} />
            )}
            {(message.costUsd !== undefined ||
              message.durationMs !== undefined) && (
              <div className="flex gap-4 text-[10px] font-mono text-pane-text-secondary tracking-wider">
                {message.costUsd !== undefined && (
                  <span>${message.costUsd.toFixed(4)}</span>
                )}
                {message.durationMs !== undefined && (
                  <span>{(message.durationMs / 1000).toFixed(1)}s</span>
                )}
                {message.inputTokens !== undefined &&
                  message.outputTokens !== undefined && (
                    <span>
                      {formatTokenCount(message.inputTokens)} in /{" "}
                      {formatTokenCount(message.outputTokens)} out
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
