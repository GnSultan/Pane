import { useRef, useCallback, useEffect, useState } from "react";
import AceEditor from "react-ace";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { writeFile } from "../../lib/tauri-commands";
import { getFileName } from "../../lib/file-utils";
import { markFileWritten } from "../../hooks/useFileWatcher";

// Import ace modes and themes
import "ace-builds/src-noconflict/mode-javascript";
import "ace-builds/src-noconflict/mode-typescript";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/mode-html";
import "ace-builds/src-noconflict/mode-css";
import "ace-builds/src-noconflict/mode-markdown";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/mode-rust";
import "ace-builds/src-noconflict/mode-jsx";
import "ace-builds/src-noconflict/mode-tsx";
// Pane theme is in globals.css - no need to import Ace themes

// Map file extensions to Ace modes
function getModeForFile(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const modeMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'json': 'json',
    'html': 'html',
    'css': 'css',
    'md': 'markdown',
    'py': 'python',
    'rs': 'rust',
  };
  return modeMap[ext || ''] || 'text';
}

export function FileViewer() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const activeFilePath = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.activeFilePath ?? null;
  });
  const activeFileContent = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.activeFileContent ?? null;
  });
  const mode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);

  const editorRef = useRef<AceEditor>(null);
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

  // Update editor content when file changes
  useEffect(() => {
    if (editorRef.current && activeFileContent !== null) {
      const editor = editorRef.current.editor;
      const currentValue = editor.getValue();
      if (currentValue !== activeFileContent) {
        const cursorPos = editor.getCursorPosition();
        editor.setValue(activeFileContent, -1);
        editor.moveCursorToPosition(cursorPos);
      }
    }
    setSaveState("clean");
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, [activeFilePath, activeFileContent]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Auto-focus editor when switching to viewer mode
  useEffect(() => {
    if (mode === "viewer" && editorRef.current) {
      editorRef.current.editor.focus();
    }
  }, [mode]);

  // Listen for focus-editor event (from Cmd+/ toggle)
  useEffect(() => {
    const handler = () => {
      setTimeout(() => editorRef.current?.editor.focus(), 0);
    };
    window.addEventListener("pane:focus-editor", handler);
    return () => window.removeEventListener("pane:focus-editor", handler);
  }, []);

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

      <AceEditor
        ref={editorRef}
        mode={getModeForFile(activeFilePath)}
        defaultValue={activeFileContent}
        onChange={handleChange}
        name="pane-editor"
        width="100%"
        height="100%"
        fontSize={editorFontSize}
        showPrintMargin={false}
        showGutter={false}
        highlightActiveLine={false}
        setOptions={{
          enableBasicAutocompletion: true,
          enableLiveAutocompletion: false,
          enableSnippets: false,
          showLineNumbers: false,
          tabSize: 2,
          useWorker: false,
          wrap: true,
          scrollPastEnd: 0.5 as unknown as boolean,
        }}
        editorProps={{ $blockScrolling: true }}
      />
    </div>
  );
}
