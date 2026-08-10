import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { lineDiff, type DiffLine } from "../../lib/diff";
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
import { readFile } from "../../lib/tauri-commands";

interface ToolActivityProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  isHistorical?: boolean;
}

// Tools that operate on a single file and can be promoted to viewer mode
const FILE_TOOLS = new Set(["Edit", "Write", "Read", "replace", "write_file", "read_file"]);

function getFilePath(name: string, input: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.has(name)) return null;
  return (input.file_path as string) || null;
}

// For write_file / Write tools we already have the content in the input.
// For read_file / Read / Edit the content lives in the tool result.
function getFileContent(
  name: string,
  input: Record<string, unknown>,
  result?: ToolResultBlock,
): string | null {
  if (name === "write_file" || name === "Write") {
    return (input.content as string) ?? null;
  }
  if (name === "read_file" || name === "Read") {
    if (!result || result.is_error) return null;
    return typeof result.content === "string" ? result.content : null;
  }
  // Edit / replace — read fresh from disk (result contains a success message, not content)
  return null;
}

function useOpenFile(
  name: string,
  input: Record<string, unknown>,
  result?: ToolResultBlock,
) {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const openFile = useProjectsStore((s) => s.openFile);

  return useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeProjectId) return;
    const filePath = getFilePath(name, input);
    if (!filePath) return;

    // Prefer inline content; fall back to reading from disk (Edit/replace)
    let content = getFileContent(name, input, result);
    if (content === null) {
      try {
        content = await readFile(filePath);
      } catch {
        return;
      }
    }
    openFile(activeProjectId, filePath, content);
  }, [activeProjectId, openFile, name, input, result]);
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



// Label = colored accent prefix (the action verb)
function getPaneToolLabel(name: string): string | null {
  switch (name) {
    case "pane_run_in_terminal": return "terminal";
    case "pane_recall": return "recall";
    case "pane_recall_all": return "recall";
    case "pane_remember": return "remember";
    case "pane_brief": return "brief";
    case "pane_search_changes": return "changes";
    case "pane_checkpoints": return "checkpoints";
    case "pane_checkpoint": return "checkpoint";
    case "pane_change_history": return "history";
    case "pane_set_about": return "about";
    case "pane_set_philosophy": return "philosophy";
    case "pane_set_rule": return "rule";
    case "pane_delegate": return "delegate";
    case "pane_cross_project": return "cross";
    case "pane_knowledge_graph": return "graph";
    case "pane_find_symbol": return "symbol";
    case "pane_open_files": return "files";
    case "pane_profile": return "profile";
    case "pane_project_context": return "context";
    case "pane_read_files": return "read";
    case "pane_find_references": return "references";
    case "pane_codebase_compass": return "compass";
    case "pane_codebase_navigator": return "navigate";
    case "pane_ui_constraints": return "ui";
    case "pane_architecture_brief": return "architecture";
    case "pane_revert_change": return "revert";
    case "pane_update_memory": return "memory";
    case "pane_delete_memory": return "memory";
    case "pane_directory": return "directory";
    case "pane_get_session_state": return "state";
    case "pane_get_project_map": return "map";
    case "pane_get_recent_changes": return "changes";
    case "pane_get_handoff": return "handoff";
    case "pane_read_journal": return "journal";
    case "pane_check_intents": return "intents";
    case "pane_list_skills": return "skills";
    case "pane_list_active_skills": return "skills";
    case "pane_skill_info": return "skill";
    case "pane_install_skill": return "install";
    case "pane_ui_constraints": return "ui";
    case "pane_lens_findings": return "lens";
    default: return null;
  }
}

// Summary = descriptive detail after the label
function summarizePaneTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "pane_run_in_terminal": {
      const cmd = (input.command as string) || "";
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd) : "";
    }
    case "pane_recall": {
      const q = (input.query as string) || "";
      return q ? q.slice(0, 60) : "recent";
    }
    case "pane_recall_all": {
      const q = (input.query as string) || "";
      return q ? `all ${q.slice(0, 60)}` : "all projects";
    }
    case "pane_remember": {
      const c = (input.content as string) || "";
      return c ? c.slice(0, 60) : "";
    }
    case "pane_brief": return "";
    case "pane_search_changes": {
      const q = (input.query as string) || "";
      return q || "all";
    }
    case "pane_checkpoints": return "";
    case "pane_checkpoint": {
      const label = (input.label as string) || "";
      return label || "";
    }
    case "pane_change_history": return "";
    case "pane_set_about":
    case "pane_set_philosophy":
    case "pane_set_rule": return "";
    case "pane_delegate": {
      const obj = (input.objective as string) || "";
      return obj ? obj.slice(0, 60) : "";
    }
    case "pane_cross_project": {
      const q = (input.query as string) || "";
      return q ? q.slice(0, 50) : "";
    }
    case "pane_knowledge_graph": return "";
    case "pane_find_symbol": {
      const q = (input.query as string) || (input.symbol as string) || "";
      return q ? q.slice(0, 50) : "";
    }
    case "pane_open_files": return "";
    case "pane_profile": return "";
    case "pane_project_context": return "";
    case "pane_read_files": {
      const paths = input.paths as string[] | undefined;
      return paths?.length ? `${paths.length} files` : "";
    }
    case "pane_find_references": {
      const sym = (input.symbol as string) || "";
      return sym ? sym.slice(0, 50) : "";
    }
    case "pane_codebase_compass": {
      const q = (input.query as string) || "";
      return q ? q.slice(0, 50) : "";
    }
    case "pane_codebase_navigator": {
      const t = (input.target as string) || "";
      return t ? t.slice(0, 50) : "";
    }
    case "pane_ui_constraints": {
      const c = (input.component as string) || "";
      return c ? c.slice(0, 50) : "";
    }
    case "pane_architecture_brief": {
      const s = (input.subsystem as string) || "";
      return s ? s.slice(0, 50) : "";
    }
    case "pane_revert_change": return "";
    case "pane_update_memory": {
      const c = (input.content as string) || "";
      return c ? c.slice(0, 40) : "";
    }
    case "pane_delete_memory": {
      const c = (input.content as string) || "";
      return c ? c.slice(0, 40) : "";
    }
    case "pane_directory": {
      return (input.dir_path as string) || "";
    }
    default:
      return name.slice(5).replace(/_/g, " ");
  }
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  // Bare pane_* tool names from API backend (no mcp__ prefix)
  if (name.startsWith("pane_")) {
    return summarizePaneTool(name, input);
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
    case "Task":
    case "agent":
      return (input.task as string) || (input.description as string) || (input.prompt as string) || "task";
    case "WebSearch":
    case "google_web_search":
      return (input.query as string) || "";
    case "explore": {
      const q = (input.query as string) || "";
      return q ? q.slice(0, 50) : "";
    }
    case "evaluate_js":
      return "";
    case "web_fetch": {
      const url = (input.url as string) || "";
      return url ? url.slice(0, 60) : "";
    }
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
  const paneLabel = getPaneToolLabel(name);
  if (name.startsWith("pane_") && paneLabel) return paneLabel;

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
    case "agent": return "task";
    case "explore": return "explore";
    case "evaluate_js": return "evaluate";
    case "web_fetch": return "fetch";
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
  // Phase 1: replacement hasn't started → old code as plain document (no decoration)
  // Phase 2: new_string is streaming → compute line-level diff so only actual
  //          changes are highlighted, context lines stay at full opacity
  const isReplacing = newStr.length > 0;

  // ── Phase 1 debounce: old code should materialize fully formed ──
  // Without this, old_string streams in character by character via the
  // partial_json_delta pipeline, creating a "writing in" effect that looks
  // fake. Debounce the display until old_string stabilizes.
  const [displayOldStr, setDisplayOldStr] = useState(oldStr);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (isReplacing) {
      // Phase 2: old code is complete — show it immediately
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

  // ── Phase 2: Diff-based replacement rendering ──
  // Computed unconditionally (hooks can't be called after an early return).
  // Compute a line-level diff so only changed lines are marked. Context lines
  // (unchanged) render at full opacity with no decoration. Removed lines get
  // strikethrough + deletion tint. Added lines get an addition tint.
  const diffLines = useMemo(() => lineDiff(oldStr, newStr), [oldStr, newStr]);

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

  if (diffLines.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="font-mono overflow-x-auto max-h-[400px] overflow-y-auto leading-[1.6]"
      style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
    >
      <div className="px-4 py-4 space-y-0">
        {diffLines.map((dl: DiffLine, i: number) => {
          // Compute the line number to display in the gutter.
          // For equal/remove lines, use the old file position (where the user
          // would see it). For add lines, use the new position.
          const lineNum = dl.oldLine !== null
            ? fileStartLine + dl.oldLine - 1
            : (dl.newLine !== null ? fileStartLine + dl.newLine - 1 : "");

          if (dl.type === "equal") {
            return (
              <div key={i} className="whitespace-pre-wrap break-words flex gap-3">
                <span
                  className="select-none shrink-0 text-right text-pane-text-secondary tracking-wider"
                  style={{ width: "3em", opacity: 0.4, fontSize: "calc(var(--pane-font-size) - 2px)" }}
                >
                  {lineNum}
                </span>
                <span>
                  {dl.text.length > 0
                    ? renderHighlightedCode(dl.text, lang)
                    : <>&nbsp;</>}
                </span>
              </div>
            );
          }

          if (dl.type === "remove") {
            return (
              <div
                key={i}
                className="whitespace-pre-wrap break-words flex gap-3"
                style={{ background: "var(--pane-status-deleted-bg, rgba(166, 114, 114, 0.08))" }}
              >
                <span
                  className="select-none shrink-0 text-right tracking-wider"
                  style={{ width: "3em", opacity: 0.4, fontSize: "calc(var(--pane-font-size) - 2px)" }}
                >
                  {lineNum}
                </span>
                <span>
                  {dl.text.length > 0
                    ? renderHighlightedCode(dl.text, lang)
                    : <>&nbsp;</>}
                </span>
              </div>
            );
          }

          // add
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-words flex gap-3"
              style={{ background: "var(--pane-status-added-bg, rgba(138, 154, 108, 0.1))" }}
            >
              <span
                className="select-none shrink-0 text-right tracking-wider"
                style={{ width: "3em", opacity: 0.4, fontSize: "calc(var(--pane-font-size) - 2px)" }}
              >
                {lineNum}
              </span>
              <span>
                {dl.text.length > 0
                  ? renderHighlightedCode(dl.text, lang)
                  : <>&nbsp;</>}
              </span>
            </div>
          );
        })}
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

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
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

  // "edit" button — available once a file tool completes successfully
  const handleOpenFile = useOpenFile(toolUse.name, toolUse.input, toolResult);
  const canOpenFile = isComplete && !isFailed && FILE_TOOLS.has(toolUse.name) && !!getFilePath(toolUse.name, toolUse.input);

  // Stable expansion rules - NO SHAPE-SHIFTING:
  // 1. User manually toggled → respect that always
  // 2. Edit/Write → always expanded (must see changes)
  // 3. Read/Bash/Grep/Glob/Search → always collapsed (quiet unless clicked)
  // 4. Everything else → collapsed by default

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
      : alwaysExpanded.includes(baseToolName) && !alwaysCollapsed.includes(baseToolName);

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
        <span className="ml-auto shrink-0 flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
          {canOpenFile && (
            <span
              role="button"
              onClick={handleOpenFile}
              className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono transition-colors"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
              title="open in editor"
            >
              edit
            </span>
          )}
          <span
            className="text-pane-text-secondary/20 font-mono"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {expanded ? "collapse" : "expand"}
          </span>
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
