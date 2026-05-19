import { memo, useCallback, useState, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "../../stores/projects";
import type { Conversation } from "../../lib/punk-types";

interface ConversationTabBarProps {
  projectId: string;
}

// ─── Conversation Tab ─────────────────────────────────────────────────

const ConversationTab = memo(function ConversationTab({
  conv,
  isActive,
  onClick,
  projectId,
  convCount,
}: {
  conv: Conversation;
  isActive: boolean;
  onClick: () => void;
  projectId: string;
  convCount: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = useCallback(() => {
    setEditValue(conv.label);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [conv.label]);

  const handleSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed) {
      const store = useProjectsStore.getState();
      const p = store.projects.get(projectId);
      if (p) {
        const isDuplicate = Array.from(p.conversations.values()).some(
          (c) => c.id !== conv.id && !c.isArchived && c.label.toLowerCase() === trimmed.toLowerCase(),
        );
        if (isDuplicate) {
          if (inputRef.current) {
            inputRef.current.style.borderColor = "#ef4444";
            setTimeout(() => {
              if (inputRef.current) inputRef.current.style.borderColor = "";
            }, 600);
          }
          return;
        }
      }
      store.renameConversation(projectId, conv.id, trimmed);
    }
    setEditing(false);
  }, [conv.id, projectId, editValue, conv.label, conv.isArchived]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
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

  const handleDelete = useCallback(() => {
    setShowMenu(false);
    useProjectsStore.getState().removeConversation(projectId, conv.id);
  }, [projectId, conv.id]);

  const handleDocClick = useCallback(() => {
    setShowMenu(false);
  }, []);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useProjectsStore.getState().closeConversationTab(projectId, conv.id);
  }, [projectId, conv.id]);

  const phaseColor =
    conv.state.isProcessing
      ? "text-[var(--pane-status-modified)]"
      : "";

  return (
    <>
      <button
        onClick={onClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        className={`flex-1 min-w-0 font-mono px-3 py-1 rounded-md flex items-center justify-between gap-2 btn-press transition-colors ${
          isActive
            ? "bg-pane-text/[0.06] text-pane-text"
            : "text-pane-text-secondary/50 hover:text-pane-text-secondary hover:bg-pane-text/[0.03]"
        }`}
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="w-16 bg-transparent text-pane-text text-xs outline-none border-b border-pane-border"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={`truncate min-w-0 ${phaseColor}`}>
            {conv.label}
          </span>
        )}
        {convCount > 1 && (
          <span
            onClick={handleClose}
            className="shrink-0 opacity-40 hover:opacity-100 cursor-pointer"
          >
            ×
          </span>
        )}
      </button>

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
              onClick={handleDelete}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </>
  );
});

// ─── Tab Bar ──────────────────────────────────────────────────────────

export const ConversationTabBar = memo(function ConversationTabBar({
  projectId,
}: ConversationTabBarProps) {
  const conversations = useProjectsStore(
    useShallow((s) => {
      const p = s.projects.get(projectId);
      if (!p) return [] as Conversation[];
      return p.conversationOrder
        .map((id) => p.conversations.get(id))
        .filter((c): c is Conversation => !!c && !c.isArchived);
    }),
  );

  const activeId = useProjectsStore(
    (s) => s.projects.get(projectId)?.activeConversationId ?? null,
  );

  const handleAdd = useCallback(() => {
    // Navigate to conversation picker — user selects or creates from there
    const store = useProjectsStore.getState();
    const proj = store.projects.get(projectId);
    if (proj) {
      store.setActiveConversation(projectId, null);
    }
  }, [projectId]);

  const handleSelect = useCallback(
    (convId: string) => {
      useProjectsStore.getState().setActiveConversation(projectId, convId);
    },
    [projectId],
  );

  if (conversations.length === 0) return null;

  return (
    <div
      className="absolute top-0 left-0 right-0 z-30 flex items-center px-4 pt-2 pb-1 gap-1 bg-pane-bg"
      data-no-drag
    >
      {conversations.map((conv) => (
        <ConversationTab
          key={conv.id}
          conv={conv}
          isActive={conv.id === activeId}
          onClick={() => handleSelect(conv.id)}
          projectId={projectId}
          convCount={conversations.length}
        />
      ))}
      <button
        onClick={handleAdd}
        className="shrink-0 font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary w-7 h-7 flex items-center justify-center rounded-md hover:bg-pane-text/[0.04] btn-press"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
        title="New conversation"
      >
        +
      </button>
    </div>
  );
});
