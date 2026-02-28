import { useState, useEffect, useRef, useCallback } from "react";
import { getGitLog, getGitStatus } from "../../lib/tauri-commands";
import type { GitCommit, GitStatusInfo } from "../../lib/tauri-commands";

const electronAPI = (window as any).electronAPI;

interface GitStatusProps {
  root: string;
}

function CommitRow({ commit: c }: { commit: GitCommit }) {
  const [hovered, setHovered] = useState(false);

  if (hovered) {
    return (
      <div
        className="px-3 py-1.5 bg-pane-surface border-y border-pane-border/40"
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-pane-text-secondary/60 shrink-0">{c.hash}</span>
          <span className="text-pane-text-secondary/40 ml-auto shrink-0">{c.date}</span>
        </div>
        <p className="text-pane-text mt-1 leading-relaxed whitespace-pre-wrap break-words">
          {c.message}
        </p>
        <span className="text-pane-text-secondary/50 mt-0.5 block">{c.author}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-baseline gap-2 py-0.5 px-3 hover:bg-pane-surface/50 cursor-default"
      style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      onMouseEnter={() => setHovered(true)}
    >
      <span className="text-pane-text-secondary/60 shrink-0">{c.hash}</span>
      <span className="text-pane-text truncate flex-1">{c.message}</span>
      <span className="text-pane-text-secondary/40 shrink-0">{c.date}</span>
    </div>
  );
}

export function GitStatus({ root }: GitStatusProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushState, setPushState] = useState<"idle" | "pushing" | "pushed" | "error">("idle");
  const [pullState, setPullState] = useState<"idle" | "pulling" | "pulled" | "error">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load git status and commits
  useEffect(() => {
    setLoading(true);
    Promise.all([
      getGitStatus(root).catch(() => ({ branch: "", files: {} })),
      getGitLog(root, 20).catch(() => []),
    ])
      .then(([statusData, commitsData]) => {
        setStatus(statusData);
        setCommits(commitsData);
      })
      .finally(() => setLoading(false));
  }, [root]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [commitMessage]);

  const fileEntries = status ? Object.entries(status.files) : [];
  const fileCount = fileEntries.length;

  const refresh = useCallback(async () => {
    const [newStatus, newCommits] = await Promise.all([
      getGitStatus(root).catch(() => ({ branch: "", files: {} })),
      getGitLog(root, 20).catch(() => []),
    ]);
    setStatus(newStatus);
    setCommits(newCommits);
  }, [root]);

  const handleCommit = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    try {
      await electronAPI.invoke("git_commit", { path: root, message: commitMessage });
      setCommitMessage("");
      await refresh();
    } catch (err) {
      console.error("Commit failed:", err);
    } finally {
      setCommitting(false);
    }
  };

  const handlePush = async () => {
    if (pushState === "pushing") return;
    setPushState("pushing");
    try {
      await electronAPI.invoke("git_push", { path: root });
      setPushState("pushed");
      setTimeout(() => setPushState("idle"), 2000);
    } catch {
      setPushState("error");
      setTimeout(() => setPushState("idle"), 2000);
    }
  };

  const handlePull = async () => {
    if (pullState === "pulling") return;
    setPullState("pulling");
    try {
      await electronAPI.invoke("git_pull", { path: root });
      await refresh();
      setPullState("pulled");
      setTimeout(() => setPullState("idle"), 2000);
    } catch {
      setPullState("error");
      setTimeout(() => setPullState("idle"), 2000);
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        handleCommit();
      }
    },
    [commitMessage, committing],
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p
          className="text-pane-text-secondary/40"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        >
          loading...
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: branch + pull/push */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-pane-border">
        <span
          className="text-pane-text truncate"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        >
          {status?.branch || "detached"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handlePull}
            disabled={pullState === "pulling"}
            className="text-pane-text-secondary/60 hover:text-pane-text btn-press"
            style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
          >
            {pullState === "pulling" ? (
              <span className="flex items-center gap-0.5">
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse1" />
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse2" />
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse3" />
              </span>
            ) : pullState === "pulled" ? (
              <span className="text-pane-status-added">pulled</span>
            ) : pullState === "error" ? (
              <span className="text-pane-error">failed</span>
            ) : "pull"}
          </button>
          <button
            onClick={handlePush}
            disabled={pushState === "pushing"}
            className="text-pane-text-secondary/60 hover:text-pane-text btn-press"
            style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
          >
            {pushState === "pushing" ? (
              <span className="flex items-center gap-0.5">
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse1" />
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse2" />
                <span className="inline-block w-1 h-1 rounded-full bg-pane-text-secondary animate-dotPulse3" />
              </span>
            ) : pushState === "pushed" ? (
              <span className="text-pane-status-added">pushed</span>
            ) : pushState === "error" ? (
              <span className="text-pane-error">failed</span>
            ) : "push"}
          </button>
        </div>
      </div>

      {/* Scrollable body: changes + history */}
      <div className="flex-1 overflow-y-auto min-h-0" style={{ willChange: "transform" }}>
        {/* Changes section */}
        <div className="py-1">
          <div className="px-3 py-1">
            <span
              className="text-pane-text-secondary/50 uppercase tracking-wider"
              style={{ fontSize: "10px" }}
            >
              changes{fileCount > 0 ? ` (${fileCount})` : ""}
            </span>
          </div>
          {fileCount === 0 ? (
            <p
              className="text-pane-text-secondary/40 px-3 py-1"
              style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            >
              clean
            </p>
          ) : (
            fileEntries.map(([path, statusCode]) => (
              <div
                key={path}
                className="flex items-baseline gap-2 px-3 py-0.5 hover:bg-pane-surface/50"
                style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
              >
                <span className="text-pane-accent-secondary shrink-0 w-6">
                  {statusCode}
                </span>
                <span className="text-pane-text truncate">{path}</span>
              </div>
            ))
          )}
        </div>

        {/* History section */}
        <div className="py-1">
          <div className="px-3 py-1">
            <span
              className="text-pane-text-secondary/50 uppercase tracking-wider"
              style={{ fontSize: "10px" }}
            >
              history
            </span>
          </div>
          {commits.length === 0 ? (
            <p
              className="text-pane-text-secondary/40 px-3 py-1"
              style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            >
              no commits
            </p>
          ) : (
            commits.map((c) => <CommitRow key={c.hash} commit={c} />)
          )}
        </div>
      </div>

      {/* Commit input */}
      <div className="shrink-0 border-t border-pane-border p-2">
        <textarea
          ref={textareaRef}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={fileCount === 0 ? "nothing to commit" : "commit message"}
          disabled={committing || fileCount === 0}
          rows={1}
          className="w-full px-2 py-1.5 bg-transparent
                     text-pane-text placeholder:text-pane-text-secondary/30
                     focus:outline-none
                     resize-none overflow-y-auto disabled:opacity-40"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        />
        {commitMessage.trim() && fileCount > 0 && (
          <p
            className="text-pane-text-secondary/40 px-1 pt-1"
            style={{ fontSize: "10px" }}
          >
            cmd+enter to commit
          </p>
        )}
      </div>
    </div>
  );
}
