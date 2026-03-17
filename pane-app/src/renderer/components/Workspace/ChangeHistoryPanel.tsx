import { useState, useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { getChangeHistory, revertChange, type ChangeEntry } from "../../lib/tauri-commands";

const EMPTY_CHANGES: ChangeEntry[] = [];

interface ChangeHistoryPanelProps {
  projectId: string;
  onCollapse: () => void;
}

export function ChangeHistoryPanel({ projectId, onCollapse }: ChangeHistoryPanelProps) {
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  const projectRoot = useProjectsStore(
    useShallow((s) => s.projects.get(projectId)?.root ?? ""),
  );

  useEffect(() => {
    loadChanges();
    
    // Reload every 2 seconds to catch new changes
    const interval = setInterval(loadChanges, 2000);
    return () => clearInterval(interval);
  }, [projectId]);

  const loadChanges = async () => {
    try {
      const result = await getChangeHistory(projectId);
      setChanges(result.changes || []);
    } catch (error) {
      console.error("Failed to load change history:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevert = async (changeId: string) => {
    if (!projectRoot) return;
    
    setRevertingId(changeId);
    try {
      const result = await revertChange(projectId, changeId, projectRoot);
      if (result.success) {
        // Reload changes after successful revert
        await loadChanges();
      } else {
        console.error("Failed to revert:", result.error);
      }
    } catch (error) {
      console.error("Error reverting change:", error);
    } finally {
      setRevertingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="mb-2 bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
        <div className="px-5 py-4 text-pane-text-secondary text-sm">
          Loading change history...
        </div>
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <div className="mb-2 bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
        <div className="px-5 py-4 text-pane-text-secondary text-sm">
          No changes recorded yet. Edits will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2 bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden animate-fadeSlideUp shadow-[0_0_12px_rgba(74,71,66,0.15)]">
      <div className="px-4 py-3 border-b border-pane-border/10 flex items-center justify-between">
        <span className="text-pane-text-secondary text-xs uppercase tracking-wide">
          Change History ({changes.length})
        </span>
        <button
          onClick={onCollapse}
          className="text-pane-text-secondary/50 hover:text-pane-text-secondary/80 transition-colors btn-press"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      <div className="max-h-[300px] overflow-y-auto divide-y divide-pane-border/5">
        {changes.slice(0, 10).map((change) => (
          <ChangeItem 
            key={change.id} 
            change={change} 
            onRevert={handleRevert}
            isReverting={revertingId === change.id}
          />
        ))}
        
        {changes.length > 10 && (
          <div className="px-4 py-2 text-center text-pane-text-secondary text-xs">
            +{changes.length - 10} more changes
          </div>
        )}
      </div>

      {/* Collapse handle at the bottom */}
      <button
        onClick={onCollapse}
        className="w-full flex items-center justify-start py-2.5 px-1
                   text-pane-text-secondary/25 hover:text-pane-text-secondary/50
                   transition-colors btn-press"
      >
        <svg width="12" height="7" viewBox="0 0 12 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 1L6 6L11 1" />
        </svg>
      </button>
    </div>
  );
}

function ChangeItem({ change, onRevert, isReverting }: { change: ChangeEntry; onRevert: (id: string) => void; isReverting: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const truncate = (str: string, len: number = 80) => {
    if (str.length <= len) return str;
    return str.slice(0, len) + "...";
  };

  // Extract just the filename from the path
  const fileName = change.file.split('/').pop() || change.file;
  const dirPath = change.file.substring(0, change.file.lastIndexOf('/'));

  return (
    <div className="px-4 py-3 hover:bg-pane-text/[0.02] transition-colors">
      <div 
        className="flex items-center justify-between mb-2 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-pane-text-secondary/40 shrink-0">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-pane-text text-xs font-mono truncate">
            {fileName}
          </span>
          {dirPath && (
            <span className="text-pane-text-secondary/40 text-xs font-mono truncate max-w-[100px]">
              {dirPath}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-pane-text-secondary/40 text-xs">
            {formatTime(change.timestamp)}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRevert(change.id);
            }}
            disabled={isReverting}
            className="text-pane-text-secondary/50 hover:text-pane-error transition-colors btn-press disabled:opacity-50"
            title="Revert this change"
          >
            {isReverting ? (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 7v6h6" />
                <path d="M3 13a9 9 0 1 0 3-7.7L3 7" />
              </svg>
            )}
          </button>
        </div>
      </div>
      
      {isExpanded && (
        <div className="space-y-2 ml-5">
          <div className="text-xs">
            <span className="text-pane-text-secondary/50 font-medium">Before:</span>
            <div className="mt-1 p-2 bg-pane-text/[0.03] rounded font-mono text-pane-text-secondary/80 break-all">
              {change.oldString || "(empty)"}
            </div>
          </div>
          <div className="text-xs">
            <span className="text-pane-text-secondary/50 font-medium">After:</span>
            <div className="mt-1 p-2 bg-pane-text/[0.05] rounded font-mono text-pane-text break-all">
              {change.newString || "(empty)"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
