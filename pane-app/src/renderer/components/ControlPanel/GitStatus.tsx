import { useState, useEffect } from "react";
import { getGitLog, getGitStatus } from "../../lib/tauri-commands";
import type { GitCommit, GitStatusInfo } from "../../lib/tauri-commands";

const electronAPI = (window as any).electronAPI;

interface GitStatusProps {
  root: string;
  projectId: string;
}

function CommitRow({ commit: c }: { commit: GitCommit }) {
  const [hovered, setHovered] = useState(false);

  if (hovered) {
    return (
      <div
        className=" px-3 py-1.5 bg-pane-surface border-y border-pane-border/40"
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-pane-text-secondary/50 shrink-0">{c.hash}</span>
          <span className="text-pane-text-secondary/30 ml-auto shrink-0">{c.date}</span>
        </div>
        <p className="text-pane-text mt-1 leading-relaxed whitespace-pre-wrap break-words">
          {c.message}
        </p>
        <span className="text-pane-text-secondary/40 mt-0.5 block">{c.author}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-baseline gap-2  py-0.5 px-3 hover:bg-pane-surface/50 cursor-default"
      style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      onMouseEnter={() => setHovered(true)}
    >
      <span className="text-pane-text-secondary/50 shrink-0">{c.hash}</span>
      <span className="text-pane-text truncate flex-1">{c.message}</span>
      <span className="text-pane-text-secondary/30 shrink-0">{c.date}</span>
    </div>
  );
}

export function GitStatus({ root, projectId }: GitStatusProps) {
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);

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

  const fileEntries = status ? Object.entries(status.files) : [];
  const fileCount = fileEntries.length;

  const handleCommit = async () => {
    if (!commitMessage.trim() || committing) return;

    setCommitting(true);
    try {
      await electronAPI.invoke("git_commit", { path: root, message: commitMessage });
      setCommitMessage("");
      // Refresh status
      const newStatus = await getGitStatus(root);
      setStatus(newStatus);
      const newCommits = await getGitLog(root, 20);
      setCommits(newCommits);
    } catch (err) {
      console.error("Commit failed:", err);
    } finally {
      setCommitting(false);
    }
  };

  const handlePush = async () => {
    try {
      await electronAPI.invoke("git_push", { path: root });
      alert("Pushed successfully");
    } catch (err: any) {
      alert(`Push failed: ${err.message || "Unknown error"}`);
    }
  };

  const handlePull = async () => {
    try {
      await electronAPI.invoke("git_pull", { path: root });
      // Refresh after pull
      const newStatus = await getGitStatus(root);
      setStatus(newStatus);
      const newCommits = await getGitLog(root, 20);
      setCommits(newCommits);
      alert("Pulled successfully");
    } catch (err: any) {
      alert(`Pull failed: ${err.message || "Unknown error"}`);
    }
  };

  if (loading) {
    return (
      <p
        className="text-pane-text-secondary/40 px-3 py-2"
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      >
        loading...
      </p>
    );
  }

  return (
    <div className="flex flex-col max-h-[300px]">
      {/* Tab bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-pane-border">
        <button
          onClick={() => setTab("changes")}
          className={`text-xs px-2 py-0.5 rounded ${
            tab === "changes"
              ? "bg-pane-text/10 text-pane-text"
              : "text-pane-text-secondary/50 hover:text-pane-text-secondary"
          }`}
        >
          changes {fileCount > 0 && `(${fileCount})`}
        </button>
        <button
          onClick={() => setTab("history")}
          className={`text-xs px-2 py-0.5 rounded ${
            tab === "history"
              ? "bg-pane-text/10 text-pane-text"
              : "text-pane-text-secondary/50 hover:text-pane-text-secondary"
          }`}
        >
          history
        </button>
      </div>

      {/* Changes tab */}
      {tab === "changes" && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* File list */}
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {fileCount === 0 ? (
              <p
                className="text-pane-text-secondary/40 px-3 py-2"
                style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
              >
                no uncommitted changes
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

          {/* Commit UI */}
          <div className="border-t border-pane-border p-2 space-y-1.5">
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
              placeholder="commit message (enter to commit)"
              disabled={committing || fileCount === 0}
              className="w-full px-2 py-1 text-xs bg-pane-surface border border-pane-border rounded text-pane-text placeholder:text-pane-text-secondary/30 focus:outline-none focus:border-pane-text-secondary/50"
              style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            />
            <div className="flex gap-1.5">
              <button
                onClick={handlePull}
                className="flex-1 px-2 py-1 text-xs bg-pane-surface border border-pane-border rounded text-pane-text-secondary hover:text-pane-text hover:border-pane-text-secondary/50"
              >
                pull
              </button>
              <button
                onClick={handlePush}
                className="flex-1 px-2 py-1 text-xs bg-pane-surface border border-pane-border rounded text-pane-text-secondary hover:text-pane-text hover:border-pane-text-secondary/50"
              >
                push
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History tab */}
      {tab === "history" && (
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {commits.length === 0 ? (
            <p
              className="text-pane-text-secondary/40 px-3 py-2"
              style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            >
              no commits
            </p>
          ) : (
            commits.map((c) => <CommitRow key={c.hash} commit={c} />)
          )}
        </div>
      )}
    </div>
  );
}
