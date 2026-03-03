import { useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useClaude } from "../../hooks/useClaude";
import { useClaudeWarmup } from "../../hooks/useClaudeWarmup";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import type { ConversationMessage, ToolResultBlock, ToolUseBlock } from "../../lib/claude-types";

const EMPTY_MESSAGES: ConversationMessage[] = [];

interface ConversationProps {
  projectId: string;
}

const MemoizedMessage = memo(function MemoizedMessage({
  message,
  toolResults,
  projectId,
}: {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
  projectId: string;
}) {
  return <MessageBubble message={message} toolResults={toolResults} projectId={projectId} />;
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

export function Conversation({ projectId }: ConversationProps) {
  const messages = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.messages ?? EMPTY_MESSAGES
  );
  const isProcessing = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isProcessing ?? false);
  const isReady = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isReady ?? false);
  const error = useProjectsStore((s) => s.projects.get(projectId)?.conversation.error ?? null);

  const { sendMessage, abortMessage, clearConversation } = useClaude(projectId);
  useClaudeWarmup(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

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

  // Scroll to bottom when this conversation becomes active or on initial mount
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const isActive = activeProjectId === projectId;

  useEffect(() => {
    if (!isActive || !isReady) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        });
      }
    });
  }, [isActive, isReady, projectId]);

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

  return (
    <div className="relative h-full w-full animate-in fade-in duration-500">
      <div ref={scrollRef} className="absolute inset-0 overflow-x-hidden overflow-y-auto px-10 pt-8 pb-48">
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
            {/context window/i.test(error) ? (
              <div className="font-mono flex items-baseline gap-4 px-4 py-3 leading-[1.7]"
                style={{ fontSize: "var(--pane-font-size-sm)" }}>
                <span className="text-pane-text-secondary/60">context limit reached</span>
                <button
                  onClick={clearConversation}
                  className="text-pane-text-secondary hover:text-pane-text btn-press"
                >
                  new session
                </button>
              </div>
            ) : (
              <p className="text-pane-error text-xs font-mono bg-[var(--pane-error-bg)] border border-[var(--pane-error-border)] px-4 py-3 leading-[1.7]">
                {error}
              </p>
            )}
          </div>
        )}
      </div>

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
}
