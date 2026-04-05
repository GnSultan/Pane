import { useEffect, useRef, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLensStore } from "../../stores/lens";
import { useReviewStore } from "../../stores/review";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useMindStore } from "../../stores/mind";
import { lensPostAdd, lensPostsList, lensPostDelete, runReview, reviewSessionLatest, type LensPost, type ReviewFinding } from "../../lib/tauri-commands";
import { SlashMenu } from "../shared";

// Delete confirmation helper — matches Mind pattern (1-click "confirm?", 2-click delete with auto-revert)

const PUNK_PERSONAS: Record<string, { name: string; role: string }> = {
  bug:        { name: "maya", role: "debugger" },
  reflection: { name: "noor", role: "constructive thinker" },
  sentinel:   { name: "zara", role: "the auditor" },
};

// ─── PostItem ──────────────────────────────────────────────────────────────

const POST_CLAMP_THRESHOLD = 220;

function PostItem({
  post,
  showComments,
  onToggleComments,
  userName,
  onDelete,
}: {
  post: LensPost;
  showComments: boolean;
  onToggleComments: () => void;
  userName: string;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPunk = post.contributor !== "user";
  const persona = isPunk ? PUNK_PERSONAS[post.contributor] : null;
  const name = persona ? persona.name : (userName || "you");
  const commentCount = post.comment_count ?? 0;
  const isLong = post.content.length > POST_CLAMP_THRESHOLD;

  const handleDeleteClick = () => {
    if (confirmDelete) {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      onDelete();
    } else {
      setConfirmDelete(true);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

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
                onClick={handleDeleteClick}
                className="flex items-center transition-colors btn-press font-mono hover:!opacity-100"
                style={{
                  fontSize: "var(--pane-font-size-xs)",
                  color: confirmDelete
                    ? "var(--pane-error)"
                    : "var(--pane-text-secondary)",
                  opacity: confirmDelete ? 0.8 : 0.25,
                }}
              >
                {confirmDelete ? "confirm?" : "delete"}
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// ─── Lens ──────────────────────────────────────────────────────────────────

// ─── Review Section ──────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, note: 2 };
const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-red-400/70",
  warning: "text-amber-400/70",
  note: "text-pane-text-secondary/50",
};

function ReviewSection({ projectId, workingDir }: { projectId: string; workingDir: string }) {
  const { session, findings, running, progress, setSession, setFindings, setRunning, setAllProgress, setProgress } = useReviewStore();

  // Load latest review on mount
  useEffect(() => {
    reviewSessionLatest(projectId).then((result) => {
      if (result?.session) {
        setSession(result.session);
        setFindings(result.findings || []);
      }
    }).catch(() => {});
  }, [projectId]);

  // Listen for review progress events
  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI: { on: (ch: string, fn: (data: unknown) => void) => () => void } }).electronAPI;

    const unlistenProgress = electronAPI.on("pane://review-progress", (data: any) => {
      if (data.projectId !== projectId) return;
      if (data.status === "running" && data.punks) {
        setAllProgress(data.punks);
      } else if (data.punk) {
        setProgress(data.punk, data.status);
      }
    });

    const unlistenComplete = electronAPI.on("pane://review-complete", (data: any) => {
      if (data.projectId !== projectId) return;
      setRunning(false);
      if (data.findings) setFindings(data.findings);
      if (data.sessionId) {
        setSession({
          id: data.sessionId,
          project_id: projectId,
          status: "completed",
          diff_summary: null,
          base_ref: null,
          punk_count: 3,
          finding_count: data.findings?.length || 0,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
      }
    });

    return () => { unlistenProgress(); unlistenComplete(); };
  }, [projectId]);

  const handleReview = async () => {
    setRunning(true);
    setFindings([]);
    try {
      await runReview(projectId, workingDir);
    } catch {
      setRunning(false);
    }
  };

  // Group findings by punk
  const grouped = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    if (!grouped.has(f.punk)) grouped.set(f.punk, []);
    grouped.get(f.punk)!.push(f);
  }
  // Sort within each group by severity
  for (const [, arr] of grouped) {
    arr.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2));
  }

  return (
    <div className="mb-6">
      {/* Review button + progress */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={handleReview}
          disabled={running}
          className={`font-mono text-[11px] tracking-wider transition-colors btn-press ${
            running
              ? "text-pane-text-secondary/30 cursor-default"
              : "text-[var(--pane-terminal)]/60 hover:text-[var(--pane-terminal)]"
          }`}
        >
          {running ? "reviewing" : "review"}
        </button>
        {running && Object.entries(progress).map(([punk, status]) => (
          <span
            key={punk}
            className={`font-mono text-[10px] tracking-wider ${
              status === "done" ? "text-emerald-500/60"
              : status === "running" ? "text-[var(--pane-terminal)]/60"
              : status === "failed" ? "text-red-400/60"
              : "text-pane-text-secondary/20"
            }`}
          >
            {punk} {status === "done" ? "●" : status === "running" ? "..." : status === "failed" ? "x" : "·"}
          </span>
        ))}
        {!running && session && (
          <span className="font-mono text-[10px] text-pane-text-secondary/30 tracking-wider">
            {findings.length} finding{findings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Findings */}
      {findings.length > 0 && (
        <div className="space-y-4">
          {[...grouped.entries()].map(([punk, punkFindings]) => (
            <div key={punk}>
              {punkFindings.map((f) => (
                <div key={f.id} className="mb-3 pl-3 border-l border-pane-text/5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[10px] text-[var(--pane-terminal)]/50 tracking-wider">{punk}</span>
                    <span className={`font-mono text-[10px] tracking-wider ${SEVERITY_COLOR[f.severity] || "text-pane-text-secondary/50"}`}>
                      {f.severity}
                    </span>
                    {f.location && (
                      <span className="font-mono text-[10px] text-pane-text-secondary/30 tracking-wider">
                        {f.location}
                      </span>
                    )}
                    {f.remediation && (
                      <button
                        onClick={() => {
                          const prompt = `${punk} found an issue that needs fixing:\n\n**Issue:** ${f.finding}\n\n**Location:** ${f.location || "see details"}\n\n**Recommended fix:** ${f.remediation}\n\nImplement this fix.`;
                          // Switch to conversation and prefill the prompt
                          const store = useProjectsStore.getState();
                          store.setMode(projectId, "conversation");
                          // Dispatch event for InputBar to pick up
                          window.dispatchEvent(new CustomEvent("pane:prefill-prompt", { detail: { prompt } }));
                        }}
                        className="font-mono text-[10px] tracking-wider text-[var(--pane-terminal)]/40 hover:text-[var(--pane-terminal)] transition-colors btn-press"
                      >
                        fix
                      </button>
                    )}
                  </div>
                  <p
                    className="text-pane-text-secondary/70 leading-relaxed m-0"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    {f.finding}
                  </p>
                  {f.remediation && (
                    <p
                      className="text-pane-text-secondary/40 leading-relaxed m-0 mt-1"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {f.remediation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Lens({ projectId }: { projectId: string }) {
  const posts = useLensStore(useShallow((s) => s.posts.filter((p) => p.project_id === projectId)));
  const appendPost = useLensStore((s) => s.appendPost);
  const setPosts = useLensStore((s) => s.setPosts);
  const deletePost = useLensStore((s) => s.deletePost);
  const setLoaded = useLensStore((s) => s.setLoaded);
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
        {/* Review section — on-demand punk analysis */}
        <ReviewSection projectId={projectId} workingDir={workingDir} />

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
