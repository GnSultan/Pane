import { useState, useRef, useEffect, useCallback } from "react";
import {
  createPty,
  writePty,
  destroyPty,
  destroyAllPtysForProject,
  onPtyData,
  onPtyExit,
  getHomeDir,
  appendTerminalCommand,
  updateTerminalRunning,
  getTerminalHistory,
} from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import type { TerminalTab } from "../../stores/projects";
import stripAnsi from "strip-ansi";
import { CaretTextArea } from "../shared";

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
const LIVE_OUTPUT_MAX_LINES = 200;
const OUTPUT_BUFFER_MAX = 500_000; // ~500KB, prevents unbounded memory growth

// Process \r semantically: \r\n is a normal line ending (strip the \r),
// while standalone \r (no following \n) means "overwrite current line" —
// this collapses progress bars into a single updating line.
function processCarriageReturns(text: string): string {
  // First: normalize \r\n to \n (standard terminal line endings)
  const normalized = text.replace(/\r\n/g, "\n");
  // Then: process remaining standalone \r (progress bar overwrites)
  const lines = normalized.split("\n");
  return lines.map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r");
    return parts[parts.length - 1] ?? "";
  }).join("\n");
}

// Return only the last N lines of text — tail -f style display.
function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return lines.slice(-max).join("\n");
}

// Detect progress bar lines and extract fill level.
// Only match real progress bars: block/hash fill chars AND a numeric value.
// Excludes - and ~ which are too common in normal shell output (git diffs, separators, etc.).
// Never renders without a concrete percentage — no indeterminate ghost lines.
function parseProgress(line: string): { pct: number; label: string } | null {
  // Must have 4+ unambiguous fill characters (no dash/tilde)
  if (!/[#=█░▓▒▪■]{4,}/.test(line)) return null;

  // Percentage format: 47%
  const pctMatch = line.match(/(\d{1,3})%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1]!, 10);
    if (pct >= 0 && pct <= 100) return { pct, label: `${pct}%` };
  }

  // Fraction format: 47/52
  const fracMatch = line.match(/\b(\d+)\/(\d+)\b/);
  if (fracMatch) {
    const n = parseInt(fracMatch[1]!, 10);
    const total = parseInt(fracMatch[2]!, 10);
    if (total > 0 && n >= 0 && n <= total) {
      return { pct: Math.round((n / total) * 100), label: `${n}/${total}` };
    }
  }

  // Fill chars but no numeric info — not enough signal, skip
  return null;
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex items-center gap-3 mt-2 mb-1">
      <div className="flex-1 h-[2px] bg-pane-border/40 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-150"
          style={{ width: `${pct}%`, background: "var(--pane-terminal)" }}
        />
      </div>
      <span
        className="shrink-0 tabular-nums"
        style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)" }}
      >
        {label}
      </span>
    </div>
  );
}


function shortenPath(fullPath: string, home: string): string {
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~" + fullPath.slice(home.length);
  return fullPath;
}

let tabCounter = 0;
function nextTabId(projectId: string): string {
  return `pty-${projectId}-${Date.now()}-${++tabCounter}`;
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
  lastCommand: string; // last command sent (for MCP state sync)
  recentCommands: Array<{
    cmd: string;
    output: string;
    cwd: string;
    timestamp: number;
  }>; // last 20 commands (local UI state, not used for persistence anymore)
  snapshotTimer: ReturnType<typeof setInterval> | null; // periodic live-output snapshot
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
      lastCommand: "",
      recentCommands: [],
      snapshotTimer: null,
    };
    tabStates.set(tabId, state);
  }
  return state;
}

// ─── TerminalTabBar ─────────────────────────────────────────────────────

function TerminalTabBar({
  tabs,
  activeTabId,
  homeDir,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  homeDir: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div
      className="shrink-0 flex items-center px-4 pt-2 pb-1 gap-1 relative z-20"
      data-no-drag
    >
      {tabs.map((tab) => {
        const label = tab.cwd ? shortenPath(tab.cwd, homeDir) : "~";
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={`flex-1 min-w-0 font-mono px-3 py-1 rounded-md flex items-center justify-between gap-2 btn-press transition-colors ${
              isActive
                ? "bg-pane-text/[0.06] text-pane-text"
                : tab.isAlive
                  ? "text-pane-text-secondary/50 hover:text-pane-text-secondary hover:bg-pane-text/[0.03]"
                  : "text-pane-text-secondary/30"
            }`}
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            <span className="truncate min-w-0">{label}</span>
            {tabs.length > 1 && (
              <span
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className="shrink-0 opacity-40 hover:opacity-100 cursor-pointer"
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <button
        onClick={onNew}
        className="shrink-0 font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary w-7 h-7 flex items-center justify-center rounded-md hover:bg-pane-text/[0.04] btn-press"
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
  initialCwd,
  homeDir,
  isVisible,
}: {
  tabId: string;
  projectId: string;
  initialCwd: string;
  homeDir: string;
  isVisible: boolean;
}) {
  const isNewSessionRef = useRef(!tabStates.has(tabId)); // captured once at mount before getTabState creates the entry
  const state = getTabState(tabId, initialCwd);

  const [lines, setLines] = useState<TerminalLine[]>(state.lines);
  const [liveOutput, setLiveOutput] = useState("");
  const [command, setCommand] = useState("");
  const [isRunning, setIsRunning] = useState(state.isRunning);
  const [cwd, setCwd] = useState(state.cwd);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stateRef = useRef(state);
  const liveOutputRaf = useRef(0);  // rAF handle for throttled live output updates
  const scrollRaf = useRef(0);       // rAF handle for throttled auto-scroll

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

    // If this is a resumed session, load history from DB before PTY starts
    if (isNewSessionRef.current) {
      getTerminalHistory(projectId).then(({ commands }) => {
        if (commands.length === 0) return;
        const restored: TerminalLine[] = [
          { type: "output", content: "── previous session ──────────────────", timestamp: 0 },
          ...commands.flatMap((c) => [
            { type: "command" as const, content: c.cmd, timestamp: c.timestamp },
            ...(c.output.trim() ? [{ type: "output" as const, content: c.output, timestamp: c.timestamp }] : []),
          ]),
          { type: "output", content: "── restored ──────────────────────────", timestamp: 0 },
        ];
        setLines((prev) => (prev.length === 0 ? restored : prev));
      }).catch(() => {});
    }

    createPty(tabId, projectId, initialCwd).catch((err) => {
      console.error("[pane] Failed to create PTY:", err);
    });

    // Suppress the initial shell prompt by marking as not initialized.
    // The first data that arrives before any command is the shell prompt — skip it.
    ts.initialized = false;
    ts.outputBuffer = "";

    const cleanupData = onPtyData(tabId, (rawData: string) => {
      // Strip ANSI codes, then process \r semantically (overwrite line, not delete)
      // so progress bars collapse to a single updating line instead of inflating output.
      const data = processCarriageReturns(stripAnsi(rawData));

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

      // Cap buffer to prevent unbounded memory growth on very long commands.
      // Keeps the tail so completion marker is never lost.
      if (ts.outputBuffer.length > OUTPUT_BUFFER_MAX) {
        const trimAt = ts.outputBuffer.indexOf("\n", ts.outputBuffer.length - OUTPUT_BUFFER_MAX);
        ts.outputBuffer = trimAt !== -1 ? ts.outputBuffer.slice(trimAt + 1) : ts.outputBuffer.slice(-OUTPUT_BUFFER_MAX);
      }

      // Throttle live output updates to one per animation frame.
      // Prevents hundreds of React re-renders per second on fast-streaming commands.
      cancelAnimationFrame(liveOutputRaf.current);
      liveOutputRaf.current = requestAnimationFrame(() => {
        if (!stateRef.current.isRunning) return;
        setLiveOutput(tailLines(stateRef.current.outputBuffer, LIVE_OUTPUT_MAX_LINES));
      });

      // Check for command completion marker
      const markerIdx = ts.outputBuffer.indexOf(CMD_END_MARKER);
      if (markerIdx !== -1) {
        cancelAnimationFrame(liveOutputRaf.current);
        setLiveOutput("");
        // Extract output before the marker
        let output = ts.outputBuffer.slice(0, markerIdx);
        const afterMarker = ts.outputBuffer.slice(
          markerIdx + CMD_END_MARKER.length,
        );

        // Parse exit code and pwd from: exitCode___PANE_PWD___/path/to/dir
        const pwdIdx = afterMarker.indexOf(PWD_MARKER);
        let newCwd = "";
        if (pwdIdx !== -1) {
          const pwdStr = afterMarker
            .slice(pwdIdx + PWD_MARKER.length)
            .split("\n")[0]
            ?.trim();
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
          useProjectsStore.getState().updateTerminalTabCwd(projectId, tabId, newCwd);
        }

        ts.outputBuffer = "";
        ts.isRunning = false;
        ts.echoSkipped = false;
        setIsRunning(false);

        // Sync terminal state for MCP server — atomic append (multi-tab safe)
        if (ts.lastCommand) {
          // Stop the live-output snapshot timer; command is done
          if (ts.snapshotTimer) {
            clearInterval(ts.snapshotTimer);
            ts.snapshotTimer = null;
          }
          const finishedCwd = newCwd || ts.cwd;
          const tabTitle = finishedCwd.split("/").pop() || finishedCwd || "terminal";
          const entry = {
            cmd: ts.lastCommand,
            output: output.slice(0, 2000),
            cwd: finishedCwd,
            timestamp: Date.now(),
            tabId,
            tabTitle,
          };
          ts.recentCommands = [...ts.recentCommands, entry].slice(-20);
          appendTerminalCommand(projectId, entry).catch(() => {});
        }
      }
    });

    const cleanupExit = onPtyExit(tabId, () => {
      useProjectsStore.getState().markTerminalTabDead(projectId, tabId);
      ts.isRunning = false;
      setIsRunning(false);
    });

    return () => {
      // Stop live snapshot timer if tab is destroyed mid-command
      if (ts.snapshotTimer) {
        clearInterval(ts.snapshotTimer);
        ts.snapshotTimer = null;
      }
      cleanupData();
      cleanupExit();
      destroyPty(tabId).catch(() => {});
      tabStates.delete(tabId);
    };
  }, [tabId, projectId]); // initialCwd intentionally omitted — used once at mount, must not retrigger on cd

  // Auto-scroll — fires on both completed lines and live streaming output.
  // rAF-throttled so rapid liveOutput updates don't cause scroll jank.
  useEffect(() => {
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [lines, liveOutput]);

  // Focus input when tab becomes visible or command finishes/starts
  useEffect(() => {
    if (isVisible) {
      inputRef.current?.focus();
    }
  }, [isVisible, isRunning]);

  const clearTerminal = useCallback(() => {
    setLines([]);
    stateRef.current.lines = [];
  }, []);

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
        {
          type: "command",
          content: `${displayPath} $ ${trimmedCmd}`,
          timestamp: Date.now(),
        },
      ]);
      setCommand("");
      cancelAnimationFrame(liveOutputRaf.current);
      setLiveOutput("");
      setIsRunning(true);
      ts.isRunning = true;
      ts.initialized = true;
      ts.outputBuffer = "";
      ts.echoSkipped = false;
      ts.lastCommand = trimmedCmd;

      // Start a periodic snapshot so long-running commands (servers, builds, watchers)
      // are visible to the model via pane_recent_terminal even before they complete.
      // Fires every 10s; first tick is at 10s (short commands finish before then).
      if (ts.snapshotTimer) clearInterval(ts.snapshotTimer);
      ts.snapshotTimer = setInterval(() => {
        if (!ts.isRunning) {
          clearInterval(ts.snapshotTimer!);
          ts.snapshotTimer = null;
          return;
        }
        const tail = ts.outputBuffer.slice(-3000);
        if (tail) {
          const liveCwd = ts.cwd;
          const tabTitle = liveCwd.split("/").pop() || liveCwd || "terminal";
          updateTerminalRunning(projectId, {
            cmd: ts.lastCommand,
            output: tail,
            cwd: liveCwd,
            timestamp: Date.now(),
            tabId,
            tabTitle,
            partial: true,
          }).catch(() => {});
        }
      }, 10_000);

      // Write the command + completion marker to the PTY
      const markerCmd = `${trimmedCmd}; echo "${CMD_END_MARKER}$?${PWD_MARKER}$(pwd)"`;
      writePty(tabId, markerCmd + "\n");
    },
    [tabId, isRunning, cwd, homeDir],
  );

  const abortCommand = useCallback(() => {
    if (!isRunning) return;
    writePty(tabId, "\x03");
    // The interrupted command won't produce our completion marker,
    // so clear running state after a short delay
    const ts = stateRef.current;
    setTimeout(() => {
      if (ts.isRunning) {
        cancelAnimationFrame(liveOutputRaf.current);
        // Flush any accumulated output
        const pending = ts.outputBuffer.replace(/\^C\n?/g, "").trim();
        if (pending) {
          setLines((prev) => [
            ...prev,
            { type: "output", content: pending, timestamp: Date.now() },
          ]);
        }
        setLiveOutput("");
        ts.outputBuffer = "";
        ts.isRunning = false;
        ts.echoSkipped = false;
        setIsRunning(false);
      }
    }, 200);
  }, [tabId, isRunning]);

  // Global escape/ctrl+c listener when visible and running
  useEffect(() => {
    if (!isVisible || !isRunning) return;
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "c" && e.ctrlKey)) {
        // Only intercept if we aren't already in the textarea (which has its own handler)
        // or if we want to ensure it works regardless of focus.
        if (
          document.activeElement?.tagName !== "TEXTAREA" &&
          document.activeElement?.tagName !== "INPUT"
        ) {
          e.preventDefault();
          abortCommand();
        }
      }
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [isVisible, isRunning, abortCommand]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Escape" || (e.key === "c" && e.ctrlKey)) && isRunning) {
      e.preventDefault();
      abortCommand();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCommand(command);
    } else if (e.key === "l" && e.metaKey) {
      e.preventDefault();
      clearTerminal();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = stateRef.current.history;
      if (history.length === 0) return;
      const newIdx =
        historyIndex === -1
          ? history.length - 1
          : Math.max(0, historyIndex - 1);
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
    <div
      className="flex flex-col flex-1 min-h-0 w-full relative"
      style={{ display: isVisible ? "flex" : "none" }}
    >
      <div className="flex-1 relative min-h-0" data-no-drag>
        {lines.length > 0 && (
          <button
            onClick={clearTerminal}
            className="absolute top-8 right-10 text-pane-text-secondary/30 hover:text-pane-text-secondary font-mono text-[10px] uppercase tracking-wider z-30 transition-colors"
            title="Clear terminal (Cmd+L)"
          >
            clear
          </button>
        )}
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto overflow-x-hidden px-10 pt-8 pb-16 relative z-20"
          style={{ willChange: "transform" }}
        >
          {lines.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full select-none gap-6">
              <span
                className="text-pane-text-secondary/40 font-mono tracking-[0.25em] uppercase"
                style={{ fontSize: "var(--pane-font-size-sm)" }}
              >
                terminal
              </span>
              <div
                className="flex items-center gap-6 text-pane-text-secondary/30 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                <span>return run</span>
                <span>up/down history</span>
                <span>cmd+L clear</span>
                <span>esc / ctrl+C cancel</span>
              </div>
            </div>
          )}

          {lines.map((line, i) => (
            <div
              key={`${line.timestamp}-${i}`}
              className={`font-mono whitespace-pre-wrap break-words mb-1 ${
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

          {isRunning && (() => {
            const outputLines = liveOutput ? liveOutput.split("\n") : [];
            const lastLine = outputLines[outputLines.length - 1] ?? "";
            const progress = parseProgress(lastLine);
            const bodyText = progress !== null && outputLines.length > 1
              ? outputLines.slice(0, -1).join("\n")
              : progress !== null ? "" : liveOutput;
            return (
            <div className="font-mono">
              {bodyText && (
                <div
                  className="whitespace-pre-wrap break-words text-pane-text-secondary"
                  style={{ fontSize: "var(--pane-font-size-base)" }}
                >
                  {bodyText}
                </div>
              )}
              {progress !== null && (
                <ProgressBar pct={progress.pct} label={progress.label} />
              )}
              <div className="flex items-center gap-2 text-pane-text-secondary/50 mt-2">
                <span className="inline-block w-1 h-3 bg-pane-text-secondary/50 animate-pulse" />
                <span style={{ fontSize: "var(--pane-font-size-sm)" }}>running...</span>
              </div>
            </div>
            );
          })()}
        </div>
      </div>

      {/* Command input — pinned to bottom, full bleed, matching Conversation InputBar */}
      <div className="absolute bottom-0 left-0 right-0 z-30">
        <div className="bg-pane-bg rounded-xl flex items-center gap-2 px-4 py-3">
          <span
            className="font-mono select-none shrink-0 self-start"
            style={{ fontSize: "var(--pane-font-size-base)", lineHeight: "1.5rem", color: "var(--pane-terminal)", margin: 0, padding: 0 }}
          >
            {displayPath} $
          </span>
          <CaretTextArea
            ref={inputRef}
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            readOnly={isRunning}
            placeholder={isRunning ? "" : "command"}
            minHeight={24}
            maxHeight={200}
            className="flex-1"
            style={{
              fontSize: "var(--pane-font-size-base)",
              lineHeight: "1.5rem",
              padding: 0,
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Terminal (main export) ─────────────────────────────────────────────

export function Terminal({ projectId, workingDir }: TerminalProps) {
  const [homeDir, setHomeDir] = useState("");
  const tabs = useProjectsStore(
    (s) => s.projects.get(projectId)?.terminalTabs ?? [],
  );
  const activeTabId = useProjectsStore(
    (s) => s.projects.get(projectId)?.activeTerminalTabId ?? null,
  );

  // Get home dir on mount
  useEffect(() => {
    getHomeDir()
      .then(setHomeDir)
      .catch(() => {});
  }, []);

  // Auto-create first tab on mount
  useEffect(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);
    if (project && project.terminalTabs.length === 0) {
      const id = nextTabId(projectId);
      store.addTerminalTab(projectId, {
        id,
        title: workingDir,
        isAlive: true,
        cwd: workingDir,
      });
    }
  }, [projectId, workingDir]);

  // Cleanup all PTYs on unmount
  useEffect(() => {
    return () => {
      destroyAllPtysForProject(projectId).catch(() => {});
    };
  }, [projectId]);

  const handleNewTab = useCallback(() => {
    const store = useProjectsStore.getState();
    const project = store.projects.get(projectId);
    const activeTab = project?.terminalTabs.find((t) => t.id === project.activeTerminalTabId);
    const startCwd = activeTab?.cwd ?? workingDir;
    const id = nextTabId(projectId);
    store.addTerminalTab(projectId, {
      id,
      title: startCwd,
      isAlive: true,
      cwd: startCwd,
    });
  }, [projectId, workingDir]);

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
        homeDir={homeDir}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      {tabs.map((tab) => (
        <TerminalTabContent
          key={tab.id}
          tabId={tab.id}
          projectId={projectId}
          initialCwd={tab.cwd ?? workingDir}
          homeDir={homeDir}
          isVisible={tab.id === activeTabId}
        />
      ))}
    </div>
  );
}
