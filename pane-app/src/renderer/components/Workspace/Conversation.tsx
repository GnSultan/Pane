import { useRef, useEffect, useMemo, memo } from "react";
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
}: {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
}) {
  return <MessageBubble message={message} toolResults={toolResults} />;
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

  const { sendMessage, abortMessage } = useClaude(projectId);
  useClaudeWarmup(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // true = follow new messages; false = user scrolled up, leave them alone
  const followRef = useRef(true);
  // distinguish programmatic scrolls from user-initiated ones
  const programmaticScrollRef = useRef(false);

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

  // Track scroll — if user scrolled up, stop following; if they scroll back to bottom, resume
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (programmaticScrollRef.current) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      followRef.current = distanceFromBottom < 80;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when messages change — only if following
  const scrollRafRef = useRef(0);
  useEffect(() => {
    if (!followRef.current || !scrollRef.current) return;
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      programmaticScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      requestAnimationFrame(() => { programmaticScrollRef.current = false; });
    });
  }, [messages]);

  // Scroll to bottom when this conversation becomes active or on initial mount
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const isActive = activeProjectId === projectId;

  useEffect(() => {
    if (!isActive || !isReady) return;
    const scrollToBottom = () => {
      if (scrollRef.current) {
        programmaticScrollRef.current = true;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        followRef.current = true;
        requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
    };
    // Double rAF: first ensures layout, second ensures paint + message DOM is ready
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
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
      <div ref={scrollRef} className="absolute inset-0 overflow-x-hidden overflow-y-auto px-10 pt-8 pb-48" style={{ willChange: "transform" }}>
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

      <div className="absolute bottom-0 left-0 right-0">
        <InputBar
          projectId={projectId}
          onSend={sendMessage}
          onAbort={abortMessage}
          isProcessing={isProcessing}
        />
      </div>
    </div>
  );
}
