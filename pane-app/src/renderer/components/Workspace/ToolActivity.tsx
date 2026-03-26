import { useState, useMemo, useRef, useEffect } from "react";
import type {
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultError,
} from "../../lib/punk-types";
import { MarkdownText } from "./MarkdownText";
import { MicroIndicator } from "../shared";

interface ToolActivityProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

// Parse MCP tool names: "mcp__server-name__tool_name" → { server, tool }
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.slice(5).split("__");
  if (parts.length < 2) return null;
  const server = parts[0]!.replace(/-/g, " ");
  let tool = parts.slice(1).join(" ").replace(/_/g, " ");
  // Strip redundant server prefix: "pane pane recall" → "pane recall"
  if (tool.startsWith(server + " ")) tool = tool.slice(server.length + 1);
  return { server, tool };
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  const mcp = parseMcpName(name);
  if (mcp) return mcp.tool;

  switch (name) {
    case "Read":
    case "read_file":
    case "Edit":
    case "replace":
    case "Write":
    case "write_file":
      return (input.file_path as string) || "file";
    case "Bash":
    case "run_shell_command": {
      const cmd = (input.command as string) || "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Glob":
    case "glob":
      return (input.pattern as string) || "";
    case "Grep":
    case "grep_search": {
      const pattern = (input.pattern as string) || (input.query as string) || "";
      const dirPath = input.dir_path as string;
      const includePattern = input.include_pattern as string;
      let summary = `"${pattern}"`;
      if (dirPath) summary += ` in ${dirPath}`;
      if (includePattern) summary += ` (${includePattern})`;
      return summary;
    }
    case "Plan": {
      const summary = (input.summary as string) || "";
      const steps = (input.steps as Array<{ action: string }>) || [];
      return summary || `${steps.length} steps`;
    }
    case "TodoWrite":
      return "todos";
    case "pane_plan":
      return "plan";
    case "Task":
    case "agent":
      return (input.description as string) || (input.prompt as string) || "subagent";
    case "WebSearch":
    case "google_web_search":
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
    case "Read":
    case "read_file": return "read";
    case "Glob":
    case "glob": return "glob";
    case "Grep":
    case "grep_search": return "grep";
    case "Edit":
    case "replace": return "edit";
    case "Write":
    case "write_file": return "write";
    case "Bash":
    case "run_shell_command": return "bash";
    case "Task":
    case "agent": return "agent";
    case "pane_plan": return "pane";
    case "Plan": return "plan";
    case "TodoWrite": return "todo";
    case "WebSearch":
    case "google_web_search": return "search";
    case "EnterPlanMode": return "plan";
    case "ExitPlanMode": return "plan";
    default: return name.toLowerCase();
  }
}

export function ExpandedEditInput({ input }: { input: Record<string, unknown> }) {
  const oldStr = (input.old_string as string) || "";
  const newStr = (input.new_string as string) || "";
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom to show the replacement section
  useEffect(() => {
    if (containerRef.current && newStr) {
      const container = containerRef.current;
      // Scroll to bottom after a brief delay to ensure content is rendered
      setTimeout(() => {
        container.scrollTop = container.scrollHeight;
      }, 50);
    }
  }, [newStr]);

  return (
    <div
      ref={containerRef}
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                 leading-[1.6] space-y-0"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      {oldStr && (
        <div className="px-4 py-4">
          <div className="text-[9px] uppercase tracking-wider mb-2 text-pane-text-secondary/40">
            Original
          </div>
          <div className="opacity-50">
            <MarkdownText text={`\`\`\`ts\n${oldStr}\n\`\`\``} />
          </div>
        </div>
      )}
      {newStr && (
        <div className="px-4 py-4 border-t border-pane-text-secondary/10">
          <div className="text-[9px] uppercase tracking-wider mb-2 text-pane-text-secondary/40">
            Replacement
          </div>
          <MarkdownText text={`\`\`\`ts\n${newStr}\n\`\`\``} />
        </div>
      )}
    </div>
  );
}

export function ExpandedWriteInput({ input }: { input: Record<string, unknown> }) {
  const content = (input.content as string) || "";

  return (
    <div
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                 leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      <div className="px-4 py-4">
        <MarkdownText
          text={`\`\`\`ts\n${content}\n\`\`\``}
        />
      </div>
    </div>
  );
}

function ExpandedTodoInput({ input }: { input: Record<string, unknown> }) {
  const todos = (input.todos as Array<{ content: string; status: string }>) || [];
  return (
    <div
      className="font-mono overflow-y-auto max-h-[300px]
                 leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {todos.map((todo, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-4 py-4"
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
    <div
      className="px-4 py-4 font-mono overflow-x-auto max-h-[400px] overflow-y-auto leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {JSON.stringify(input, null, 2)}
    </div>
  );
}

function ExpandedReadInput({ result }: { result?: ToolResultBlock }) {
  const content = (result?.content as string) || "";
  const hasContent = !!content && !result?.is_error;

  return (
    <div
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                 leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      {hasContent && (
        <div className="px-4 py-4">
          <MarkdownText
            text={`\`\`\`ts\n${content}\n\`\`\``}
          />
        </div>
      )}
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
      className="w-full text-left font-mono leading-[1.6]
                 hover:bg-pane-text/[0.02] transition-colors group"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
      title="click to copy"
    >
      <pre className="px-4 py-4 text-pane-text-secondary whitespace-pre-wrap break-words flex items-start justify-between gap-2">
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
      className="font-mono leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {mcp && (
        <div className="px-4 py-4 text-pane-text-secondary border-b border-pane-text-secondary/10">
          {mcp.server} / {mcp.tool}
        </div>
      )}
      <div>
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-2 px-4 py-4 border-b border-pane-border/5 last:border-b-0">
            <span className="text-pane-text-secondary shrink-0">{key.replace(/_/g, " ")}</span>
            <span className="text-pane-text-secondary truncate">
              {typeof val === "string" ? val : JSON.stringify(val)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExpandedPlanInput({ input }: { input: Record<string, unknown> }) {
  const summary = (input.summary as string) || "";
  const steps = (input.steps as Array<{ index: number; action: string; type: string; files?: string[] }>) || [];

  const typeColor = (type: string) => {
    switch (type) {
      case "read": return "var(--pane-terminal)";
      case "write": return "var(--pane-status-modified)";
      case "verify": return "var(--pane-status-added)";
      default: return "var(--pane-text-secondary)";
    }
  };

  return (
    <div
      className="font-mono leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {summary && (
        <div className="px-4 py-3 text-pane-text/80 border-b border-pane-text-secondary/10">
          {summary}
        </div>
      )}
      {steps.map((step) => (
        <div
          key={step.index}
          className="px-4 py-2.5 border-b border-pane-border/5 last:border-b-0"
        >
          <div className="flex items-start gap-2">
            <span
              className="shrink-0 font-mono opacity-60"
              style={{ fontSize: "10px", color: typeColor(step.type) }}
            >
              {step.index}. {step.type}
            </span>
            <span className="text-pane-text-secondary/70">{step.action}</span>
          </div>
          {step.files && step.files.length > 0 && (
            <div className="mt-1 ml-6 flex flex-wrap gap-2">
              {step.files.map((f, i) => (
                <span
                  key={i}
                  className="text-pane-text-secondary/40"
                  style={{ fontSize: "10px" }}
                >
                  {f.split("/").pop()}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderExpandedInput(name: string, input: Record<string, unknown>, result?: ToolResultBlock) {
  if (parseMcpName(name)) {
    return <ExpandedMcpInput input={input} toolName={name} />;
  }
  switch (name) {
    case "Edit":
    case "replace":
      return <ExpandedEditInput input={input} />;
    case "Write":
    case "write_file":
      return <ExpandedWriteInput input={input} />;
    case "Plan":
      return <ExpandedPlanInput input={input} />;
    case "TodoWrite":
      return <ExpandedTodoInput input={input} />;
    case "Read":
    case "read_file":
      return <ExpandedReadInput result={result} />;
    case "Bash":
    case "run_shell_command":
      return <ExpandedBashInput input={input} />;
    default:
      return <ExpandedDefaultInput input={input} />;
  }
}

function formatToolOutput(content: unknown): string {
  if (typeof content !== "string") {
    return JSON.stringify(content, null, 2);
  }

  const trimmed = content.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Fall back to raw content if not valid JSON
    }
  }

  // If content looks like it might be code (has indentation, braces, etc.), wrap it in code fences
  const looksLikeCode = 
    trimmed.includes("\n") && 
    (trimmed.includes("function ") || 
     trimmed.includes("const ") || 
     trimmed.includes("let ") || 
     trimmed.includes("import ") || 
     trimmed.includes("export ") ||
     trimmed.includes("class ") ||
     trimmed.match(/^\s+/m)); // Has indentation

  if (looksLikeCode) {
    // Try to detect language from content
    let lang = "text";
    if (trimmed.includes("function ") || trimmed.includes("const ") || trimmed.includes("let ")) {
      lang = "javascript";
    } else if (trimmed.includes("import ") || trimmed.includes("from ")) {
      lang = "python";
    } else if (trimmed.match(/^<\w+/m)) {
      lang = "html";
    } else if (trimmed.match(/^\.\w+\s*\{/m)) {
      lang = "css";
    }
    
    return `\`\`\`${lang}\n${content}\n\`\`\``;
  }

  return content;
}

/**
 * Strip the noise from tool error content.
 * Returns clean, minimal lines — no code fences, no stack traces, no generics soup.
 * At most 3 lines: enough to know what went wrong, not enough to overwhelm.
 */
function formatErrorContent(content: unknown): string {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const lines = raw
    .split("\n")
    .map(l => l.trim())
    // Drop empty lines, stack frames, code fence markers, and ansi escape codes
    .filter(l =>
      l.length > 0 &&
      !l.startsWith("at ") &&
      !l.startsWith("```") &&
      !l.match(/^\u001b/)
    );
  return lines.slice(0, 3).join("\n") || raw.trim().slice(0, 120);
}

export function ToolActivity({ toolUse, toolResult }: ToolActivityProps) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll for expanding tool output
  useEffect(() => {
    if (contentRef.current && !toolResult) {
      // While it's running/streaming
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [toolUse.input, toolResult]);

  // Summary updates as parameters stream in, then stabilizes once complete
  const summary = useMemo(
    () => summarizeTool(toolUse.name, toolUse.input),
    [toolUse.name, toolUse.input]
  );
  const isComplete = !!toolResult;
  const isFailed = toolResult?.is_error ?? false;

  // Stable expansion rules - NO SHAPE-SHIFTING:
  // 1. User manually toggled → respect that always
  // 2. Errors → always expanded (need immediate attention)
  // 3. Edit/Write → always expanded (must see changes)
  // 4. Read/Bash/Grep/Glob/Search → always collapsed (quiet unless clicked)
  // 5. Everything else → collapsed by default

  const alwaysExpanded = ["Edit", "Write", "replace", "write_file"];
  const alwaysCollapsed = ["Read", "Bash", "Grep", "Glob", "WebSearch", "Task", "Plan", "read_file", "run_shell_command", "grep_search", "glob", "google_web_search"];

  // Determine base tool name (expand MCP tools to the actual tool name)
  const baseToolName = (() => {
    if (toolUse.name.startsWith("mcp__")) {
      const parts = toolUse.name.slice(5).split("__");
      if (parts.length >= 2) return parts.slice(1).join(" ");
    }
    return toolUse.name;
  })();

  const expanded = userToggle !== null
    ? userToggle
    : (isFailed || alwaysExpanded.includes(baseToolName)) && !alwaysCollapsed.includes(baseToolName);

  const label = getToolLabel(toolUse.name);

  const accentColor = isFailed ? "var(--pane-error)" : "var(--pane-terminal)";

  return (
    <div
      className={`rounded-md border transition-all duration-200 ${expanded ? 'border-[var(--pane-border-soft)] bg-pane-bg/60 mb-2' : 'border-transparent hover:border-[var(--pane-border-soft)] mb-0.5'}`}
    >
      <button
        onClick={() => setUserToggle(expanded ? false : true)}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-4 group"
        style={{
          fontSize: "var(--pane-font-size-sm)",
          minHeight: '2.5rem'
        }}
      >
        <MicroIndicator
          variant={isFailed ? "error" : isComplete ? "subtle" : "strong"}
          animate={!isComplete}
          size={5}
          ariaLabel={isFailed ? "tool failed" : isComplete ? "tool complete" : "tool processing"}
        />
        <span className="shrink-0 opacity-70" style={{ color: accentColor }}>{label}</span>
        <span className="truncate">{summary}</span>
        {isFailed && (
          <span className="text-pane-error/80 shrink-0">err</span>
        )}
        <span 
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && (
        <div
          ref={contentRef}
        >
          {renderExpandedInput(toolUse.name, toolUse.input, toolResult)}

          {/* Error output — clean, unified, no markdown noise */}
          {toolResult?.is_error && (
            <div
              className="px-4 pb-4 font-mono text-pane-error leading-[1.6] whitespace-pre-wrap"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {formatErrorContent(toolResult.content)}
            </div>
          )}

          {/* Success output — hide for Edit/Write/Read (input already shows what changed) */}
          {toolResult && !toolResult.is_error && !["Edit", "Write", "Read", "replace", "write_file", "read_file"].includes(toolUse.name) && (
            <div
              className="px-4 pb-4 overflow-x-auto max-h-[250px] overflow-y-auto text-pane-text-secondary leading-[1.6]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              <MarkdownText text={formatToolOutput(toolResult.content)} />
            </div>
          )}
        </div>
      )}
    </div>
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
    [] // Empty deps = compute once, never recompute
  );
  const isComplete = !!searchResult;
  const isError =
    searchResult?.content &&
    !Array.isArray(searchResult.content) &&
    (searchResult.content as WebSearchToolResultError).type === "web_search_tool_result_error";

  const accentColor = isError ? "var(--pane-error)" : "var(--pane-terminal)";

  return (
    <div
      className={`rounded-md border transition-all duration-200 ${expanded ? 'border-[var(--pane-border-soft)] bg-pane-bg/60 mb-2' : 'border-transparent hover:border-[var(--pane-border-soft)] mb-0.5'}`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-4 group"
        style={{
          fontSize: "var(--pane-font-size-sm)",
          minHeight: '2.5rem'
        }}
      >
        <MicroIndicator
          variant={isError ? "error" : isComplete ? "subtle" : "strong"}
          animate={!isComplete}
          size={5}
          ariaLabel={isError ? "search failed" : isComplete ? "search complete" : "search processing"}
        />
        <span className="shrink-0 opacity-70" style={{ color: accentColor }}>search</span>
        <span className="truncate">{query}</span>
        {isError && (
          <span className="text-pane-error/80 shrink-0">err</span>
        )}
        <span 
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && searchResult && (
        <div
          className="px-4 py-4"
        >
          {isError ? (
            <div
              className="font-mono text-pane-error leading-[1.6]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {(searchResult.content as WebSearchToolResultError).error_code}
            </div>
          ) : (
            <div
              className="font-mono max-h-[250px] overflow-y-auto"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {(searchResult.content as WebSearchResult[]).map((result, i) => (
                <a
                  key={i}
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col py-2.5 -mx-4 px-4
                             border-b border-pane-border/10 last:border-b-0
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
    </div>
  );
}
