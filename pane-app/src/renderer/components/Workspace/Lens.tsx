import { useEffect, useRef, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLensStore } from "../../stores/lens";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useMindStore } from "../../stores/mind";
import { lensPostAdd, lensPostsList, lensPostDelete, type LensPost } from "../../lib/tauri-commands";
import { useLensChat } from "../../hooks/useLensChat";
import { SlashMenu } from "../shared";
import type { TextBlock } from "../../lib/punk-types";

const PUNK_PERSONAS: Record<string, { name: string; role: string }> = {
  bug:        { name: "maya", role: "debugger" },
  reflection: { name: "noor", role: "constructive thinker" },
  sentinel:   { name: "zara", role: "the auditor" },
};

// ─── PostComments ──────────────────────────────────────────────────────────

function PostComments({
  postId,
  workingDir,
  postContent,
  isVisible,
}: {
  postId: string;
  workingDir: string;
  postContent: string;
  isVisible: boolean;
}) {
  const { messages, isProcessing, error, sendMessage, appendMessage } = useLensChat(
    postId,
    workingDir,
    postContent
  );

  const [input, setInput] = useState("");
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on("pane://lens-comment", (data: { postId: string; comment: any }) => {
      if (data.postId !== postId) return;
      try {
        const msg = JSON.parse(data.comment.content);
        if (msg?.id && msg?.type) appendMessage(msg);
      } catch {}
    });
    return () => unlisten();
  }, [postId, appendMessage]);

  useEffect(() => {
    if (isVisible) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages.length, isVisible]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isProcessing) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isVisible) return null;

  return (
    <div className="pl-5 mt-1.5 mb-1">
      {/* Comment thread — each comment truncated, tap to expand */}
      {messages.length > 0 && (
        <div className="flex flex-col gap-1 mb-2">
          {messages.map((msg) => {
            const isAssistant = msg.type === "assistant";
            const text = msg.content
              .filter((b): b is TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (!text) return null;
            const isExpanded = expandedMsgId === msg.id;
            const isLong = text.length > 80;
            return (
              <div key={msg.id} className="flex gap-2 items-baseline min-w-0">
                <span
                  className="font-mono shrink-0"
                  style={{
                    fontSize: "var(--pane-font-size-xs)",
                    color: isAssistant ? "var(--pane-terminal)" : "var(--pane-text-secondary)",
                    opacity: isAssistant ? 0.7 : 0.4,
                  }}
                >
                  {isAssistant ? "pane" : "you"}
                </span>
                <span
                  className={`text-pane-text/60 leading-snug whitespace-pre-wrap min-w-0 flex-1 ${!isExpanded && isLong ? "line-clamp-1" : ""} ${isLong ? "cursor-pointer" : ""}`}
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                  onClick={() => isLong && setExpandedMsgId(isExpanded ? null : msg.id)}
                >
                  {text}
                  {msg.isStreaming && (
                    <span className="inline-block ml-1 animate-pulse" style={{ color: "var(--pane-terminal)" }}>▋</span>
                  )}
                </span>
              </div>
            );
          })}

          {isProcessing && messages[messages.length - 1]?.type === "user" && (
            <div className="flex items-center gap-2">
              <span className="font-mono shrink-0" style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)", opacity: 0.7 }}>pane</span>
              <span className="animate-pulse font-mono" style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)", opacity: 0.5 }}>...</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {isProcessing && messages.length === 0 && (
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono shrink-0" style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)", opacity: 0.7 }}>pane</span>
          <span className="animate-pulse font-mono" style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)", opacity: 0.5 }}>...</span>
        </div>
      )}

      {error && (
        <p className="text-pane-error mb-2 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>{error}</p>
      )}

      {/* Reply input — no border, bg-pane-surface defines the container */}
      <div className="bg-pane-surface rounded-md relative">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder="reply"
          rows={1}
          disabled={isProcessing}
          className="w-full bg-transparent text-pane-text font-mono resize-none outline-none placeholder:text-pane-text-secondary/30 leading-[1.75] px-3 pt-1.5 overflow-hidden"
          style={{
            fontSize: "var(--pane-font-size-xs)",
            minHeight: "2rem",
            maxHeight: "6rem",
            paddingBottom: input.trim() ? "1.75rem" : "0.375rem",
          }}
        />
        {input.trim() && (
          <button
            onMouseDown={(e) => { e.preventDefault(); handleSend(); }}
            className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded text-pane-text-secondary/50 hover:text-pane-text hover:bg-pane-text/[0.06] transition-all btn-press"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── PostItem ──────────────────────────────────────────────────────────────

const POST_CLAMP_THRESHOLD = 220;

function PostItem({
  post,
  showComments,
  onToggleComments,
  workingDir,
  userName,
  onDelete,
}: {
  post: LensPost;
  showComments: boolean;
  onToggleComments: () => void;
  workingDir: string;
  userName: string;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isPunk = post.contributor !== "user";
  const persona = isPunk ? PUNK_PERSONAS[post.contributor] : null;
  const name = persona ? persona.name : (userName || "you");
  const commentCount = post.comment_count ?? 0;
  const isLong = post.content.length > POST_CLAMP_THRESHOLD;

  return (
    <div className="mb-5">
      <div className="flex items-start gap-2.5 px-1 py-1">
        {/* Status dot */}
        <div className="mt-[6px] shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${isPunk ? "bg-pane-terminal" : "bg-pane-text-secondary/40"}`} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Name */}
          <div className="mb-1">
            <span
              className="font-mono"
              style={{
                fontSize: "var(--pane-font-size-xs)",
                color: isPunk ? "var(--pane-terminal)" : "var(--pane-text-secondary)",
                opacity: isPunk ? 0.8 : 0.5,
              }}
            >
              {name}
            </span>
            {persona && (
              <span className="font-mono text-pane-text-secondary/25 ml-1.5" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                {persona.role}
              </span>
            )}
          </div>

          {/* Content — clamped to 4 lines, expand on demand */}
          <p
            className={`text-pane-text leading-relaxed whitespace-pre-wrap ${!expanded && isLong ? "line-clamp-4" : ""}`}
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {post.content}
          </p>

          {/* Bottom row — read more (left) + comment button (middle) + delete button (right) */}
          <div className="flex items-center justify-between mt-1.5">
            <div>
              {isLong && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="font-mono transition-colors btn-press"
                  style={{
                    fontSize: "var(--pane-font-size-xs)",
                    color: "var(--pane-text-secondary)",
                    opacity: 0.3,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.6")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.3")}
                >
                  {expanded ? "less" : "more"}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleComments}
                className="flex items-center gap-1 transition-colors btn-press font-mono"
                style={{
                  fontSize: "var(--pane-font-size-xs)",
                  color: "var(--pane-text-secondary)",
                  opacity: showComments ? 0.6 : 0.25,
                }}
                title={commentCount > 0 ? `${commentCount} comments` : "comment"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {commentCount > 0 && <span>{commentCount}</span>}
              </button>
              <button
                onClick={onDelete}
                className="flex items-center gap-1 transition-colors btn-press font-mono"
                style={{
                  fontSize: "var(--pane-font-size-xs)",
                  color: "var(--pane-text-secondary)",
                  opacity: 0.25,
                }}
                title="delete"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Comments — outside post, indented to align with content */}
      {showComments && (
        <PostComments
          postId={post.id}
          workingDir={workingDir}
          postContent={post.content}
          isVisible={showComments}
        />
      )}
    </div>
  );
}

// ─── Lens ──────────────────────────────────────────────────────────────────

export function Lens({ projectId }: { projectId: string }) {
  const posts = useLensStore(useShallow((s) => s.posts.filter((p) => p.project_id === projectId)));
  const appendPost = useLensStore((s) => s.appendPost);
  const setPosts = useLensStore((s) => s.setPosts);
  const deletePost = useLensStore((s) => s.deletePost);
  const setLoaded = useLensStore((s) => s.setLoaded);
  const clearUnreadPunkPosts = useLensStore((s) => s.clearUnreadPunkPosts);
  const expandedCommentsId = useLensStore((s) => s.expandedCommentsId);
  const setExpandedCommentsId = useLensStore((s) => s.setExpandedCommentsId);

  const workingDir = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  const userName = useWorkspaceStore((s) => s.profileName);

  const [composing, setComposing] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  // Slash-menu state for mind entry quick-insert
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const slashStartRef = useRef<number>(-1);
  const mindEntries = useMindStore((s) => s.entries);

  // Load posts on first visit — always re-fetch so navigation away and back is safe
  useEffect(() => {
    lensPostsList(projectId).then((fetched) => {
      setPosts(fetched);
      setLoaded(projectId, true);
    });
  }, [projectId]);

  // Clear unread punk posts when user navigates to Lens
  useEffect(() => {
    clearUnreadPunkPosts(projectId);
  }, [projectId]);

  // Listen for new posts from workers via IPC
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on("pane://lens-post", (post: LensPost) => {
      if (post.project_id === projectId) appendPost(post);
    });
    return () => unlisten();
  }, [projectId]);

  // Scroll to bottom when posts change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [posts.length]);

  // Auto-focus textarea when compose opens
  useEffect(() => {
    if (composing) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [composing]);

  // Close compose on click outside
  useEffect(() => {
    if (!composing) return;
    const handler = (e: MouseEvent) => {
      if (composeRef.current && !composeRef.current.contains(e.target as Node)) {
        if (!input.trim()) {
          setComposing(false);
          setInput("");
        }
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [composing, input]);

  const handleComposeChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;
    setInput(next);
    // Auto-resize
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;

    if (slashOpen) {
      const slashIdx = slashStartRef.current - 1;
      if (next[slashIdx] !== "/" || pos < slashStartRef.current) {
        setSlashOpen(false);
      } else {
        setSlashQuery(next.slice(slashStartRef.current, pos));
      }
    } else {
      if (next[pos - 1] === "/") {
        const charBefore = next[pos - 2];
        if (!charBefore || charBefore === " " || charBefore === "\n") {
          slashStartRef.current = pos;
          setSlashQuery("");
          setSlashOpen(true);
        }
      }
    }
  }, [slashOpen]);

  const handleSlashSelect = useCallback((content: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const slashIdx = slashStartRef.current - 1;
    const cursorPos = ta.selectionStart ?? input.length;
    const before = input.slice(0, slashIdx);
    const after = input.slice(cursorPos);
    const next = before + content + after;
    setInput(next);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = before.length + content.length;
      ta.setSelectionRange(newPos, newPos);
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    });
  }, [input]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      const post = await lensPostAdd("user", text, projectId);
      appendPost(post);
      setComposing(false);
    } finally {
      setSending(false);
    }
  };

  const handleDelete = useCallback(async (postId: string) => {
    try {
      await lensPostDelete(postId);
      deletePost(postId);
    } catch (error) {
      console.error("Failed to delete post:", error);
    }
  }, [deletePost]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash menu captures Enter/Tab/Escape/Arrows — don't double-handle
    if (slashOpen && (e.key === "Enter" || e.key === "Tab" || e.key === "Escape" || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      setComposing(false);
      setInput("");
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Feed */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar py-4"
      >
        <div className="max-w-2xl mx-auto w-full px-4">
        {posts.length === 0 && !composing ? (
          <div className="flex items-center justify-center h-full py-20">
            <button
              onClick={() => setComposing(true)}
              className="font-mono text-pane-text-secondary/30 hover:text-pane-text-secondary/50 transition-colors btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              what do you notice
            </button>
          </div>
        ) : (
          posts.map((post) => (
            <PostItem
              key={post.id}
              post={post}
              showComments={expandedCommentsId === post.id}
              onToggleComments={() =>
                setExpandedCommentsId(expandedCommentsId === post.id ? null : post.id)
              }
              workingDir={workingDir}
              userName={userName}
              onDelete={() => handleDelete(post.id)}
            />
          ))
        )}
        </div>
      </div>

      {/* Compose — expand on demand */}
      <div ref={composeRef} className="shrink-0">
        {composing ? (
          <div className="bg-pane-bg rounded-t-xl ring-1 ring-pane-border/40 relative">
            {slashOpen && (
              <SlashMenu
                entries={mindEntries}
                query={slashQuery}
                onSelect={handleSlashSelect}
                onDismiss={() => setSlashOpen(false)}
              />
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleComposeChange}
              onKeyDown={handleKeyDown}
              placeholder="what do you notice"
              disabled={sending}
              className="w-full bg-transparent text-pane-text font-mono resize-none outline-none placeholder:text-pane-text-secondary leading-[1.75] px-5 pt-4 overflow-y-auto overflow-x-hidden"
              style={{
                fontSize: "var(--pane-font-size)",
                minHeight: "80px",
                maxHeight: "30vh",
                paddingBottom: "36px",
              }}
            />
            {/* Send — top right, only when there's text */}
            {input.trim().length > 0 && (
              <button
                onClick={handleSend}
                className="absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
                </svg>
              </button>
            )}
            {/* Bottom hint row */}
            <div
              className="absolute bottom-0 left-0 right-0 flex items-center px-3 pb-2 pointer-events-none"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              <span className="font-mono text-pane-text-secondary/20">
                enter to post · shift+enter for newline · esc to cancel
              </span>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setComposing(true)}
            className="w-full text-left font-mono text-pane-text-secondary/25 hover:text-pane-text-secondary/40 transition-colors btn-press px-5 py-3"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            + observe
          </button>
        )}
      </div>
    </div>
  );
}
