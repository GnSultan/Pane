import { useState } from "react";
import type { ToolUseBlock, ToolResultBlock } from "../../lib/claude-types";

interface ToolActivityProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return (input.file_path as string)?.split("/").pop() || "file";
    case "Edit":
      return (input.file_path as string)?.split("/").pop() || "file";
    case "Write":
      return (input.file_path as string)?.split("/").pop() || "file";
    case "Bash": {
      const cmd = (input.command as string) || "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Glob":
      return (input.pattern as string) || "";
    case "Grep":
      return `"${(input.pattern as string) || ""}"`;
    case "TodoWrite":
      return "todos";
    case "Task":
      return (input.description as string) || "subagent";
    case "WebSearch":
      return (input.query as string) || "";
    default:
      return name;
  }
}

function getToolLabel(name: string): string {
  switch (name) {
    case "Read": return "read";
    case "Glob": return "glob";
    case "Grep": return "grep";
    case "Edit": return "edit";
    case "Write": return "write";
    case "Bash": return "bash";
    case "Task": return "task";
    case "TodoWrite": return "todo";
    case "WebSearch": return "search";
    default: return name.toLowerCase();
  }
}

export function ToolActivity({ toolUse, toolResult }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeTool(toolUse.name, toolUse.input);
  const isComplete = !!toolResult;
  const isFailed = toolResult?.is_error ?? false;
  const label = getToolLabel(toolUse.name);

  const accentColor = isFailed ? "var(--pane-error)" : "var(--pane-terminal)";

  return (
    <>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-pane-text-secondary/50 font-mono
                   hover:text-pane-text-secondary w-full text-left
                   h-5 leading-none border-l-2 pl-3"
        style={{
          fontSize: "var(--pane-font-size-sm)",
          borderLeftColor: `color-mix(in srgb, ${accentColor} 35%, transparent)`,
        }}
      >
        <span
          className={`w-1 h-1 rounded-full shrink-0 ${
            isFailed ? "bg-pane-error" :
            isComplete ? "" :
            "animate-pulse"
          }`}
          style={
            isFailed ? {} :
            isComplete ? { backgroundColor: `color-mix(in srgb, ${accentColor} 25%, transparent)` } :
            { backgroundColor: `color-mix(in srgb, ${accentColor} 50%, transparent)` }
          }
        />
        <span className="shrink-0 opacity-50" style={{ color: accentColor }}>{label}</span>
        <span className="truncate">{summary}</span>
        {isFailed && (
          <span className="text-pane-error/60 shrink-0">err</span>
        )}
      </button>

      {expanded && (
        <div
          className="mb-0.5 space-y-1 border-l-2 pl-3"
          style={{ borderLeftColor: `color-mix(in srgb, ${accentColor} 15%, transparent)` }}
        >
          <pre className="font-mono text-pane-text-secondary/60
                          bg-pane-bg p-2.5 overflow-x-auto max-h-[250px]
                          overflow-y-auto border border-pane-border/40 leading-[1.6]"
               style={{ fontSize: "var(--pane-font-size-sm)" }}>
            {JSON.stringify(toolUse.input, null, 2)}
          </pre>

          {toolResult && (
            <pre
              className={`font-mono p-2.5 overflow-x-auto
                          max-h-[250px] overflow-y-auto border leading-[1.6]
                          ${
                            toolResult.is_error
                              ? "text-pane-error/60 bg-[var(--pane-error-bg)] border-[var(--pane-error-border)]"
                              : "text-pane-text-secondary/50 bg-pane-bg border-pane-border/40"
                          }`}
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {typeof toolResult.content === "string"
                ? toolResult.content.length > 5000
                  ? toolResult.content.slice(0, 5000) + "\n... (truncated)"
                  : toolResult.content
                : JSON.stringify(toolResult.content, null, 2)}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
