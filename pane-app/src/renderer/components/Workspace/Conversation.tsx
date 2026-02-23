import { useRef, useEffect, useMemo, memo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useClaude } from "../../hooks/useClaude";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import type { ConversationMessage, ToolResultBlock } from "../../lib/claude-types";

const EMPTY_MESSAGES: ConversationMessage[] = [];

interface ConversationProps {
  projectId: string;
}

// Memoized message — only re-renders when its own message object changes
const MemoizedMessage = memo(function MemoizedMessage({
  message,
  toolResults,
}: {
  message: ConversationMessage;
  toolResults: Map<string, ToolResultBlock>;
}) {
  return <MessageBubble message={message} toolResults={toolResults} />;
});

export function Conversation({ projectId }: ConversationProps) {
  // Direct selector — no useShallow. The messages array reference only changes
  // when messages are added/removed or content is updated, which is exactly
  // when we want to re-render. useShallow was doing expensive per-element
  // comparison on every store update.
  const messages = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.messages ?? EMPTY_MESSAGES
  );
  const isProcessing = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isProcessing ?? false);
  const error = useProjectsStore((s) => s.projects.get(projectId)?.conversation.error ?? null);

  const { sendMessage, abortMessage } = useClaude(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Build map of tool_use_id -> ToolResultBlock from system messages.
  // Only recompute when the message count changes — tool results arrive as
  // new messages (type "system"), not as mutations to existing messages.
  // This prevents recomputing during text streaming deltas.
  const messageCount = messages.length;
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
  }, [messageCount]);

  // Track scroll position — throttled to avoid forced layout on every momentum tick.
  // Reading scrollHeight/scrollTop/clientHeight forces synchronous layout; doing this
  // at 120Hz during momentum deceleration creates visible micro-stalls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let ticking = false;
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        if (el) {
          isAtBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }
        ticking = false;
      });
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when new content arrives.
  // Use a lightweight RAF loop during processing instead of depending on
  // the messages array (which changes on every streaming text delta and
  // would cause expensive re-render cascades).
  useEffect(() => {
    if (!isProcessing) {
      // Not processing — do a single scroll check for any final update
      if (isAtBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      return;
    }
    // During processing, poll scroll position at display refresh rate
    let raf: number;
    const tick = () => {
      if (isAtBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isProcessing, messageCount]);

  // Scroll to bottom when this conversation becomes active
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const isActive = activeProjectId === projectId;

  // Scroll to bottom immediately when becoming active (before render)
  useEffect(() => {
    if (isActive && scrollRef.current) {
      // Use immediate synchronous scroll before any paint
      const scroll = () => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          isAtBottomRef.current = true;
        }
      };
      scroll();
      // Also do it after a single frame to catch any layout shifts
      requestAnimationFrame(scroll);
    }
  }, [isActive]);

  return (
    <div className="flex flex-col h-full w-full">
      {/* Message area — takes remaining space above input */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-10 py-8 overscroll-contain">
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

      {/* Input — guaranteed generous space, never cramped */}
      <InputBar
        projectId={projectId}
        onSend={sendMessage}
        onAbort={abortMessage}
        isProcessing={isProcessing}
      />
    </div>
  );
}
