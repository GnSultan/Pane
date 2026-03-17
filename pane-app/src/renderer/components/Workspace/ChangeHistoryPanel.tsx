import { useState, useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { getChangeHistory, type ChangeEntry } from "../../lib/tauri-commands";

const EMPTY_CHANGES: ChangeEntry[] = [];

interface ChangeHistoryPanelProps {
  projectId: string;
  onCollapse: () => void;
}

export function ChangeHistoryPanel({ projectId, onCollapse }: ChangeHistoryPanelProps) {
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
    <div className="mb-2 bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden animate-fadeSlideUp">
      <div className="px-4 py-3 border-b border-pane-border/10 flex items-center justify-between">
        <span className="text-pane-text-secondary text-xs uppercase tracking-wide">
          Change History ({changes.length})
        </span>
        <button
          onClick={onCollapse}
          className="text-pane-text-secondary/50 hover:text-pane-text-secondary/80 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      <div className="max-h-[300px] overflow-y-auto divide-y divide-pane-border/5">
        {changes.slice(0, 10).map((change) => (
          <ChangeItem key={change.id} change={change} />
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

function ChangeItem({ change }: { change: ChangeEntry }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const truncate = (str: string, len: number = 60) => {
    if (str.length <= len) return str;
    return str.slice(0, len) + "...";
  };

  return (
    <div 
      className="px-4 py-3 hover:bg-pane-text/[0.02] transition-colors cursor-pointer"
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-pane-text text-xs font-mono truncate max-w-[200px]">
          {change.file}
        </span>
        <span className="text-pane-text-secondary/40 text-xs">
          {formatTime(change.timestamp)}
        </span>
      </div>
      
      {isExpanded ? (
        <div className="space-y-1">
          <div className="text-xs">
            <span className="text-pane-text-secondary/50">Before:</span>
            <span className="text-pane-text-secondary ml-1 font-mono">
              {change.oldString}
            </span>
          </div>
          <div className="text-xs">
            <span className="text-pane-text-secondary/50">After:</span>
            <span className="text-pane-terminal ml-1 font-mono">
              {change.newString}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-pane-text-secondary/70 font-mono">
          {truncate(change.newString)}
        </div>
      )}
    </div>
  );
}
