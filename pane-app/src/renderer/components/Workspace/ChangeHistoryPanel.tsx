import { useState, useEffect, useCallback, useRef } from "react";
import { getChangeHistory, revertChange, type ChangeEntry } from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import { MicroIndicator } from "../shared";
import { ExpandedEditInput, ExpandedWriteInput } from "./ToolActivity";

interface ChangeHistoryPanelProps {
  projectId: string;
}

export function ChangeHistoryPanel({ projectId }: ChangeHistoryPanelProps) {
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadChanges = useCallback(async () => {
    try {
      const result = await getChangeHistory(projectId);
      setChanges(result.changes || []);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Only poll while the panel is actually visible in the viewport.
  // The panel is always mounted (hidden by CSS data-mode) so without
  // this gate it fires 30 SQLite queries/minute regardless of visibility.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const onVisible = () => {
      loadChanges();
      interval = setInterval(loadChanges, 2000);
    };

    const onHidden = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onVisible();
          else onHidden();
        }
      },
      { threshold: 0 },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (interval) clearInterval(interval);
    };
  }, [loadChanges]);

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-pane-bg relative">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-pane-border/10">
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-pane-text-secondary/60"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            history
          </span>
          <span
            className="font-mono text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {changes.length}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-1 custom-scrollbar">
        {isLoading ? (
          <div
            className="flex items-center justify-center h-full font-mono text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            ·
          </div>
        ) : changes.length === 0 ? (
          <div
            className="flex items-center justify-center h-full font-mono text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            no changes yet
          </div>
        ) : (
          <div>
            {changes.map((change) => (
              <ChangeItem
                key={change.id}
                change={change}
                projectId={projectId}
                onReverted={loadChanges}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ChangeItemProps {
  change: ChangeEntry;
  projectId: string;
  onReverted: () => void;
}

function ChangeItem({ change, projectId, onReverted }: ChangeItemProps) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const [reverting, setReverting] = useState(false);

  const isWrite = !change.oldString;
  const label = isWrite ? "write" : "edit";

  // Collapsed by default — user expands on demand
  const expanded = userToggle !== null ? userToggle : false;

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${date} · ${time}`;
  };

  const handleRevert = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const project = useProjectsStore.getState().projects.get(projectId);
    if (!project) return;
    setReverting(true);
    try {
      await revertChange(projectId, change.id, project.root);
      onReverted();
    } catch {
      // ignore
    } finally {
      setReverting(false);
    }
  };

  // Build input object matching the shape ExpandedEditInput/ExpandedWriteInput expect
  const input: Record<string, unknown> = isWrite
    ? { content: change.newString, file_path: change.file }
    : { old_string: change.oldString, new_string: change.newString, file_path: change.file };

  return (
    <div
      className={`rounded-md border transition-all duration-200 mx-1 ${
        expanded
          ? "border-[var(--pane-border-soft)] bg-pane-bg/60 mb-2"
          : "border-transparent hover:border-[var(--pane-border-soft)] mb-0.5"
      }`}
    >
      {/* Row — identical structure to ToolActivity */}
      <button
        onClick={() => setUserToggle(!expanded)}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-4 group"
        style={{ fontSize: "var(--pane-font-size-sm)", minHeight: "2.5rem" }}
      >
        <MicroIndicator
          variant="subtle"
          animate={false}
          size={5}
          ariaLabel="change recorded"
        />
        <span className="shrink-0 opacity-70" style={{ color: "var(--pane-terminal)" }}>
          {label}
        </span>
        <span className="truncate">{change.file}</span>
        <span
          className="ml-auto shrink-0 font-mono text-pane-text-secondary/30"
          style={{ fontSize: "10px" }}
        >
          {formatTime(change.timestamp)}
        </span>
        <span
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && (
        <div>
          {isWrite
            ? <ExpandedWriteInput input={input} />
            : <ExpandedEditInput input={input} />
          }

          {/* Revert action */}
          <div className="px-4 py-2 border-t border-pane-text-secondary/10 flex justify-end">
            <button
              onClick={handleRevert}
              disabled={reverting}
              className="font-mono text-pane-text-secondary/30 hover:text-pane-error/70 transition-colors disabled:opacity-30"
              style={{ fontSize: "10px" }}
            >
              {reverting ? "reverting..." : "revert"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
