import { useRef, useCallback, useEffect } from "react";
import AceEditor from "react-ace";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { writeFile } from "../../lib/tauri-commands";
import { markFileWritten } from "../../hooks/useFileWatcher";

// Import ace modes
import "ace-builds/src-noconflict/mode-javascript";
import "ace-builds/src-noconflict/mode-typescript";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/mode-html";
import "ace-builds/src-noconflict/mode-css";
import "ace-builds/src-noconflict/mode-scss";
import "ace-builds/src-noconflict/mode-less";
import "ace-builds/src-noconflict/mode-markdown";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/mode-rust";
import "ace-builds/src-noconflict/mode-jsx";
import "ace-builds/src-noconflict/mode-tsx";
import "ace-builds/src-noconflict/mode-golang";
import "ace-builds/src-noconflict/mode-ruby";
import "ace-builds/src-noconflict/mode-sh";
import "ace-builds/src-noconflict/mode-yaml";
import "ace-builds/src-noconflict/mode-toml";
import "ace-builds/src-noconflict/mode-sql";
import "ace-builds/src-noconflict/mode-c_cpp";
import "ace-builds/src-noconflict/mode-java";
import "ace-builds/src-noconflict/mode-swift";
import "ace-builds/src-noconflict/mode-kotlin";
import "ace-builds/src-noconflict/mode-php";
import "ace-builds/src-noconflict/mode-lua";
import "ace-builds/src-noconflict/mode-xml";
import "ace-builds/src-noconflict/mode-svg";
import "ace-builds/src-noconflict/mode-dockerfile";
import "ace-builds/src-noconflict/mode-makefile";
import "ace-builds/src-noconflict/mode-graphqlschema";
import "ace-builds/src-noconflict/mode-elixir";
import "ace-builds/src-noconflict/mode-haskell";
import "ace-builds/src-noconflict/mode-ocaml";
import "ace-builds/src-noconflict/mode-scala";
import "ace-builds/src-noconflict/mode-dart";
import "ace-builds/src-noconflict/mode-zig";
import "ace-builds/src-noconflict/mode-diff";
import "ace-builds/src-noconflict/mode-ini";
import "ace-builds/src-noconflict/mode-text";
// Import the custom Pane theme
import "../../lib/pane-ace-theme";

// Map file extensions to Ace modes
function getModeForFile(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';

  // Match by filename first (dotfiles, Makefile, Dockerfile, etc.)
  const nameMap: Record<string, string> = {
    'makefile': 'makefile',
    'gnumakefile': 'makefile',
    'dockerfile': 'dockerfile',
    'gemfile': 'ruby',
    'rakefile': 'ruby',
    '.bashrc': 'sh',
    '.zshrc': 'sh',
    '.bash_profile': 'sh',
    '.profile': 'sh',
    '.gitignore': 'text',
    '.env': 'ini',
    '.editorconfig': 'ini',
  };
  if (nameMap[name]) return nameMap[name];

  const modeMap: Record<string, string> = {
    // JavaScript / TypeScript
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'mts': 'typescript',
    'cts': 'typescript',
    'tsx': 'tsx',
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'svg': 'svg',
    'xml': 'xml',
    // Data / config
    'json': 'json',
    'jsonc': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    // Markdown
    'md': 'markdown',
    'mdx': 'markdown',
    // Shell
    'sh': 'sh',
    'bash': 'sh',
    'zsh': 'sh',
    'fish': 'sh',
    // Systems
    'rs': 'rust',
    'go': 'golang',
    'c': 'c_cpp',
    'h': 'c_cpp',
    'cpp': 'c_cpp',
    'cc': 'c_cpp',
    'cxx': 'c_cpp',
    'hpp': 'c_cpp',
    'zig': 'zig',
    // JVM
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    // Apple
    'swift': 'swift',
    // Scripting
    'py': 'python',
    'rb': 'ruby',
    'php': 'php',
    'lua': 'lua',
    'ex': 'elixir',
    'exs': 'elixir',
    'erl': 'elixir',
    'dart': 'dart',
    // Functional
    'hs': 'haskell',
    'ml': 'ocaml',
    'mli': 'ocaml',
    // Query / schema
    'sql': 'sql',
    'graphql': 'graphqlschema',
    'gql': 'graphqlschema',
    // Other
    'diff': 'diff',
    'patch': 'diff',
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
  const scrollPositions = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.scrollPositions ?? null;
  });
  const mode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });
  const isProcessing = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.conversation.isProcessing ?? false;
  });
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);

  const editorRef = useRef<AceEditor>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFilePathRef = useRef<string | null>(null);
  const followRef = useRef(true);
  const rafRef = useRef(0);
  const pendingProcessingContent = useRef<string | null>(null);
  const processingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (content: string) => {
      if (!activeFilePath || !activeProjectId) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        if (!activeFilePath || !activeProjectId) return;
        try {
          markFileWritten(activeFilePath);
          await writeFile(activeFilePath, content);
          useProjectsStore.getState().updateFileContent(activeProjectId, content);
        } catch (err) {
          console.error("Auto-save failed:", err);
        }
      }, 800);
      
      // Scroll to bottom to show the last edit position
      if (editorRef.current) {
        const editor = editorRef.current.editor;
        const session = editor.session;
        const lineCount = session.getLength();
        const lineHeight = editor.renderer.lineHeight;
        const scrollerHeight = editor.renderer.scroller.clientHeight;
        
        // Calculate scroll position to show the bottom of the file
        // Keep the last few lines visible
        const targetScrollTop = (lineCount * lineHeight) - (scrollerHeight * 0.7);
        editor.session.setScrollTop(Math.max(0, targetScrollTop));
      }
    },
    [activeFilePath, activeProjectId],
  );

  // Flush any pending processing content to the editor
  const flushProcessingContent = useCallback(() => {
    if (pendingProcessingContent.current !== null && editorRef.current) {
      const editor = editorRef.current.editor;
      editor.setValue(pendingProcessingContent.current, -1);
      pendingProcessingContent.current = null;
    }
  }, []);

  // Update editor content when file changes, saving/restoring scroll position.
  // During AI processing, same-file content updates are debounced (500ms) to avoid
  // full Ace reinit on every incremental AI write — setValue destroys and recreates
  // all DOM nodes, causing severe frame drops.
  useEffect(() => {
    if (editorRef.current && activeFileContent !== null) {
      const editor = editorRef.current.editor;
      const currentValue = editor.getValue();
      const isNewFile = prevFilePathRef.current !== activeFilePath;
      
      if (isNewFile || currentValue !== activeFileContent) {
        const pos = editor.getCursorPosition();
        const scrollTop = editor.session.getScrollTop();

        // Save position for the file we're leaving
        if (isNewFile && prevFilePathRef.current && activeProjectId) {
          useProjectsStore.getState().setScrollPosition(activeProjectId, prevFilePathRef.current, {
            scrollTop,
            cursor: pos,
          });
        }

        // New file switch — apply immediately (mount event, must show correct content)
        if (isNewFile) {
          // Clear any pending debounced update
          if (processingDebounceRef.current) {
            clearTimeout(processingDebounceRef.current);
            processingDebounceRef.current = null;
            pendingProcessingContent.current = null;
          }
          editor.setValue(activeFileContent, -1);

          // Restore last known position, or scroll to end
          const saved = activeFilePath && scrollPositions ? scrollPositions.get(activeFilePath) : null;
          requestAnimationFrame(() => {
            if (saved) {
              editor.session.setScrollTop(saved.scrollTop);
              editor.moveCursorToPosition(saved.cursor);
            } else {
              editor.navigateFileEnd();
            }
          });
        } else if (isProcessing) {
          // Same file during AI processing — debounce the update to avoid
          // thrashing the editor on every incremental AI write.
          pendingProcessingContent.current = activeFileContent;
          if (processingDebounceRef.current) clearTimeout(processingDebounceRef.current);
          processingDebounceRef.current = setTimeout(() => {
            flushProcessingContent();
          }, 500);
        } else {
          // Same file, not processing — apply immediately
          editor.setValue(activeFileContent, -1);
          editor.session.setScrollTop(scrollTop);
          editor.moveCursorToPosition(pos);
        }
      }
      prevFilePathRef.current = activeFilePath;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, [activeFilePath, activeFileContent, activeProjectId, scrollPositions, isProcessing, flushProcessingContent]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (processingDebounceRef.current) clearTimeout(processingDebounceRef.current);
    };
  }, []);

  // Auto-scroll to follow agent edits during processing
  useEffect(() => {
    if (!isProcessing || !editorRef.current) return;
    
    const editor = editorRef.current.editor;
    const tick = () => {
      if (followRef.current && editorRef.current) {
        // Get current cursor position
        const cursor = editor.getCursorPosition();
        // Get the line count and scroll to keep the cursor visible
        const lineHeight = editor.renderer.lineHeight;
        const scrollTop = editor.session.getScrollTop();
        const scrollerHeight = editor.renderer.scroller.clientHeight;
        
        // Calculate target scroll position to keep cursor in view
        const cursorY = cursor.row * lineHeight;
        const targetScrollTop = cursorY - scrollerHeight * 0.3; // Keep cursor at ~30% from top
        
        // Smooth scroll if needed
        if (Math.abs(targetScrollTop - scrollTop) > lineHeight) {
          editor.session.setScrollTop(targetScrollTop);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isProcessing]);

  // Wheel listener: disengage follow on upward scroll
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current.editor;
    const container = editor.renderer.scroller;
    
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    
    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  // Scroll listener: re-engage follow when user scrolls back to cursor position
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current.editor;
    const container = editor.renderer.scroller;
    
    const handleScroll = () => {
      if (!followRef.current && editorRef.current) {
        const cursor = editor.getCursorPosition();
        const lineHeight = editor.renderer.lineHeight;
        const scrollTop = editor.session.getScrollTop();
        const cursorY = cursor.row * lineHeight;
        const distanceFromCursor = Math.abs(cursorY - scrollTop);
        
        // Re-engage follow if user scrolls near the cursor position
        if (distanceFromCursor < lineHeight * 3) {
          followRef.current = true;
        }
      }
    };
    
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-focus editor when switching to viewer mode
  useEffect(() => {
    if (mode === "viewer" && editorRef.current) {
      const editor = editorRef.current.editor;
      editor.focus();
      editor.renderer.updateCursor();
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

  // Listen for scroll-to-line event (from FuzzyFinder code search)
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { line } = e.detail;
      if (line && editorRef.current) {
        const editor = editorRef.current.editor;
        // Scroll to the line (0-indexed, so subtract 1)
        const row = Math.max(0, line - 1);
        editor.scrollToRow(row);
        editor.gotoLine(row, 0, true);
      }
    };
    window.addEventListener("pane:scroll-to-line", handler as EventListener);
    return () => window.removeEventListener("pane:scroll-to-line", handler as EventListener);
  }, []);

  // Set top scroll margin to ~45% of editor height so the first line sits
  // near the middle of the screen on an empty file (typewriter feel).
  // Updates on resize so it works at any window size.
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current.editor;

    const updateMargin = () => {
      const height = editor.renderer.scroller.clientHeight;
      editor.renderer.setScrollMargin(Math.floor(height * 0.45), 0, 0, 0);
    };

    updateMargin();

    const ro = new ResizeObserver(updateMargin);
    ro.observe(editor.renderer.scroller);
    return () => ro.disconnect();
  }, [activeFilePath]);

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
      <div className="flex-1 min-h-0 w-full relative z-20">
      <AceEditor
        ref={editorRef}
        mode={getModeForFile(activeFilePath)}
        theme="pane"
        defaultValue={activeFileContent}
        onChange={handleChange}
        name="pane-editor"
        width="100%"
        height="100%"
        fontSize={editorFontSize}
        showPrintMargin={false}
        showGutter={true}
        highlightActiveLine={false}
        enableBasicAutocompletion={false}
        enableLiveAutocompletion={false}
        enableSnippets={false}
        setOptions={{
          showLineNumbers: true,
          tabSize: 2,
          useWorker: false,
          wrap: true,
          indentedSoftWrap: false,
          scrollPastEnd: 0.8 as unknown as boolean,
          highlightSelectedWord: false,
          cursorStyle: "ace",
        }}
        editorProps={{ $blockScrolling: true }}
      />
      </div>
    </div>
  );
}
