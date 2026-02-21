import { useRef, useCallback, useEffect, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useCodeMirror } from "../../hooks/useCodeMirror";
import { writeFile } from "../../lib/tauri-commands";
import { getFileName } from "../../lib/file-utils";
import { markFileWritten } from "../../hooks/useFileWatcher";

export function FileViewer() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const activeProject = useProjectsStore((s) => {
    if (!s.activeProjectId) return undefined;
    return s.projects.get(s.activeProjectId);
  });

  const activeFilePath = activeProject?.activeFilePath ?? null;
  const activeFileContent = activeProject?.activeFileContent ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving">("clean");

  const handleChange = useCallback(
    (content: string) => {
      if (!activeFilePath || !activeProjectId) return;

      setSaveState("dirty");

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(async () => {
        if (!activeFilePath || !activeProjectId) return;
        setSaveState("saving");
        try {
          markFileWritten(activeFilePath);
          await writeFile(activeFilePath, content);
          useProjectsStore.getState().updateFileContent(activeProjectId, content);
          setSaveState("clean");
        } catch (err) {
          console.error("Auto-save failed:", err);
          setSaveState("dirty");
        }
      }, 800);
    },
    [activeFilePath, activeProjectId],
  );

  useEffect(() => {
    setSaveState("clean");
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, [activeFilePath]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const mode = activeProject?.mode ?? "conversation";
  const viewRef = useCodeMirror(containerRef, activeFileContent, activeFilePath, handleChange);

  // Auto-focus editor when switching to viewer mode
  useEffect(() => {
    if (mode === "viewer" && viewRef.current) {
      viewRef.current.focus();
    }
  }, [mode, viewRef]);

  // Listen for focus-editor event (from Cmd+/ toggle)
  useEffect(() => {
    const handler = () => {
      setTimeout(() => viewRef.current?.focus(), 0);
    };
    window.addEventListener("pane:focus-editor", handler);
    return () => window.removeEventListener("pane:focus-editor", handler);
  }, [viewRef]);

  if (!activeFilePath || activeFileContent === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-pane-text-secondary/30 font-mono tracking-[0.1em]"
           style={{ fontSize: "var(--pane-font-size)" }}>
          no file open
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-10 flex items-center px-6 border-b border-pane-border/60 shrink-0">
        <span className="text-pane-text-secondary text-xs font-mono truncate flex-1 tracking-wide">
          {getFileName(activeFilePath)}
        </span>
        <span className="text-[10px] font-mono ml-3">
          {saveState === "dirty" && (
            <span className="text-pane-status-modified">●</span>
          )}
          {saveState === "saving" && (
            <span className="text-pane-text-secondary">saving...</span>
          )}
        </span>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
