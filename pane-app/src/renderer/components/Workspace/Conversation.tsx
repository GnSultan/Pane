import { useRef, useEffect, useCallback, useMemo, memo, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { usePunk } from "../../hooks/usePunk";
import { useScrollPosition } from "../../hooks/useScrollPosition";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import type {
  ConversationMessage,
  ToolResultBlock,
  ToolUseBlock,
} from "../../lib/punk-types";

const EMPTY_MESSAGES: ConversationMessage[] = [];

interface ConversationProps {
  projectId: string;
}

// MemoizedMessage uses a custom comparator to prevent re-renders of unchanged
// messages. The store only ever creates a new object for the LAST message on
// each text delta (spread of the last element), so older messages keep the same
// reference — the comparator short-circuits immediately for all but the
// actively-streaming message. O(n) total reconciliation cost per update.
//
// Per-message store subscriptions (MessageItem pattern) look appealing but are
// O(n²): each of n items runs an O(n) .find() selector on every store update.
// With 100 messages × 100 streaming updates/s that's ~1M comparisons/s —
// enough to fully saturate the main thread and block painting.
const MemoizedMessage = memo(
  function MemoizedMessage({
    message,
    toolResults,
    projectId,
  }: {
    message: ConversationMessage;
    toolResults: Map<string, ToolResultBlock>;
    projectId: string;
  }) {
    return (
      <div style={{ contain: "content" }}>
        <MessageBubble
          message={message}
          toolResults={toolResults}
          projectId={projectId}
        />
      </div>
    );
  },
  (prev, next) => {
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
  },
);

export const Conversation = memo(function Conversation({
  projectId,
}: ConversationProps) {
  const messages = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.messages ?? EMPTY_MESSAGES,
  );
  const isProcessing = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.isProcessing ?? false,
  );
  const isThinking = useProjectsStore(
    (s) =>
      s.projects.get(projectId)?.conversation.statusMessage === "thinking...",
  );
  const error = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.error ?? null,
  );

  // toolResultMap: only recompute when the count of system messages changes,
  // not on every text delta. Text deltas only touch the last assistant message.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemMessageCount]);

  const { sendMessage, abortMessage } = usePunk(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const streamingRef = useRef(false);

  const isActive = isProcessing || isThinking;
  streamingRef.current = isActive;

  const { applyRestored } = useScrollPosition(projectId, scrollRef, followRef, streamingRef);

  // Restore saved scroll position when messages first arrive from disk.
  useEffect(() => {
    if (messages.length > 0) applyRestored();
  }, [messages.length]);

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

  // Error toast — persists until dismissed or cleared
  const [visibleError, setVisibleError] = useState<string | null>(null);
  useEffect(() => {
    if (error) setVisibleError(error);
  }, [error]);

  // Wheel listener: disengage follow on scroll up, re-engage on scroll down to bottom.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        followRef.current = false;
      } else if (e.deltaY > 0 && streamingRef.current) {
        // Re-engage follow if user scrolls down near the bottom during streaming.
        const { scrollTop, scrollHeight, clientHeight } = container;
        if (scrollHeight - scrollTop - clientHeight < 40) {
          followRef.current = true;
        }
      }
    };
    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  // rAF loop: while active + following, continuously pin to bottom.
  const rafRef = useRef(0);
  useEffect(() => {
    if (!isActive) return;
    const tick = () => {
      if (followRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isActive]);

  // Scroll to bottom on send — re-engages follow
  const scrollToBottom = useCallback(() => {
    followRef.current = true;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleSend = useCallback(
    (msg: string) => {
      sendMessage(msg);
      scrollToBottom();
    },
    [sendMessage, scrollToBottom],
  );

  // Listen for send-message events from EmptyState (first message on thread creation)
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId: targetId, message } = (e as CustomEvent).detail;
      if (targetId === projectId && message) {
        handleSend(message);
      }
    };
    window.addEventListener("pane:send-message", handler);
    return () => window.removeEventListener("pane:send-message", handler);
  }, [projectId, handleSend]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-x-hidden overflow-y-auto px-10 pb-48 pt-8 z-20 [overflow-anchor:none] bg-pane-bg will-change-transform [contain:layout_paint]"
        data-conv-scroll
        data-no-drag
      >
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

        {messages.map((message) => (
          <MemoizedMessage
            key={message.id}
            message={message}
            toolResults={toolResultMap}
            projectId={projectId}
          />
        ))}

      </div>

      {showRefreshToast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="font-mono text-[10px] text-[var(--pane-terminal)] bg-pane-surface px-3 py-1.5 rounded-sm animate-fade-in">
            context refreshed — conversation continues with full memory
          </div>
        </div>
      )}

      {visibleError && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-40 w-[min(480px,80%)]">
          <div className="flex items-start gap-3 font-mono text-[10px] text-pane-error bg-pane-surface px-3 py-2 rounded-sm animate-fade-in leading-[1.6]">
            <span className="break-words flex-1">{visibleError}</span>
            <button
              onClick={() => setVisibleError(null)}
              className="shrink-0 text-pane-text-secondary/40 hover:text-pane-text-secondary transition-colors mt-px"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 z-30">
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
