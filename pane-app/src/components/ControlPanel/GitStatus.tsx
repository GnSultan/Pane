import { useState, useEffect } from "react";
import { getGitLog } from "../../lib/tauri-commands";
import type { GitCommit } from "../../lib/tauri-commands";

interface GitLogProps {
  root: string;
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

export function GitLog({ root }: GitLogProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getGitLog(root, 20)
      .then(setCommits)
      .catch(() => setCommits([]))
      .finally(() => setLoading(false));
  }, [root]);

  if (loading) {
    return (
      <p
        className="text-pane-text-secondary/40  px-3 py-2"
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      >
        loading...
      </p>
    );
  }

  if (commits.length === 0) {
    return (
      <p
        className="text-pane-text-secondary/40  px-3 py-2"
        style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
      >
        no commits
      </p>
    );
  }

  return (
    <div className="max-h-[240px] overflow-y-auto py-1">
      {commits.map((c) => (
        <CommitRow key={c.hash} commit={c} />
      ))}
    </div>
  );
}
