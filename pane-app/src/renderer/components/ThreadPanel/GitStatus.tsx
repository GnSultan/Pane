import { useState, useEffect, useRef, useCallback } from "react";
import {
  getGitLog,
  getGitStatus,
  getAheadBehind,
  draftCommitMessage,
  listBranches,
  checkoutBranch,
} from "../../lib/tauri-commands";
import type { GitCommit, GitStatusInfo } from "../../lib/tauri-commands";
import type { ElectronAPI } from "../../lib/electron";
import { CaretTextArea } from "../shared";

const electronAPI = window.electronAPI as ElectronAPI;

// ─── Status colour map ────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  M: "var(--pane-status-modified)",
  A: "var(--pane-status-added)",
  D: "var(--pane-status-deleted)",
  R: "var(--pane-status-renamed)",
  "?": "var(--pane-status-untracked)",
};

function statusColor(code: string): string {
  return STATUS_COLOR[code[0] ?? ""] ?? "var(--pane-text-secondary)";
}

// ─── Branch Picker ────────────────────────────────────────────────────────────

function BranchPicker({
  current,
  root,
  onSwitch,
}: {
  current: string;
  root: string;
  onSwitch: (b: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFetching(true);
    listBranches(root)
      .then(({ branches: bs }) => setBranches(bs))
      .catch(() => {})
      .finally(() => setFetching(false));
  }, [open, root]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 font-mono text-pane-text-secondary/50 hover:text-pane-text-secondary btn-press"
        style={{ fontSize: "10px" }}
      >
        <span>{current}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M1.5 3L4 5.5L6.5 3" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-52 bg-pane-bg ring-1 ring-pane-border/40 rounded-xl z-50 animate-fadeSlideUp">
          {fetching ? (
            <div className="px-4 py-3 font-mono text-pane-text-secondary/30 animate-pulse" style={{ fontSize: "11px" }}>
              loading…
            </div>
          ) : (
            <div className="p-1.5 flex flex-col gap-0.5 max-h-52 overflow-y-auto custom-scrollbar">
              {branches.map((b) => (
                <button
                  key={b}
                  onClick={() => { setOpen(false); if (b !== current) onSwitch(b); }}
                  className={`w-full text-left px-3 py-1.5 font-mono flex items-center gap-2.5 btn-press rounded-lg transition-colors
                    ${b === current
                      ? "text-pane-text ring-1 ring-pane-border/50"
                      : "text-pane-text-secondary hover:text-pane-text hover:ring-1 hover:ring-pane-border/35"
                    }`}
                  style={{ fontSize: "11px" }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: b === current ? "var(--pane-status-added)" : "transparent" }}
                  />
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Changed file row ──────────────────────────────────────────────────────────

function FileRow({ filePath, statusCode }: { filePath: string; statusCode: string }) {
  const slash = filePath.lastIndexOf("/");
  const dir = slash !== -1 ? filePath.slice(0, slash + 1) : "";
  const name = slash !== -1 ? filePath.slice(slash + 1) : filePath;

  return (
    <div
      className="flex items-baseline gap-3 px-6 py-0.5"
      style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
    >
      <span
        className="shrink-0 font-mono w-4 text-center"
        style={{ color: statusColor(statusCode), fontSize: "11px" }}
      >
        {statusCode[0]}
      </span>
      <span className="truncate min-w-0">
        {dir && <span className="text-pane-text-secondary/35">{dir}</span>}
        <span className="text-pane-text">{name}</span>
      </span>
    </div>
  );
}

// ─── Commit row ────────────────────────────────────────────────────────────────

function CommitRow({ commit: c }: { commit: GitCommit }) {
  const [expanded, setExpanded] = useState(false);

  // The body from %B includes the subject line at the top — show just the body
  // after the first line (if it differs from subject, there's extra content)
  const fullMessage = c.body.trim();
  const bodyLines = fullMessage.split("\n");
  // Skip first line if it repeats the subject
  const extraLines = bodyLines[0]?.trim() === c.subject
    ? bodyLines.slice(1).join("\n").trim()
    : fullMessage;

  return (
    <div onClick={() => setExpanded((v) => !v)} className="cursor-default group">
      {/* Collapsed: single tight row */}
      <div
        className={`flex items-baseline gap-3 px-6 py-1 ${expanded ? "bg-pane-surface/20" : "hover:bg-pane-surface/20"}`}
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      >
        <span
          className="font-mono shrink-0 w-[52px] truncate"
          style={{ color: "var(--pane-terminal)", opacity: 0.5, fontSize: "10px" }}
        >
          {c.hash}
        </span>
        <span className={`text-pane-text min-w-0 ${expanded ? "" : "truncate flex-1"}`}>
          {c.subject}
        </span>
        <span
          className="font-mono text-pane-text-secondary/25 shrink-0 ml-auto"
          style={{ fontSize: "10px" }}
        >
          {c.date}
        </span>
      </div>

      {/* Expanded: full message + author */}
      {expanded && (
        <div
          className="px-6 pt-0.5 pb-3 border-b border-pane-border/10"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        >
          {/* Show the body if it has extra content beyond the subject */}
          {extraLines && (
            <p className="text-pane-text/70 whitespace-pre-wrap leading-relaxed mb-2">
              {extraLines}
            </p>
          )}
          <span className="font-mono text-pane-text-secondary/35" style={{ fontSize: "10px" }}>
            {c.author}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── GitStatus ─────────────────────────────────────────────────────────────────

interface GitStatusProps {
  root: string;
  projectId: string;
}


export function GitStatus({ root, projectId }: GitStatusProps) {
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pushState, setPushState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [pullState, setPullState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [switchStatus, setSwitchStatus] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Load ────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const [s, cs, ab] = await Promise.all([
      getGitStatus(root).catch(() => ({ branch: "", files: {} } as GitStatusInfo)),
      getGitLog(root, 30).catch(() => [] as GitCommit[]),
      getAheadBehind(root).catch(() => ({ ahead: 0, behind: 0 })),
    ]);
    setStatus(s);
    setCommits(cs);
    setAhead(ab.ahead);
    setBehind(ab.behind);
    setLoading(false);
  }, [root]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // ── Auto-draft when panel opens ──────────────────────────────────────────────
  useEffect(() => {
    if (loading || !status) return;
    const count = Object.keys(status.files).length;
    if (count === 0 || commitMessage.trim()) return;
    setDrafting(true);
    draftCommitMessage(projectId, root)
      .then(({ draft }) => { if (draft && !commitMessage.trim()) setCommitMessage(draft); })
      .catch(() => {})
      .finally(() => setDrafting(false));
  }, [loading]);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const handleCommit = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    try {
      await electronAPI.invoke("git_commit", { path: root, message: commitMessage });
      setCommitMessage("");
      await load();
    } catch (err) {
      console.error("Commit failed:", err);
    } finally {
      setCommitting(false);
    }
  };

  const handlePush = async () => {
    if (pushState === "busy") return;
    setPushState("busy");
    try {
      const result = await electronAPI.invoke("git_push", { path: root }) as { success: boolean; error?: string };
      if (!result.success) {
        console.error("Push failed:", result.error);
        setPushState("err");
        return;
      }
      setPushState("ok");
      const ab = await getAheadBehind(root).catch(() => ({ ahead: 0, behind: 0 }));
      setAhead(ab.ahead);
      setBehind(ab.behind);
    } catch (err) {
      console.error("Push failed:", err);
      setPushState("err");
    }
    setTimeout(() => setPushState("idle"), 2500);
  };

  const handlePull = async () => {
    if (pullState === "busy") return;
    setPullState("busy");
    try {
      const result = await electronAPI.invoke("git_pull", { path: root }) as { success: boolean; error?: string };
      if (!result.success) {
        console.error("Pull failed:", result.error);
        setPullState("err");
        return;
      }
      await load();
      setPullState("ok");
    } catch (err) {
      console.error("Pull failed:", err);
      setPullState("err");
    }
    setTimeout(() => { setPullState("idle"); }, 2500);
  };

  const handleBranchSwitch = async (branch: string) => {
    setSwitchStatus("switching…");
    try {
      const result = await checkoutBranch(root, branch);
      if (!result.success) {
        const raw = result.error ?? "";
        const isDirty = raw.includes("overwritten") || raw.includes("uncommitted");
        if (isDirty) {
          setSwitchStatus("stashing…");
          const stashResult = await electronAPI.invoke("git_stash", { path: root }) as { success: boolean; error?: string };
          if (!stashResult.success) {
            setSwitchStatus("stash failed");
            setTimeout(() => setSwitchStatus(null), 3000);
            return;
          }
          setSwitchStatus("switching…");
          const retry = await checkoutBranch(root, branch);
          if (!retry.success) {
            setSwitchStatus("checkout failed");
            setTimeout(() => setSwitchStatus(null), 3000);
            return;
          }
        } else {
          setSwitchStatus("checkout failed");
          setTimeout(() => setSwitchStatus(null), 3000);
          return;
        }
      }
      await load();
      setSwitchStatus(null);
    } catch (err) {
      setSwitchStatus("checkout failed");
      setTimeout(() => setSwitchStatus(null), 3000);
      console.error("Branch switch failed:", err);
    }
  };

  const handleDraft = () => {
    setDrafting(true);
    draftCommitMessage(projectId, root)
      .then(({ draft }) => { if (draft) setCommitMessage(draft); })
      .catch(() => {})
      .finally(() => setDrafting(false));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleCommit();
    }
  };

  const fileEntries = status ? Object.entries(status.files) : [];
  const fileCount = fileEntries.length;

  // Sort M → A → D → rest
  const sorted = [...fileEntries].sort(([, a], [, b]) => {
    const o: Record<string, number> = { M: 0, A: 1, D: 2 };
    return (o[a[0] ?? ""] ?? 3) - (o[b[0] ?? ""] ?? 3);
  });

  const pushLabel =
    pushState === "busy" ? "pushing…" : pushState === "ok" ? "pushed" :
    pushState === "err" ? "failed" : ahead > 0 ? `push ${ahead}` : "push";
  const pullLabel =
    pullState === "busy" ? "pulling…" : pullState === "ok" ? "pulled" :
    pullState === "err" ? "failed" : behind > 0 ? `pull ${behind}` : "pull";

  const canCommit = !!commitMessage.trim() && !committing && fileCount > 0;

  return (
    <div className="flex flex-col h-full select-none">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      {/* z-40 + data-no-drag — beats the h-[50px] z-30 drag region so git controls stay clickable */}
      <div className="h-12 shrink-0 flex items-center px-6 gap-2.5 relative z-40" data-no-drag>
        <span
          className="font-mono text-pane-terminal/60 uppercase tracking-widest"
          style={{ fontSize: "10px" }}
        >
          git
        </span>

        {status?.branch && !loading && (
          <>
            <span className="text-pane-border/40" style={{ fontSize: "10px" }}>·</span>
            <BranchPicker current={status.branch} root={root} onSwitch={handleBranchSwitch} />
          </>
        )}

        {loading && (
          <span
            className="font-mono text-pane-text-secondary/25 animate-pulse"
            style={{ fontSize: "10px" }}
          >
            loading
          </span>
        )}

        {switchStatus ? (
          <span
            className="ml-auto font-mono text-pane-text-secondary/40 animate-pulse"
            style={{ fontSize: "10px" }}
          >
            {switchStatus}
          </span>
        ) : fileCount > 0 && !loading ? (
          <span
            className="ml-auto font-mono text-pane-text"
            style={{ fontSize: "10px" }}
          >
            {fileCount} {fileCount === 1 ? "change" : "changes"}
          </span>
        ) : null}
      </div>

      {/* ── Scrollable body ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">

        {sorted.length > 0 && (
          <div className="pb-3">
            {sorted.map(([fp, code]) => (
              <FileRow key={fp} filePath={fp} statusCode={code} />
            ))}
          </div>
        )}

        {fileCount === 0 && !loading && (
          <div className="px-6 py-3">
            <span
              className="text-pane-text-secondary/25 font-mono"
              style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            >
              working tree clean
            </span>
          </div>
        )}

        {/* History */}
        <div className={fileCount > 0 ? "border-t border-pane-border/15" : ""}>
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-6 py-2.5 btn-press text-left"
          >
            <span
              className="font-mono text-pane-terminal/35 uppercase tracking-widest"
              style={{ fontSize: "10px" }}
            >
              {historyOpen ? "▾" : "▸"} history
            </span>
            {commits.length > 0 && !historyOpen && (
              <span
                className="font-mono text-pane-text-secondary/20"
                style={{ fontSize: "10px" }}
              >
                · {commits.length}
              </span>
            )}
          </button>

          {historyOpen && (
            <div className="pb-4">
              {commits.length === 0 ? (
                <p
                  className="text-pane-text-secondary/25 font-mono px-6 py-1"
                  style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
                >
                  no commits yet
                </p>
              ) : (
                commits.map((c) => <CommitRow key={c.hash} commit={c} />)
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Commit area — one surface, textarea + pills inside ───────────────── */}
      <div className="shrink-0 rounded-t-xl ring-1 ring-pane-border/30 relative bg-pane-bg/80 backdrop-blur-md">

        {/* Commit button */}
        {canCommit && (
          <button
            onClick={handleCommit}
            className="absolute top-1.5 right-1.5 z-10 h-9 px-3 flex items-center justify-center
                       rounded-lg text-pane-text-secondary hover:text-pane-text
                       hover:bg-pane-text/[0.06] btn-press ring-1 ring-pane-border/40
                       transition-all duration-150 font-mono"
            style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            title="Commit (⌘↵)"
          >
            {committing ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="5" className="animate-circle-pulse" />
              </svg>
            ) : (
              "commit"
            )}
          </button>
        )}

        <CaretTextArea
          ref={textareaRef}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            drafting ? "drafting…"
            : fileCount === 0 ? "working tree clean"
            : "commit message"
          }
          disabled={committing || fileCount === 0}
          className="w-full"
          style={{
            fontSize: "var(--pane-panel-font-size)",
            lineHeight: "1.75",
            padding: "1.25rem 1.5rem 32px 1.5rem",
          }}
          minHeight={110}
          maxHeight={window.innerHeight * 0.4}
        />

        {/* Buttons — absolute bottom, floating inside the card, no background.
             pl-12 clears the Menu trigger button (absolute bottom-3 left-3 w-8 h-8 in Workspace),
             so the push/pull buttons aren't hidden beneath it. */}
        <div
          className="absolute bottom-0 left-0 right-0 flex items-center gap-2 p-1.5 pl-12 font-mono pointer-events-none"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          <button
            onClick={handlePush}
            disabled={pushState === "busy"}
            className={`pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
              bg-pane-bg/70 backdrop-blur-sm ring-1 ring-pane-border/25
              btn-press transition-colors disabled:opacity-40
              ${pushState === "ok"  ? "text-pane-status-added" :
                pushState === "err" ? "text-pane-error" :
                "text-pane-text-secondary/50 hover:text-pane-text-secondary"}`}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V2M3 5l3-3 3 3" />
            </svg>
            <span>{pushLabel}</span>
          </button>

          <button
            onClick={handlePull}
            disabled={pullState === "busy"}
            className={`pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
              bg-pane-bg/70 backdrop-blur-sm ring-1 ring-pane-border/25
              btn-press transition-colors disabled:opacity-40
              ${pullState === "ok"  ? "text-pane-status-added" :
                pullState === "err" ? "text-pane-error" :
                "text-pane-text-secondary/50 hover:text-pane-text-secondary"}`}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2v7M3 6l3 3 3-3" />
            </svg>
            <span>{pullLabel}</span>
          </button>

          {fileCount > 0 && !drafting && !commitMessage.trim() && (
            <button
              onClick={handleDraft}
              className="pointer-events-auto ml-auto inline-flex items-center px-3 py-1.5 rounded-md
                bg-pane-bg/70 backdrop-blur-sm ring-1 ring-pane-border/25
                btn-press text-pane-text-secondary/40 hover:text-pane-text-secondary/70"
            >
              draft
            </button>
          )}
          {drafting && (
            <span className="ml-auto text-pane-text-secondary/25 animate-pulse">drafting…</span>
          )}
        </div>
      </div>
    </div>
  );
}
