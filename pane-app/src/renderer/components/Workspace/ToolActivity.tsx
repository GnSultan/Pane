import { useState, useMemo, useRef, useEffect } from "react";
import type {
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultError,
} from "../../lib/punk-types";
import { MarkdownText, renderHighlightedCode } from "./MarkdownText";
import { MicroIndicator } from "../shared";
import { useProjectsStore } from "../../stores/projects";
import { writePty } from "../../lib/tauri-commands";

interface ToolActivityProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  isHistorical?: boolean;
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
  // Bare pane_* tool names from API backend (no mcp__ prefix)
  if (name.startsWith("pane_")) {
    switch (name) {
      case "pane_run_in_terminal": {
        const cmd = (input.command as string) || "";
        return "terminal" + (cmd ? ` ${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}` : "");
      }
      case "pane_recall": {
        const q = (input.query as string) || "";
        return q ? `recall ${q}` : "recall";
      }
      case "pane_recall_all": {
        const q = (input.query as string) || "";
        return q ? `recall all ${q}` : "recall all";
      }
      case "pane_remember": {
        const c = (input.content as string) || "";
        return "remember" + (c ? ` ${c.slice(0, 60)}` : "");
      }
      case "pane_brief": return "brief";
      case "pane_recent_terminal": return "recent terminal";
      case "pane_search_changes": {
        const q = (input.query as string) || "";
        return q ? `search changes ${q}` : "search changes";
      }
      case "pane_checkpoints": return "checkpoints";
      case "pane_change_history": return "change history";
      case "pane_set_about": return "set about";
      case "pane_set_philosophy": return "set philosophy";
      case "pane_set_rule": return "set rule";
      case "pane_cross_project": {
        const q = (input.query as string) || "";
        return q ? `cross project ${q}` : "cross project";
      }
      case "pane_knowledge_graph": return "knowledge graph";
      case "pane_find_symbol": {
        const q = (input.query as string) || (input.symbol as string) || "";
        return q ? `find symbol ${q}` : "find symbol";
      }
      case "pane_open_files": return "open files";
      case "pane_profile": return "profile";
      case "pane_project_context": return "project context";
      case "pane_read_files": {
        const paths = input.paths as string[] | undefined;
        return paths?.length ? `read ${paths.length} files` : "read files";
      }
      case "pane_find_references": {
        const sym = (input.symbol as string) || "";
        return sym ? `references ${sym}` : "references";
      }
      case "pane_codebase_compass": {
        const q = (input.query as string) || "";
        return q ? `compass ${q.slice(0, 50)}` : "compass";
      }
      case "pane_codebase_navigator": {
        const t = (input.target as string) || "";
        return t ? `navigate ${t}` : "navigate";
      }
      case "pane_ui_constraints": {
        const c = (input.component as string) || "";
        return c ? `ui ${c}` : "ui";
      }
      case "pane_architecture_brief": {
        const s = (input.subsystem as string) || "";
        return s ? `architecture ${s}` : "architecture brief";
      }
      case "pane_revert_change": return "revert";
      default:
        return name.slice(5).replace(/_/g, " ");
    }
  }

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
    case "pane_plan":
      return "plan";
    case "Task":
    case "agent":
      return (input.description as string) || (input.prompt as string) || "subagent";
    case "WebSearch":
    case "google_web_search":
      return (input.query as string) || "";
    case "explore": {
      const q = (input.query as string) || "";
      return q ? `explore ${q.slice(0, 50)}` : "explore";
    }
    case "evaluate_js":
      return "evaluate";
    case "list_directory":
      return (input.dir_path as string) || "list directory";
    case "web_fetch":
      return "fetch";
    case "EnterPlanMode":
      return "entering plan mode";
    case "ExitPlanMode":
      return "ready for review";
    default:
      return name;
  }
}

function getToolLabel(name: string): string {
  // Bare pane_* tool names from API backend (no mcp__ prefix)
  if (name.startsWith("pane_")) return "pane";

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
    case "WebSearch":
    case "google_web_search": return "search";
    case "EnterPlanMode": return "plan";
    case "ExitPlanMode": return "plan";
    default: return name.toLowerCase();
  }
}

/**
 * Detect syntax highlighting language from a file path.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "py": return "python";
    case "html": return "html";
    case "css": return "css";
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    case "md": case "mdx": return "markdown";
    case "sh": case "bash": case "zsh": return "bash";
    default: return "javascript";
  }
}

export function ExpandedEditInput({ input, result }: { input: Record<string, unknown>; result?: ToolResultBlock }) {
  const oldStr = (input.old_string as string) || "";
  const newStr = (input.new_string as string) || "";
  const filePath = (input.file_path as string) || "";
  const containerRef = useRef<HTMLDivElement>(null);

  // Actual line number where the old_string starts in the file (1-based)
  const fileStartLine = (result?.metadata?.startLine as number) || 1;

  const lang = useMemo(() => detectLanguage(filePath), [filePath]);

  // Two-phase rendering:
  // Phase 1: replacement hasn't started → old code as plain document (no strikethrough)
  // Phase 2: new_string is streaming → old code struck through, new code streams in
  const isReplacing = newStr.length > 0;

  // ── Phase 1 debounce: old code should materialize fully formed ──
  // Without this, old_string streams in character by character via the
  // partial_json_delta pipeline, creating a "writing in" effect that looks
  // fake. Debounce the display until old_string stabilizes.
  const [displayOldStr, setDisplayOldStr] = useState(oldStr);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (isReplacing) {
      // Phase 2: old code is complete — show it immediately (struck through)
      setDisplayOldStr(oldStr);
    } else {
      // Phase 1: debounce — old code is still streaming in via partial JSON
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setDisplayOldStr(oldStr), 150);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [oldStr, isReplacing]);

  // Scroll to bottom as new replacement code streams in (Phase 2 only)
  useEffect(() => {
    if (isReplacing && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [newStr, isReplacing]);

  // Compute lines for both phases (must be before any early return — Rules of Hooks)
  const oldLines = useMemo(() => (oldStr ? oldStr.split("\n") : []), [oldStr]);
  const newLines = useMemo(() => (newStr ? newStr.split("\n") : []), [newStr]);

  // ── Phase 1: Old code rendered as it appears in the actual document ──
  // Uses debounced displayOldStr — code appears fully formed, not typed out
  if (!isReplacing) {
    if (!displayOldStr) return null;
    const displayLines = displayOldStr.split("\n");
    return (
      <div
        className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto leading-[1.6]"
        style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
      >
        <div className="px-4 py-4 space-y-0">
          {displayLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
              {/* Line number — matches file viewer style */}
              <span
                className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
                style={{
                  width: "3em",
                  opacity: 0.4,
                  fontSize: "calc(var(--pane-font-size) - 2px)",
                }}
              >
                {fileStartLine + i}
              </span>
              {/* Code — full opacity, no strikethrough, syntax highlighted */}
              <span>
                {line.length > 0
                  ? renderHighlightedCode(line, lang)
                  : <>&nbsp;</>}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Phase 2: Replacement streaming ──
  // Old lines: instantly struck through, full opacity — they're in the file, always there
  // New lines: stream in below, full opacity — the replacement arriving
  if (oldLines.length === 0 && newLines.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      <div className="px-4 py-4 space-y-0">
        {/* Struck-through old lines — always there, full opacity */}
        {oldLines.map((line, i) => (
          <div
            key={`old-${i}`}
            className="whitespace-pre-wrap break-words flex gap-3"
            style={{ opacity: 0.75 }}
          >
            <span
              className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
              style={{
                width: "3em",
                opacity: 0.4,
                fontSize: "calc(var(--pane-font-size) - 2px)",
              }}
            >
              {fileStartLine + i}
            </span>
            <span
              className="line-through"
              style={{ textDecorationColor: "var(--pane-error)" }}
            >
              {line.length > 0
                ? renderHighlightedCode(line, lang)
                : <>&nbsp;</>}
            </span>
          </div>
        ))}
        {/* Streaming new lines — full opacity, sequential line numbers from start position */}
        {newLines.map((line, i) => (
          <div
            key={`new-${i}`}
            className="whitespace-pre-wrap break-words flex gap-3"
          >
            <span
              className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
              style={{
                width: "3em",
                opacity: 0.4,
                fontSize: "calc(var(--pane-font-size) - 2px)",
              }}
            >
              {fileStartLine + i}
            </span>
            <span>
              {line.length > 0
                ? renderHighlightedCode(line, lang)
                : <>&nbsp;</>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExpandedWriteInput({ input }: { input: Record<string, unknown> }) {
  const content = (input.content as string) || "";
  const filePath = (input.file_path as string) || "";
  const scrollRef = useRef<HTMLDivElement>(null);

  const lang = useMemo(() => detectLanguage(filePath), [filePath]);

  const lines = useMemo(() => {
    if (!content) return [];
    return content.split("\n");
  }, [content]);

  // useEffect fires before paint — ensures the scroll tracks the stream
  // position on every frame without a top-of-file flash.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content]);

  if (lines.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                 leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      <div className="px-4 py-4 space-y-0">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
            {/* Line number — right-aligned in fixed width, dimmed */}
            <span
              className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
              style={{
                width: "3em",
                opacity: 0.4,
                fontSize: "calc(var(--pane-font-size) - 2px)",
              }}
            >
              {i + 1}
            </span>
            {/* Code content — syntax highlighted */}
            <span>
              {line.length > 0
                ? renderHighlightedCode(line, lang)
                : <>&nbsp;</>}
            </span>
          </div>
        ))}
      </div>
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

function ExpandedReadInput({ input, result }: { input?: Record<string, unknown>; result?: ToolResultBlock }) {
  const content = (result?.content as string) || "";
  const filePath = (input?.file_path as string) || "";
  const hasContent = !!content && !result?.is_error;

  const lang = useMemo(() => detectLanguage(filePath), [filePath]);

  const lines = useMemo(() => {
    if (!content) return [];
    return content.split("\n");
  }, [content]);

  if (!hasContent || lines.length === 0) return null;

  return (
    <div
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto
                 leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      <div className="px-4 py-4 space-y-0">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
            {/* Line number — right-aligned in fixed width, dimmed */}
            <span
              className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
              style={{
                width: "3em",
                opacity: 0.4,
                fontSize: "calc(var(--pane-font-size) - 2px)",
              }}
            >
              {i + 1}
            </span>
            {/* Code content — syntax highlighted */}
            <span>
              {line.length > 0
                ? renderHighlightedCode(line, lang)
                : <>&nbsp;</>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExpandedBashInput({ input }: { input: Record<string, unknown> }) {
  const cmd = (input.command as string) || "";
  const [copied, setCopied] = useState(false);
  const [ran, setRan] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = useProjectsStore.getState();
    const projectId = s.activeProjectId;
    if (!projectId) return;
    const tabId = s.projects.get(projectId)?.activeTerminalTabId;
    if (!tabId) return;
    writePty(tabId, cmd + "\n").catch(() => {});
    s.setMode(projectId, "terminal");
    setRan(true);
    setTimeout(() => setRan(false), 1200);
  };

  return (
    <div
      className="w-full font-mono leading-[1.6] group hover:bg-pane-text/[0.02] transition-colors"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      <pre className="px-4 py-4 text-pane-text-secondary whitespace-pre-wrap break-words flex items-start justify-between gap-2">
        <span>$ {cmd}</span>
        <span className="shrink-0 flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="text-pane-text-secondary/50 hover:text-pane-text-secondary transition-colors"
            title="copy"
          >
            {copied ? "✓" : "copy"}
          </button>
          <button
            onClick={handleRun}
            className="transition-colors"
            style={{ color: ran ? "var(--pane-status-added)" : "var(--pane-terminal)" }}
            title="run in terminal"
          >
            {ran ? "✓" : "run"}
          </button>
        </span>
      </pre>
    </div>
  );
}

function ExpandedMcpInput({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  return (
    <div
      className="font-mono leading-[1.6]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {entries.map(([key, val]) => (
        <div key={key} className="flex gap-2 px-4 py-4 border-b border-pane-border/5 last:border-b-0">
          <span className="text-pane-text-secondary shrink-0">{key.replace(/_/g, " ")}</span>
          <span className="text-pane-text-secondary truncate">
            {typeof val === "string" ? val : JSON.stringify(val)}
          </span>
        </div>
      ))}
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
  if (name.startsWith("pane_") || parseMcpName(name)) {
    return <ExpandedMcpInput input={input} />;
  }
  switch (name) {
    case "Edit":
    case "replace":
      return <ExpandedEditInput input={input} result={result} />;
    case "Write":
    case "write_file":
      return <ExpandedWriteInput input={input} />;
    case "Plan":
      return <ExpandedPlanInput input={input} />;
    case "Read":
    case "read_file":
      return <ExpandedReadInput input={input} result={result} />;
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

export function ToolActivity({ toolUse, toolResult, isHistorical }: ToolActivityProps) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);

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
    // Bare pane_* tools are always collapsed by default (quiet MCP tools)
    if (toolUse.name.startsWith("pane_")) return toolUse.name;
    return toolUse.name;
  })();

  // Edit/Write are always expanded for live messages — completed or not. Users need to see what changed.
  // Historical messages (restored from DB) start collapsed — user can expand on demand.
  const expanded = userToggle !== null
    ? userToggle
    : isHistorical
      ? false
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
        <div>
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
  isHistorical?: boolean;
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
