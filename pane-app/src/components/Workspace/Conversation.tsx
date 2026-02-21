import { useRef, useEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useClaude } from "../../hooks/useClaude";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import type { ToolResultBlock } from "../../lib/claude-types";

interface ConversationProps {
  projectId: string;
}

export function Conversation({ projectId }: ConversationProps) {
  const conversation = useProjectsStore((s) => {
    const project = s.projects.get(projectId);
    return project?.conversation;
  });

  const { sendMessage, abortMessage } = useClaude(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const messages = conversation?.messages ?? [];
  const isProcessing = conversation?.isProcessing ?? false;
  const error = conversation?.error ?? null;

  // Build map of tool_use_id -> ToolResultBlock from system messages
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
  }, [messages]);

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

  // Auto-scroll when new content arrives
  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Scroll to bottom when this conversation becomes active
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const isActive = activeProjectId === projectId;

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current && isActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, [messages, isActive]);

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
          <MessageBubble
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
        onSend={sendMessage}
        onAbort={abortMessage}
        isProcessing={isProcessing}
      />
    </div>
  );
}
