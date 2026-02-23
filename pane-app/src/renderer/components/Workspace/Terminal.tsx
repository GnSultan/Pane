import { useState, useRef, useEffect, useCallback } from "react";
import { executeTerminalCommand } from "../../lib/tauri-commands";

interface TerminalProps {
  projectId: string;
  workingDir: string;
}

interface TerminalLine {
  type: "command" | "output" | "error";
  content: string;
  timestamp: number;
}

export function Terminal({ projectId, workingDir }: TerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [command, setCommand] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commandCounterRef = useRef(0);

  // Auto-scroll to bottom when new lines appear
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || isRunning) return;

    const trimmedCmd = cmd.trim();

    // Add command to history
    setLines((prev) => [
      ...prev,
      { type: "command", content: `$ ${trimmedCmd}`, timestamp: Date.now() },
    ]);
    setCommand("");
    setIsRunning(true);

    const sessionId = `${projectId}-${commandCounterRef.current++}`;

    try {
      await executeTerminalCommand(sessionId, trimmedCmd, workingDir, (output) => {
        if (output.type === "stdout" || output.type === "stderr") {
          const content = output.data || "";
          if (content) {
            setLines((prev) => [
              ...prev,
              {
                type: output.type === "stderr" ? "error" : "output",
                content,
                timestamp: Date.now(),
              },
            ]);
          }
        } else if (output.type === "error") {
          setLines((prev) => [
            ...prev,
            {
              type: "error",
              content: `Error: ${output.message || "Unknown error"}`,
              timestamp: Date.now(),
            },
          ]);
        }
      });
    } catch (err: any) {
      setLines((prev) => [
        ...prev,
        {
          type: "error",
          content: `Error: ${err.message}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsRunning(false);
      inputRef.current?.focus();
    }
  }, [projectId, workingDir, isRunning]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCommand(command);
    } else if (e.key === "k" && e.metaKey) {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-full w-full">
      {/* Terminal output area — scrollable, like conversation messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-10 py-8 overscroll-contain">
        {lines.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full select-none gap-6">
            <span
              className="text-pane-text-secondary/40 font-mono tracking-[0.25em] uppercase"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              terminal
            </span>
            <div className="flex items-center gap-6 text-pane-text-secondary/30 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
              <span>⏎ run</span>
              <span>⌘K focus</span>
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
            <span className="inline-block w-1 h-3 bg-pane-text-secondary/50 pane-pulse" />
            <span style={{ fontSize: "var(--pane-font-size-sm)" }}>running...</span>
          </div>
        )}
      </div>

      {/* Command input — $ and command on same line */}
      <div className="shrink-0 px-10 py-6 flex items-start gap-3">
        <span className="text-pane-text-secondary font-mono select-none" style={{ lineHeight: "2rem" }}>$</span>
        <textarea
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
          placeholder="type command..."
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
