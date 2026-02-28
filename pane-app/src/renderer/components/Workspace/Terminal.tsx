import { useState, useRef, useEffect, useCallback } from "react";
import { createPty, writePty, destroyPty, destroyAllPtysForProject, onPtyData, onPtyExit, getHomeDir } from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import type { TerminalTab } from "../../stores/projects";
import stripAnsi from "strip-ansi";

interface TerminalProps {
  projectId: string;
  workingDir: string;
}

interface TerminalLine {
  type: "command" | "output" | "error";
  content: string;
  timestamp: number;
}

const CMD_END_MARKER = "___PANE_CMD_END___";
const PWD_MARKER = "___PANE_PWD___";

function shortenPath(fullPath: string, home: string): string {
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~" + fullPath.slice(home.length);
  return fullPath;
}

let tabCounter = 0;
function nextTabId(projectId: string): string {
  return `pty-${projectId}-${Date.now()}-${++tabCounter}`;
}

function tabTitle(index: number): string {
  return index === 0 ? "zsh" : `zsh (${index + 1})`;
}

// State per terminal tab — kept outside React to survive tab switches
interface TabState {
  lines: TerminalLine[];
  cwd: string;
  history: string[];
  outputBuffer: string;
  isRunning: boolean;
  initialized: boolean; // suppress initial shell prompt
  echoSkipped: boolean; // skip the echoed command line from PTY
}

const tabStates = new Map<string, TabState>();

function getTabState(tabId: string, initialCwd: string): TabState {
  let state = tabStates.get(tabId);
  if (!state) {
    state = {
      lines: [],
      cwd: initialCwd,
      history: [],
      outputBuffer: "",
      isRunning: false,
      initialized: false,
      echoSkipped: false,
    };
    tabStates.set(tabId, state);
  }
  return state;
}

// ─── TerminalTabBar ─────────────────────────────────────────────────────

function TerminalTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  if (tabs.length <= 1) return null;

  return (
    <div className="shrink-0 flex items-center gap-1 px-10 pt-2 pb-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={`font-mono px-2 py-0.5 rounded flex items-center gap-1.5 btn-press ${
            tab.id === activeTabId
              ? "text-pane-text"
              : tab.isAlive
                ? "text-pane-text-secondary/50 hover:text-pane-text-secondary"
                : "text-pane-text-secondary/30"
          }`}
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          <span>{tab.title}</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            className="hover:text-pane-text cursor-pointer"
          >
            x
          </span>
        </button>
      ))}
      <button
        onClick={onNew}
        className="font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary px-1.5 py-0.5 btn-press"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        +
      </button>
    </div>
  );
}

// ─── TerminalTabContent ─────────────────────────────────────────────────

function TerminalTabContent({
  tabId,
  projectId,
  workingDir,
  homeDir,
  isVisible,
}: {
  tabId: string;
  projectId: string;
  workingDir: string;
  homeDir: string;
  isVisible: boolean;
}) {
  const state = getTabState(tabId, workingDir);

  const [lines, setLines] = useState<TerminalLine[]>(state.lines);
  const [command, setCommand] = useState("");
  const [isRunning, setIsRunning] = useState(state.isRunning);
  const [cwd, setCwd] = useState(state.cwd);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stateRef = useRef(state);

  // Keep tabState in sync
  useEffect(() => {
    stateRef.current.lines = lines;
  }, [lines]);
  useEffect(() => {
    stateRef.current.cwd = cwd;
  }, [cwd]);
  useEffect(() => {
    stateRef.current.isRunning = isRunning;
  }, [isRunning]);

  // Create PTY and wire up data listener
  useEffect(() => {
    const ts = stateRef.current;

    createPty(tabId, projectId, workingDir).catch((err) => {
      console.error("[pane] Failed to create PTY:", err);
    });

    // Suppress the initial shell prompt by marking as not initialized.
    // The first data that arrives before any command is the shell prompt — skip it.
    ts.initialized = false;
    ts.outputBuffer = "";

    const cleanupData = onPtyData(tabId, (rawData: string) => {
      // Strip ANSI escape codes and carriage returns (PTY sends \r\n)
      const data = stripAnsi(rawData).replace(/\r/g, "");

      // Suppress initial shell prompt output (before first command)
      if (!ts.initialized) {
        return;
      }

      // When running a command, the PTY first echoes back the full command line.
      // Skip everything up to (and including) the first newline — that's the echo.
      if (ts.isRunning && !ts.echoSkipped) {
        const nlIdx = data.indexOf("\n");
        if (nlIdx === -1) {
          // No newline yet — still part of the echo, discard entirely
          return;
        }
        // Skip the echo line, keep everything after the newline
        ts.echoSkipped = true;
        const remaining = data.slice(nlIdx + 1);
        if (!remaining) return;
        ts.outputBuffer += remaining;
      } else {
        ts.outputBuffer += data;
      }

      // Check for command completion marker
      const markerIdx = ts.outputBuffer.indexOf(CMD_END_MARKER);
      if (markerIdx !== -1) {
        // Extract output before the marker
        let output = ts.outputBuffer.slice(0, markerIdx);
        const afterMarker = ts.outputBuffer.slice(markerIdx + CMD_END_MARKER.length);

        // Parse exit code and pwd from: exitCode___PANE_PWD___/path/to/dir
        const pwdIdx = afterMarker.indexOf(PWD_MARKER);
        let newCwd = "";
        if (pwdIdx !== -1) {
          const pwdStr = afterMarker.slice(pwdIdx + PWD_MARKER.length).split("\n")[0]?.trim();
          if (pwdStr) {
            newCwd = pwdStr;
          }
        }

        // Strip trailing newlines and any shell prompt that appears after marker
        output = output.replace(/\n+$/, "");

        if (output.trim()) {
          setLines((prev) => [
            ...prev,
            { type: "output", content: output, timestamp: Date.now() },
          ]);
        }

        if (newCwd) {
          setCwd(newCwd);
        }

        ts.outputBuffer = "";
        ts.isRunning = false;
        ts.echoSkipped = false;
        setIsRunning(false);
      }
    });

    const cleanupExit = onPtyExit(tabId, () => {
      useProjectsStore.getState().markTerminalTabDead(projectId, tabId);
      ts.isRunning = false;
      setIsRunning(false);
    });

    return () => {
      cleanupData();
      cleanupExit();
      destroyPty(tabId).catch(() => {});
      tabStates.delete(tabId);
    };
  }, [tabId, projectId, workingDir]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input when tab becomes visible or command finishes
  useEffect(() => {
    if (isVisible && !isRunning) {
      inputRef.current?.focus();
    }
  }, [isVisible, isRunning]);

  const runCommand = useCallback(
    (cmd: string) => {
      if (!cmd.trim() || isRunning) return;
      const trimmedCmd = cmd.trim();

      // Add to history
      const ts = stateRef.current;
      const deduped = ts.history.filter((h) => h !== trimmedCmd);
      ts.history = [...deduped, trimmedCmd];

      setHistoryIndex(-1);

      const displayPath = shortenPath(cwd, homeDir);
      setLines((prev) => [
        ...prev,
        { type: "command", content: `${displayPath} $ ${trimmedCmd}`, timestamp: Date.now() },
      ]);
      setCommand("");
      setIsRunning(true);
      ts.isRunning = true;
      ts.initialized = true;
      ts.outputBuffer = "";
      ts.echoSkipped = false;

      // Write the command + completion marker to the PTY
      const markerCmd = `${trimmedCmd}; echo "${CMD_END_MARKER}$?${PWD_MARKER}$(pwd)"`;
      writePty(tabId, markerCmd + "\n");
    },
    [tabId, isRunning, cwd, homeDir],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "c" && e.ctrlKey && isRunning) {
      e.preventDefault();
      writePty(tabId, "\x03");
      // The interrupted command won't produce our completion marker,
      // so clear running state after a short delay
      const ts = stateRef.current;
      setTimeout(() => {
        if (ts.isRunning) {
          // Flush any accumulated output
          const pending = ts.outputBuffer.replace(/\^C\n?/g, "").trim();
          if (pending) {
            setLines((prev) => [
              ...prev,
              { type: "output", content: pending, timestamp: Date.now() },
            ]);
          }
          ts.outputBuffer = "";
          ts.isRunning = false;
          ts.echoSkipped = false;
          setIsRunning(false);
        }
      }, 200);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCommand(command);
    } else if (e.key === "l" && e.metaKey) {
      e.preventDefault();
      setLines([]);
      stateRef.current.lines = [];
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = stateRef.current.history;
      if (history.length === 0) return;
      const newIdx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIdx);
      setCommand(history[newIdx]!);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const history = stateRef.current.history;
      if (historyIndex === -1) return;
      if (historyIndex >= history.length - 1) {
        setHistoryIndex(-1);
        setCommand("");
      } else {
        const newIdx = historyIndex + 1;
        setHistoryIndex(newIdx);
        setCommand(history[newIdx]!);
      }
    }
  };

  const displayPath = shortenPath(cwd, homeDir);

  return (
    <div className="flex flex-col h-full w-full" style={{ display: isVisible ? "flex" : "none" }}>
      {/* Terminal output area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-10 py-8" style={{ willChange: "transform" }}>
        {lines.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full select-none gap-6">
            <span
              className="text-pane-text-secondary/40 font-mono tracking-[0.25em] uppercase"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              terminal
            </span>
            <div className="flex items-center gap-6 text-pane-text-secondary/30 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
              <span>return run</span>
              <span>up/down history</span>
              <span>cmd+L clear</span>
              <span>ctrl+C cancel</span>
            </div>
          </div>
        )}

        {lines.map((line, i) => (
          <div
            key={`${line.timestamp}-${i}`}
            className={`font-mono whitespace-pre-wrap mb-1 ${
              line.type === "command"
                ? "text-pane-text"
                : line.type === "error"
                  ? "text-pane-error"
                  : "text-pane-text-secondary"
            }`}
            style={{ fontSize: "var(--pane-font-size-base)" }}
          >
            {line.content}
          </div>
        ))}

        {isRunning && (
          <div className="flex items-center gap-2 text-pane-text-secondary/50 font-mono mt-2">
            <span className="inline-block w-1 h-3 bg-pane-text-secondary/50 animate-pulse" />
            <span style={{ fontSize: "var(--pane-font-size-sm)" }}>running...</span>
          </div>
        )}
      </div>

      {/* Command input with cwd prompt */}
      <div className="shrink-0 px-10 py-6 flex items-start gap-2">
        <span
          className="text-pane-text-secondary/60 font-mono select-none shrink-0"
          style={{ lineHeight: "2rem", fontSize: "var(--pane-font-size-base)" }}
        >
          {displayPath} $
        </span>
        <textarea
          ref={inputRef}
          value={command}
          onChange={(e) => { setCommand(e.target.value); setHistoryIndex(-1); }}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
          placeholder=""
          className="flex-1 bg-transparent border-none outline-none resize-none text-pane-text font-mono placeholder:text-pane-text-secondary/30"
          style={{
            fontSize: "var(--pane-font-size-base)",
            minHeight: "2rem",
            lineHeight: "2rem",
          }}
          rows={1}
        />
      </div>
    </div>
  );
}

// ─── Terminal (main export) ─────────────────────────────────────────────

export function Terminal({ projectId, workingDir }: TerminalProps) {
  const [homeDir, setHomeDir] = useState("");
  const tabs = useProjectsStore((s) => s.projects.get(projectId)?.terminalTabs ?? []);
  const activeTabId = useProjectsStore((s) => s.projects.get(projectId)?.activeTerminalTabId ?? null);

  // Get home dir on mount
  useEffect(() => {
    getHomeDir().then(setHomeDir).catch(() => {});
  }, []);

  // Auto-create first tab on mount
  useEffect(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);
    if (project && project.terminalTabs.length === 0) {
      const id = nextTabId(projectId);
      store.addTerminalTab(projectId, { id, title: tabTitle(0), isAlive: true });
    }
  }, [projectId]);

  // Cleanup all PTYs on unmount
  useEffect(() => {
    return () => {
      destroyAllPtysForProject(projectId).catch(() => {});
    };
  }, [projectId]);

  const handleNewTab = useCallback(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);
    const index = project ? project.terminalTabs.length : 0;
    const id = nextTabId(projectId);
    store.addTerminalTab(projectId, { id, title: tabTitle(index), isAlive: true });
  }, [projectId]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      destroyPty(tabId).catch(() => {});
      tabStates.delete(tabId);
      useProjectsStore.getState().removeTerminalTab(projectId, tabId);
    },
    [projectId],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      useProjectsStore.getState().setActiveTerminalTab(projectId, tabId);
    },
    [projectId],
  );

  return (
    <div className="flex flex-col h-full w-full">
      <TerminalTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      {tabs.map((tab) => (
        <TerminalTabContent
          key={tab.id}
          tabId={tab.id}
          projectId={projectId}
          workingDir={workingDir}
          homeDir={homeDir}
          isVisible={tab.id === activeTabId}
        />
      ))}
    </div>
  );
}
