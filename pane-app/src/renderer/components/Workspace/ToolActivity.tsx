import { useState, useMemo } from "react";
import type {
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultError,
} from "../../lib/claude-types";

interface ToolActivityProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

function shortenPath(fullPath: string): string {
  const srcIdx = fullPath.lastIndexOf("/src/");
  if (srcIdx !== -1) return fullPath.slice(srcIdx + 1);
  const parts = fullPath.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : fullPath;
}

// Parse MCP tool names: "mcp__server-name__tool_name" → { server, tool }
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.slice(5).split("__");
  if (parts.length < 2) return null;
  const server = parts[0]!.replace(/-/g, " ");
  const tool = parts.slice(1).join(" ").replace(/_/g, " ");
  return { server, tool };
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  const mcp = parseMcpName(name);
  if (mcp) return mcp.tool;

  switch (name) {
    case "Read":
      return shortenPath((input.file_path as string) || "file");
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
    case "EnterPlanMode":
      return "entering plan mode";
    case "ExitPlanMode":
      return "ready for review";
    default:
      return name;
  }
}

function getToolLabel(name: string): string {
  const mcp = parseMcpName(name);
  if (mcp) return mcp.server;

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
    case "EnterPlanMode": return "plan";
    case "ExitPlanMode": return "plan";
    default: return name.toLowerCase();
  }
}

function ExpandedEditInput({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || "";
  const oldStr = (input.old_string as string) || "";
  const newStr = (input.new_string as string) || "";
  return (
    <div
      className="font-mono overflow-x-auto max-h-[300px] overflow-y-auto
                 border border-pane-border bg-pane-bg leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      <div className="px-2.5 py-1.5 text-pane-text-secondary border-b border-pane-border/30">
        {shortenPath(filePath)}
      </div>
      {oldStr && (
        <pre
          className="px-2.5 py-1.5 whitespace-pre-wrap break-words border-b border-pane-border/20"
          style={{ color: "var(--pane-status-deleted)", opacity: 0.7 }}
        >
          {oldStr}
        </pre>
      )}
      {newStr && (
        <pre
          className="px-2.5 py-1.5 whitespace-pre-wrap break-words"
          style={{ color: "var(--pane-status-added)", opacity: 0.8 }}
        >
          {newStr}
        </pre>
      )}
    </div>
  );
}

function ExpandedWriteInput({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || "";
  const content = (input.content as string) || "";
  const lineCount = content.split("\n").length;
  return (
    <div
      className="font-mono overflow-x-auto max-h-[300px] overflow-y-auto
                 border border-pane-border bg-pane-bg leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      <div className="px-2.5 py-1.5 text-pane-text-secondary border-b border-pane-border/30">
        {shortenPath(filePath)}
        <span className="ml-2" style={{ color: "var(--pane-status-added)" }}>
          {lineCount} lines
        </span>
      </div>
      <pre className="px-2.5 py-1.5 text-pane-text-secondary whitespace-pre-wrap break-words">
        {content.length > 3000
          ? content.slice(0, 3000) + "\n... (truncated)"
          : content}
      </pre>
    </div>
  );
}

function ExpandedTodoInput({ input }: { input: Record<string, unknown> }) {
  const todos = (input.todos as Array<{ content: string; status: string }>) || [];
  return (
    <div
      className="font-mono overflow-y-auto max-h-[300px]
                 border border-pane-border bg-pane-bg leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {todos.map((todo, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-2.5 py-1 border-b border-pane-border/15 last:border-b-0"
        >
          <span className="shrink-0 mt-0.5">
            {todo.status === "completed"
              ? "\u2713"
              : todo.status === "in_progress"
                ? "\u25CB"
                : "\u2022"}
          </span>
          <span
            className={
              todo.status === "completed"
                ? "text-pane-text-secondary/60 line-through"
                : todo.status === "in_progress"
                  ? "text-pane-text"
                  : "text-pane-text-secondary/60"
            }
          >
            {todo.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExpandedDefaultInput({ input }: { input: Record<string, unknown> }) {
  return (
    <pre
      className="font-mono text-pane-text-secondary
                 bg-pane-bg p-2.5 overflow-x-auto max-h-[250px]
                 overflow-y-auto border border-pane-border leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function ExpandedReadInput({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || "";
  return (
    <div
      className="font-mono border border-pane-border bg-pane-bg leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      <div className="px-2.5 py-1.5 text-pane-text-secondary">
        {shortenPath(filePath)}
      </div>
    </div>
  );
}

function ExpandedBashInput({ input }: { input: Record<string, unknown> }) {
  const cmd = (input.command as string) || "";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };

  return (
    <button
      onClick={handleCopy}
      className="w-full text-left font-mono border border-pane-border bg-pane-bg leading-[1.6]
                 hover:bg-pane-text/[0.02] transition-colors group"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
      title="click to copy"
    >
      <pre className="px-2.5 py-1.5 text-pane-text-secondary whitespace-pre-wrap break-words flex items-start justify-between gap-2">
        <span>$ {cmd}</span>
        <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/50">
          {copied ? "✓" : "copy"}
        </span>
      </pre>
    </button>
  );
}

function ExpandedMcpInput({ input, toolName }: { input: Record<string, unknown>; toolName: string }) {
  const mcp = parseMcpName(toolName);
  const entries = Object.entries(input).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  return (
    <div
      className="font-mono border border-pane-border bg-pane-bg leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {mcp && (
        <div className="px-2.5 py-1.5 text-pane-text-secondary border-b border-pane-border/30">
          {mcp.server} / {mcp.tool}
        </div>
      )}
      {entries.map(([key, val]) => (
        <div key={key} className="flex gap-2 px-2.5 py-0.5 border-b border-pane-border/10 last:border-b-0">
          <span className="text-pane-text-secondary shrink-0">{key.replace(/_/g, " ")}</span>
          <span className="text-pane-text-secondary truncate">
            {typeof val === "string" ? val : JSON.stringify(val)}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderExpandedInput(name: string, input: Record<string, unknown>) {
  if (parseMcpName(name)) {
    return <ExpandedMcpInput input={input} toolName={name} />;
  }
  switch (name) {
    case "Edit":
      return <ExpandedEditInput input={input} />;
    case "Write":
      return <ExpandedWriteInput input={input} />;
    case "TodoWrite":
      return <ExpandedTodoInput input={input} />;
    case "Read":
      return <ExpandedReadInput input={input} />;
    case "Bash":
      return <ExpandedBashInput input={input} />;
    default:
      return <ExpandedDefaultInput input={input} />;
  }
}

export function ToolActivity({ toolUse, toolResult }: ToolActivityProps) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  // Capture summary on first render only — prevents shape-shifting when toolUse object updates
  // Even if the toolUse reference changes, the summary stays frozen to what was first displayed
  const summary = useMemo(
    () => summarizeTool(toolUse.name, toolUse.input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Empty deps = compute once, never recompute
  );
  const isComplete = !!toolResult;
  const isFailed = toolResult?.is_error ?? false;

  // Stable expansion rules - NO SHAPE-SHIFTING:
  // 1. User manually toggled → respect that always
  // 2. Errors → always expanded (need immediate attention)
  // 3. Edit/Write → always expanded (must see changes)
  // 4. Read/Bash/Grep/Glob/Search → always collapsed (quiet unless clicked)
  // 5. Everything else → collapsed by default

  const alwaysExpanded = ["Edit", "Write", "Bash"];
  const alwaysCollapsed = ["Read", "Grep", "Glob", "WebSearch", "Task"];

  const expanded = userToggle !== null
    ? userToggle
    : isFailed
      ? true  // Errors always visible
      : alwaysExpanded.includes(toolUse.name)
        ? true  // Edit/Write always visible
        : alwaysCollapsed.includes(toolUse.name)
          ? false  // Read/Bash/Search always quiet
          : false;  // Everything else defaults to collapsed

  const label = getToolLabel(toolUse.name);

  const accentColor = isFailed ? "var(--pane-error)" : "var(--pane-terminal)";

  return (
    <>
      <button
        onClick={() => setUserToggle(expanded ? false : true)}
        className="flex items-center gap-1.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
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
            isComplete ? { backgroundColor: `color-mix(in srgb, ${accentColor} 40%, transparent)` } :
            { backgroundColor: `color-mix(in srgb, ${accentColor} 60%, transparent)` }
          }
        />
        <span className="shrink-0 opacity-70" style={{ color: accentColor }}>{label}</span>
        <span className="truncate">{summary}</span>
        {isFailed && (
          <span className="text-pane-error/80 shrink-0">err</span>
        )}
      </button>

      {expanded && (
        <div
          className="mb-0.5 space-y-1 border-l-2 pl-3"
          style={{ borderLeftColor: `color-mix(in srgb, ${accentColor} 15%, transparent)` }}
        >
          {renderExpandedInput(toolUse.name, toolUse.input)}

          {/* Hide tool result for Edit/Write - the input already shows what changed.
              Only show results for errors or tools where the output matters (Read, Bash, etc.) */}
          {toolResult && !["Edit", "Write"].includes(toolUse.name) && (
            <pre
              className={`font-mono p-2.5 overflow-x-auto
                          max-h-[250px] overflow-y-auto border leading-[1.6]
                          ${
                            toolResult.is_error
                              ? "text-pane-error bg-[var(--pane-error-bg)] border-[var(--pane-error-border)]"
                              : "text-pane-text-secondary bg-pane-bg border-pane-border/40"
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
          {/* Always show errors, even for Edit/Write */}
          {toolResult?.is_error && ["Edit", "Write"].includes(toolUse.name) && (
            <pre
              className="font-mono p-2.5 overflow-x-auto max-h-[250px] overflow-y-auto border leading-[1.6]
                         text-pane-error bg-[var(--pane-error-bg)] border-[var(--pane-error-border)]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {typeof toolResult.content === "string"
                ? toolResult.content
                : JSON.stringify(toolResult.content, null, 2)}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

// --- Server tool activity (web search, etc.) ---

interface ServerToolActivityProps {
  block: ServerToolUseBlock;
  searchResult?: WebSearchToolResultBlock;
}

export function ServerToolActivity({ block, searchResult }: ServerToolActivityProps) {
  const [expanded, setExpanded] = useState(false);

  // Capture query on first render only — prevents shape-shifting
  const query = useMemo(
    () => (block.input?.query as string) || block.name,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Empty deps = compute once, never recompute
  );
  const isComplete = !!searchResult;
  const isError =
    searchResult?.content &&
    !Array.isArray(searchResult.content) &&
    (searchResult.content as WebSearchToolResultError).type === "web_search_tool_result_error";

  const accentColor = isError ? "var(--pane-error)" : "var(--pane-terminal)";

  return (
    <>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-5 leading-none border-l-2 pl-3"
        style={{
          fontSize: "var(--pane-font-size-sm)",
          borderLeftColor: `color-mix(in srgb, ${accentColor} 35%, transparent)`,
        }}
      >
        <span
          className={`w-1 h-1 rounded-full shrink-0 ${
            isError ? "bg-pane-error" :
            isComplete ? "" :
            "animate-pulse"
          }`}
          style={
            isError ? {} :
            isComplete ? { backgroundColor: `color-mix(in srgb, ${accentColor} 40%, transparent)` } :
            { backgroundColor: `color-mix(in srgb, ${accentColor} 60%, transparent)` }
          }
        />
        <span className="shrink-0 opacity-70" style={{ color: accentColor }}>search</span>
        <span className="truncate">{query}</span>
        {isError && (
          <span className="text-pane-error/80 shrink-0">err</span>
        )}
      </button>

      {expanded && searchResult && (
        <div
          className="mb-0.5 border-l-2 pl-3"
          style={{ borderLeftColor: `color-mix(in srgb, ${accentColor} 15%, transparent)` }}
        >
          {isError ? (
            <div
              className="font-mono px-2.5 py-1.5 text-pane-error
                         bg-[var(--pane-error-bg)] border border-[var(--pane-error-border)]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {(searchResult.content as WebSearchToolResultError).error_code}
            </div>
          ) : (
            <div
              className="font-mono border border-pane-border bg-pane-bg
                         max-h-[250px] overflow-y-auto"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {(searchResult.content as WebSearchResult[]).map((result, i) => (
                <a
                  key={i}
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col px-2.5 py-1.5
                             border-b border-pane-border/15 last:border-b-0
                             hover:bg-pane-text/[0.03]"
                >
                  <span className="text-pane-terminal truncate">{result.title}</span>
                  <span className="text-pane-text-secondary truncate text-[10px]">
                    {result.url}
                    {result.page_age && <span className="ml-2">{result.page_age}</span>}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
