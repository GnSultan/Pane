import { useState, useEffect } from "react";
import { getChangeHistory, type ChangeEntry } from "../../lib/tauri-commands";
import { MarkdownText } from "./MarkdownText";

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

  return (
    <div className="h-full flex flex-col bg-pane-bg relative z-20">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-4 border-b border-pane-border/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-pane-text text-sm font-medium">Change History</span>
          <span className="text-pane-text-secondary/50 text-xs font-mono">
            {changes.length} changes
          </span>
        </div>
        <button
          onClick={onCollapse}
          className="text-pane-text-secondary/50 hover:text-pane-text-secondary/80 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-pane-bg">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-pane-text-secondary text-sm">
            Loading change history...
          </div>
        ) : changes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-pane-text-secondary text-sm">
            No changes recorded yet. Edits will appear here.
          </div>
        ) : (
          <div className="space-y-0">
            {changes.map((change) => (
              <ChangeItem key={change.id} change={change} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeItem({ change }: { change: ChangeEntry }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [userToggle, setUserToggle] = useState<boolean | null>(null);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Get a summary of the change
  const getSummary = () => {
    const oldStr = change.oldString || "";
    const newStr = change.newString || "";
    
    // If old string is empty, it's a file creation
    if (!oldStr) {
      return `Created file: ${change.file}`;
    }
    
    // If new string is empty, it's a file deletion
    if (!newStr) {
      return `Deleted from: ${change.file}`;
    }
    
    // Otherwise, it's an edit - show a preview of the old string
    const previewLength = 50;
    const preview = oldStr.length > previewLength 
      ? oldStr.slice(0, previewLength) + "..." 
      : oldStr;
    
    return `Edit in ${change.file}: "${preview}"`;
  };

  // Determine expansion state
  const expanded = userToggle !== null ? userToggle : isExpanded;

  return (
    <div 
      className={`border-b border-pane-text-secondary/10 transition-all duration-200 ${expanded ? 'border-[var(--pane-border-soft)] bg-[var(--pane-bg)] mb-0' : 'border-transparent hover:border-[var(--pane-border-soft)] mb-0'}`}
    >
      <button
        onClick={() => {
          const newExpanded = !expanded;
          setUserToggle(newExpanded);
          setIsExpanded(newExpanded);
        }}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-5 group"
        style={{
          fontSize: "var(--pane-font-size-sm)",
          minHeight: '2.5rem'
        }}
      >
        {/* Timestamp */}
        <span className="shrink-0 opacity-50 text-[10px]">
          {formatDate(change.timestamp)} · {formatTime(change.timestamp)}
        </span>
        
        {/* File path */}
        <span className="shrink-0 opacity-70 text-pane-text-secondary/70">
          {change.file}
        </span>
        
        {/* Summary */}
        <span className="truncate">
          {getSummary()}
        </span>
        
        <span 
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-pane-text-secondary/10">
          <div className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                        leading-[1.6] space-y-0"
               style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {change.oldString && (
              <div className="px-5 py-4">
                <div className="text-[9px] uppercase tracking-wider mb-2 text-pane-text-secondary/40">
                  Original
                </div>
                <div className="opacity-50">
                  <MarkdownText text={`\`\`\`ts\n${change.oldString}\n\`\`\``} />
                </div>
              </div>
            )}
            {change.newString && (
              <div className="px-5 py-4 border-t border-pane-text-secondary/10">
                <div className="text-[9px] uppercase tracking-wider mb-2 text-pane-text-secondary/40">
                  Replacement
                </div>
                <MarkdownText text={`\`\`\`ts\n${change.newString}\n\`\`\``} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
