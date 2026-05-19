import { memo, useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "../../stores/projects";
import type { Conversation } from "../../lib/punk-types";

interface ConversationPickerProps {
  projectId: string;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export const ConversationPicker = memo(function ConversationPicker({
  projectId,
}: ConversationPickerProps) {
  const conversations = useProjectsStore(
    useShallow((s) => {
      const p = s.projects.get(projectId);
      if (!p) return [] as Conversation[];
      const result: Conversation[] = [];
      for (const c of p.conversations.values()) {
        if (!c.isArchived) result.push(c);
      }
      return result;
    }),
  );

  const sorted = useMemo(() => {
    return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations]);

  const handleSelect = useCallback(
    (convId: string) => {
      useProjectsStore.getState().setActiveConversation(projectId, convId);
    },
    [projectId],
  );

  const handleStartNew = useCallback(() => {
    useProjectsStore.getState().addConversation(projectId, undefined, "idle");
  }, [projectId]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-no-drag>
      <div className="flex-1 flex flex-col px-6 min-h-0">
        <div className="h-8" />

        {/* New conversation — pinned to top */}
        <button
          onClick={handleStartNew}
          className="w-full flex flex-col gap-0 px-2.5 py-4 rounded-md group btn-press cursor-pointer text-left text-pane-text-secondary hover:bg-pane-text/[0.08] hover:text-pane-text active:bg-pane-text/[0.12] shrink-0"
        >
          <span
            className="truncate text-pane-text font-medium"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            New conversation +
          </span>
          <span
            className="truncate text-pane-text-secondary/40 leading-tight mt-0.5"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            start fresh with a blank slate
          </span>
        </button>

        {/* Spacer — pushes recent conversations to bottom */}
        <div className="flex-1 min-h-0" />

        {/* Recent conversations — pushed to bottom */}
        {sorted.length > 0 && (
          <div className="shrink-0 pt-6 pb-6">
            <span className="block mb-1 text-[10px] text-pane-text-dim/20">
              Recent conversations
            </span>

            {sorted.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                onSelect={handleSelect}
                projectId={projectId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** Extract a plain-text preview from the last user or assistant message in a conversation. */
function getConversationExcerpt(conv: Conversation): string {
  const msgs = conv.state.messages;
  if (!msgs || msgs.length === 0) return "";
  // Walk backwards to find the most recent message with text content
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]!;
    if (msg.type !== "user" && msg.type !== "assistant") continue;
    const textBlocks = msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
    if (textBlocks.length > 0) {
      const text = textBlocks[0]!.text;
      if (text.trim()) {
        // Truncate to one line
        const singleLine = text.replace(/\n/g, " ").trim();
        return singleLine.length > 80 ? singleLine.slice(0, 80) + "…" : singleLine;
      }
    }
  }
  return "";
}

const ConversationRow = memo(function ConversationRow({
  conv,
  onSelect,
  projectId,
}: {
  conv: Conversation;
  onSelect: (id: string) => void;
  projectId: string;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const timeAgo = formatRelativeTime(conv.updatedAt);
  const msgCount = conv.state.messages.length;
  const hasActivity = msgCount > 0;
  const excerpt = hasActivity ? getConversationExcerpt(conv) : "";

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useProjectsStore.getState().removeConversation(projectId, conv.id);
    },
    [projectId, conv.id],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowMenu(true);
  }, []);

  const handleArchive = useCallback(() => {
    setShowMenu(false);
    useProjectsStore.getState().archiveConversation(projectId, conv.id);
  }, [projectId, conv.id]);

  const handleRestore = useCallback(() => {
    setShowMenu(false);
    useProjectsStore.getState().unarchiveConversation(projectId, conv.id);
  }, [projectId, conv.id]);

  const handleDeleteMenu = useCallback(() => {
    setShowMenu(false);
    useProjectsStore.getState().removeConversation(projectId, conv.id);
  }, [projectId, conv.id]);

  const handleDocClick = useCallback(() => {
    setShowMenu(false);
  }, []);

  return (
    <>
      <div
        className="w-full flex flex-col gap-0 px-2.5 py-3 rounded-md cursor-pointer group select-text text-pane-text-secondary hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40 hover:rounded-md hover:text-pane-text"
        role="button"
        tabIndex={0}
        onClick={() => onSelect(conv.id)}
        onKeyDown={(e) => { if (e.key === "Enter") onSelect(conv.id); }}
        onContextMenu={handleContextMenu}
      >
        {/* Header row: label left, time + delete right */}
        <div className="flex items-center justify-between min-w-0">
          <span
            className="truncate text-pane-text font-medium"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            {conv.label}
          </span>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            {hasActivity && (
              <span
                className="text-pane-text-secondary/40 whitespace-nowrap"
                style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
              >
                {timeAgo}
              </span>
            )}
            <button
              onClick={handleDelete}
              className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition-opacity text-pane-text-dim/50 hover:text-red-400 text-xs leading-none"
              title="Delete conversation"
            >
              ×
            </button>
          </div>
        </div>

        {/* Excerpt row — only when the conversation has messages */}
        {hasActivity && (
          <span
            className="truncate text-pane-text-secondary/50 leading-tight mt-0.5"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            {excerpt || "No messages yet"}
          </span>
        )}
      </div>

      {/* Right-click context menu */}
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={handleDocClick}
            onContextMenu={(e) => { e.preventDefault(); setShowMenu(false); }}
          />
          <div
            className="fixed z-50 bg-pane-bg-dim border border-pane-border/40 rounded-md shadow-lg py-1 text-xs min-w-[140px]"
            style={{ left: menuPos.x, top: menuPos.y }}
            onClick={() => setShowMenu(false)}
          >
            {conv.isArchived ? (
              <button
                className="w-full text-left px-3 py-1.5 text-pane-text hover:bg-pane-bg-dim/80 transition-colors"
                onClick={handleRestore}
              >
                Restore
              </button>
            ) : (
              <button
                className="w-full text-left px-3 py-1.5 text-pane-text-dim hover:bg-pane-bg-dim/80 transition-colors"
                onClick={handleArchive}
              >
                Archive
              </button>
            )}
            <div className="border-t border-pane-border/20 my-1" />
            <button
              className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-pane-bg-dim/80 transition-colors"
              onClick={handleDeleteMenu}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </>
  );
});
