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
  const messages = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.messages ?? EMPTY_MESSAGES
  );
  const isProcessing = useProjectsStore((s) => s.projects.get(projectId)?.conversation.isProcessing ?? false);
  const error = useProjectsStore((s) => s.projects.get(projectId)?.conversation.error ?? null);

  const { sendMessage, abortMessage } = useClaude(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

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

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when messages change
  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Scroll to bottom when this conversation becomes active
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const isActive = activeProjectId === projectId;

  useEffect(() => {
    if (isActive && scrollRef.current) {
      const scroll = () => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          isAtBottomRef.current = true;
        }
      };
      scroll();
      requestAnimationFrame(scroll);
    }
  }, [isActive]);

  return (
    <div className="flex flex-col h-full w-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-10 py-8">
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

      <InputBar
        projectId={projectId}
        onSend={sendMessage}
        onAbort={abortMessage}
        isProcessing={isProcessing}
      />
    </div>
  );
}
