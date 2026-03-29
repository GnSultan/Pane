import { useShallow } from "zustand/react/shallow";
import { useLensStore } from "../../stores/lens";
import { useProjectsStore } from "../../stores/projects";
import type { LensPost } from "../../lib/tauri-commands";

const PUNK_NAMES: Record<string, string> = {
  bug:        "maya",
  reflection: "noor",
  sentinel:   "zara",
};

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

interface PunkActivityRowProps {
  post: LensPost;
  onDismiss: (id: string) => void;
  onClick: (post: LensPost) => void;
}

function PunkActivityRow({ post, onDismiss, onClick }: PunkActivityRowProps) {
  const punkName = PUNK_NAMES[post.contributor] ?? post.contributor;
  const preview = stripMarkdown(post.content).slice(0, 120);

  return (
    <div
      className="group flex items-baseline gap-2 cursor-pointer hover:bg-pane-surface/50 rounded px-2 py-1 transition-colors"
      onClick={() => onClick(post)}
    >
      <span
        className="shrink-0 w-1.5 h-1.5 rounded-full mt-[5px] self-start"
        style={{ background: "var(--pane-terminal)" }}
      />
      <span
        className="shrink-0 font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)" }}
      >
        {punkName}
      </span>
      <span
        className="flex-1 font-mono text-pane-text-secondary/70 truncate"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {preview}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(post.id); }}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-pane-text-secondary/40
                   hover:text-pane-text-secondary transition-opacity leading-none"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
        title="dismiss"
      >
        ×
      </button>
    </div>
  );
}

const MAX_VISIBLE = 3;

export function PunkActivityStrip({ projectId }: { projectId: string }) {
  const unreadPosts = useLensStore(
    useShallow((s) => s.unreadPunkPosts.filter((p) => p.project_id === projectId)),
  );
  const dismissPunkPost = useLensStore((s) => s.dismissPunkPost);
  const clearUnreadPunkPosts = useLensStore((s) => s.clearUnreadPunkPosts);
  const setExpandedCommentsId = useLensStore((s) => s.setExpandedCommentsId);
  const setMode = useProjectsStore((s) => s.setMode);

  if (unreadPosts.length === 0) return null;

  const visible = unreadPosts.slice(-MAX_VISIBLE).reverse();
  const overflow = unreadPosts.length - MAX_VISIBLE;

  const handleClick = (post: LensPost) => {
    setExpandedCommentsId(post.id);
    setMode(projectId, "lens");
    clearUnreadPunkPosts(projectId);
  };

  const handleDismissAll = () => clearUnreadPunkPosts(projectId);

  return (
    <div
      className="mb-4 rounded-lg bg-pane-surface animate-fadeSlideDown"
      style={{ padding: "6px 4px" }}
    >
      {visible.map((post) => (
        <PunkActivityRow
          key={post.id}
          post={post}
          onDismiss={dismissPunkPost}
          onClick={handleClick}
        />
      ))}
      {(overflow > 0 || unreadPosts.length > 1) && (
        <div className="flex items-center gap-3 px-2 pt-1">
          {overflow > 0 && (
            <button
              onClick={() => { setMode(projectId, "lens"); clearUnreadPunkPosts(projectId); }}
              className="font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary/70 transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              +{overflow} more in lens
            </button>
          )}
          <button
            onClick={handleDismissAll}
            className="font-mono text-pane-text-secondary/30 hover:text-pane-text-secondary/60 transition-colors ml-auto"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            dismiss all
          </button>
        </div>
      )}
    </div>
  );
}
