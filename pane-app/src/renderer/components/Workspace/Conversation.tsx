import { useRef, useEffect, useCallback, useMemo, memo, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useClaude } from "../../hooks/useClaude";
import { useClaudeWarmup } from "../../hooks/useClaudeWarmup";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import type { ConversationMessage, ToolResultBlock, ToolUseBlock, ContextPressure } from "../../lib/claude-types";

const EMPTY_MESSAGES: ConversationMessage[] = [];

interface ConversationProps {
  projectId: string;
}

const MSG_CV_STYLE: React.CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 80px" };

const MemoizedMessage = memo(function MemoizedMessage({
  message,
  toolResults,
  projectId,
}: {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
  projectId: string;
}) {
  return (
    <div style={MSG_CV_STYLE}>
      <MessageBubble message={message} toolResults={toolResults} projectId={projectId} />
    </div>
  );
}, (prev, next) => {
  // Message reference changed — must re-render
  if (prev.message !== next.message) return false;
  // Same Map reference — nothing changed
  if (prev.toolResults === next.toolResults) return true;
  // Non-assistant messages don't use toolResults
  if (prev.message.type !== "assistant") return true;
  // Only re-render if a tool result for THIS message's tool_use blocks changed
  for (const block of prev.message.content) {
    if (block.type === "tool_use") {
      const id = (block as ToolUseBlock).id;
      if (prev.toolResults.get(id) !== next.toolResults.get(id)) return false;
    }
  }
  return true;
});

export const Conversation = memo(function Conversation({ projectId }: ConversationProps) {
  const messages = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.messages ?? EMPTY_MESSAGES
  );
  const isProcessing = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isProcessing ?? false);
  const isReady = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isReady ?? false);
  const error = useProjectsStore((s) => s.projects.get(projectId)?.conversation.error ?? null);
  const contextPressure = useProjectsStore((s) => s.projects.get(projectId)?.conversation.contextPressure ?? "none") as ContextPressure;
  const contextTokens = useProjectsStore((s) => s.projects.get(projectId)?.conversation.contextTokens ?? 0);

  const { sendMessage, abortMessage } = useClaude(projectId);
  useClaudeWarmup(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Context refresh toast — shows briefly when proactive continuation fires
  const [showRefreshToast, setShowRefreshToast] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId: refreshedId } = (e as CustomEvent).detail;
      if (refreshedId === projectId) {
        setShowRefreshToast(true);
        setTimeout(() => setShowRefreshToast(false), 3000);
      }
    };
    window.addEventListener("pane:context-refreshed", handler);
    return () => window.removeEventListener("pane:context-refreshed", handler);
  }, [projectId]);

  // Count only system messages (tool results) — text streaming doesn't change this
  const systemMessageCount = useMemo(
    () => messages.filter((m) => m.type === "system").length,
    [messages],
  );
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const msg of messages) {
      if (msg.type === "system") {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            map.set(
              (block as ToolResultBlock).tool_use_id,
              block as ToolResultBlock,
            );
          }
        }
      }
    }
    return map;
  }, [systemMessageCount]);

  // Wheel listener: synchronously disengage follow on upward scroll.
  // Wheel events fire in the same event-loop turn, BEFORE the next rAF,
  // so followRef is false by the time the auto-scroll tick checks it.
  // Deps include isReady because the scroll container doesn't exist during loading.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [isReady]);

  // Scroll listener: re-engage follow when user scrolls back to the bottom.
  // The !followRef guard ensures this only runs when disengaged — it never
  // interferes with the rAF loop's programmatic scrolling (which has followRef=true).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (!followRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        if (distanceFromBottom < 10) followRef.current = true;
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [isReady]);

  // rAF loop: while processing + following, continuously pin to bottom.
  // isProcessing already changes AFTER isReady, so scrollRef.current is available.
  const rafRef = useRef(0);
  useEffect(() => {
    if (!isProcessing) return;
    const tick = () => {
      if (followRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isProcessing]);

  // Scroll to bottom on send — re-engages follow
  const scrollToBottom = useCallback(() => {
    followRef.current = true;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleSend = useCallback((msg: string) => { sendMessage(msg); scrollToBottom(); }, [sendMessage, scrollToBottom]);

  // Scroll to bottom when this conversation becomes active (fired by ConversationLayer
  // via DOM event — no Zustand subscription, no re-render on project switch).
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId: activatedId } = (e as CustomEvent).detail;
      if (activatedId === projectId && isReady && scrollRef.current) {
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        });
      }
    };
    window.addEventListener("pane:conversation-activated", handler);
    return () => window.removeEventListener("pane:conversation-activated", handler);
  }, [projectId, isReady]);

  // Show loading state when Claude is initializing
  if (!isReady) {
    return (
      <div className="flex flex-col h-full w-full">
        <div className="flex-1 flex items-center justify-center">
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-pane-text-secondary"
          >
            <circle
              cx="60"
              cy="60"
              r="40"
              fill="none"
              className="animate-circle-pulse"
              style={{ strokeWidth: 'var(--circle-stroke-width, 2)' }}
            />
          </svg>
        </div>
      </div>
    );
  }

  const contextPercent = contextTokens > 0 ? Math.min(Math.round((contextTokens / 200000) * 100), 99) : 0;

  return (
    <div className="relative h-full w-full">
      {contextPressure !== "none" && (
        <div className="absolute top-0 left-0 right-0 z-10 px-10 pt-2">
          <div className="flex items-center gap-2 font-mono" style={{ fontSize: "10px" }}>
            <span className={contextPressure === "high" ? "text-pane-error" : "text-[var(--pane-terminal)]"}>
              context {contextPercent}%
            </span>
            <div className="flex-1 h-[2px] bg-pane-surface rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  contextPressure === "high" ? "bg-pane-error" : "bg-[var(--pane-terminal)]"
                }`}
                style={{ width: `${contextPercent}%` }}
              />
            </div>
          </div>
        </div>
      )}

      <div ref={scrollRef} className={`absolute inset-0 overflow-x-hidden overflow-y-auto px-10 pb-48 ${contextPressure !== "none" ? "pt-12" : "pt-8"}`} style={{ contain: "strict" }}>
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full select-none">
            <span
              className="text-pane-text-secondary/40 font-mono tracking-[0.25em] uppercase"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              ready
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <MemoizedMessage
            key={msg.id}
            message={msg}
            toolResults={toolResultMap}
            projectId={projectId}
          />
        ))}

        {error && (
          <div className="mt-4">
            <p className="text-pane-error text-xs font-mono bg-[var(--pane-error-bg)] border border-[var(--pane-error-border)] px-4 py-3 leading-[1.7]">
              {error}
            </p>
          </div>
        )}
      </div>

      {showRefreshToast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div
            className="font-mono text-[10px] text-[var(--pane-terminal)] bg-pane-surface px-3 py-1.5 rounded-sm animate-fade-in"
          >
            context refreshed — conversation continues with full memory
          </div>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0">
        <InputBar
          projectId={projectId}
          onSend={handleSend}
          onAbort={abortMessage}
          isProcessing={isProcessing}
        />
      </div>
    </div>
  );
});
