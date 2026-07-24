import { memo, useMemo, useState, useEffect } from "react";
import type React from "react";

/**
 * Lightweight markdown renderer — zero dependencies.
 * Handles code fences, inline code, bold, italic, links, headings,
 * blockquotes, tables, lists, and horizontal rules.
 * Anything unrecognized renders as literal text.
 *
 * All sizes scale with --pane-font-size CSS variable (Cmd+/- adjustable).
 */

// Module-level time-budgeted parse queue.
//
// Problem: on restore, 30+ messages each schedule a setTimeout(0) for
// parseBlocks, and each LazyHighlightedCode schedules another for
// renderHighlightedCode. Even though no individual call exceeds 20ms,
// they all fire in rapid succession (same macrotask batch) and
// collectively block the main thread for 500ms+.
//
// Solution: funnel all deferred work through this queue. Each tick
// processes jobs until the 14ms per-frame budget is consumed, then
// yields via setTimeout(0) so the browser can paint/handle input
// before the next batch. Jobs queued while a tick is running are
// picked up automatically in the next tick.
const _parseQueue = (() => {
  const q: Array<() => void> = [];
  let scheduled = false;

  function tick() {
    scheduled = false;
    const deadline = performance.now() + 14; // ~one frame budget
    while (q.length > 0 && performance.now() < deadline) {
      q.shift()!();
    }
    if (q.length > 0) {
      scheduled = true;
      setTimeout(tick, 0);
    }
  }

  return {
    enqueue(job: () => void): () => void {
      q.push(job);
      if (!scheduled) {
        scheduled = true;
        setTimeout(tick, 0);
      }
      return () => {
        const i = q.indexOf(job);
        if (i !== -1) q.splice(i, 1);
      };
    },
  };
})();

// --- Syntax Highlighting ---

interface SyntaxToken {
  type: "keyword" | "string" | "number" | "comment" | "function" | "operator" | "punctuation" | "text";
  content: string;
}

// Helper function to escape special regex characters
function escapeRegExp(str: string): string {
  const specialChars = "*+?^${}()|[]\\";
  return str.split('').map(char => 
    specialChars.includes(char) ? '\\' + char : char
  ).join('');
}

function highlightSyntax(code: string, language: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  
  // Build regex patterns with priorities
  const patterns = [
    // Comments (highest priority)
    { pattern: /(?:\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)/gm, type: "comment" as const },
    // Strings (with escape handling)
    { pattern: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, type: "string" as const },
    // Numbers
    { pattern: /\b(?:\d+\.?\d*)\b/g, type: "number" as const },
    // Keywords (language-specific)
    { pattern: new RegExp(`\\b(?:${getKeywords(language).map(escapeRegExp).join('|')})\\b`, "g"), type: "keyword" as const },
    // Function calls
    { pattern: /\b(?:[a-zA-Z_]\w*)\s*\(/g, type: "function" as const },
    // Operators
    { pattern: /[+\-*/%=<>!&|^~?:]+/g, type: "operator" as const },
    // Punctuation
    { pattern: /[{}[\]();,.]/g, type: "punctuation" as const },
  ];

  // Create a single regex that matches any of the patterns
  const combinedPattern = new RegExp(
    patterns.map(p => `(${p.pattern.source})`).join("|"),
    "gm"
  );

  let lastIndex = 0;
  let match;
  
  while ((match = combinedPattern.exec(code)) !== null) {
    // Add any text before this match
    if (match.index > lastIndex) {
      tokens.push({ type: "text", content: code.slice(lastIndex, match.index) });
    }
    
    // Determine which pattern matched
    for (let j = 0; j < patterns.length; j++) {
      const matchedContent = match[j + 1];
      const pattern = patterns[j];
      if (matchedContent !== undefined && pattern) {
        tokens.push({ type: pattern.type, content: matchedContent });
        break;
      }
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add any remaining text
  if (lastIndex < code.length) {
    tokens.push({ type: "text", content: code.slice(lastIndex) });
  }
  
  return tokens;
}

function getKeywords(language: string): string[] {
  const baseKeywords = [
    "const", "let", "var", "function", "return", "if", "else", "for", "while", 
    "do", "switch", "case", "break", "continue", "try", "catch", "finally",
    "throw", "new", "this", "class", "extends", "super", "import", "export",
    "default", "from", "as", "async", "await", "yield", "of", "in", "instanceof",
    "typeof", "void", "delete", "true", "false", "null", "undefined"
  ];

  const languageKeywords: Record<string, string[]> = {
    javascript: baseKeywords,
    typescript: [
      ...baseKeywords,
      "interface", "type", "enum", "implements", "public", "private", "protected",
      "readonly", "abstract", "static", "namespace", "declare", "any", "unknown",
      "never", "keyof", "infer", "satisfies"
    ],
    python: [
      "def", "return", "if", "elif", "else", "for", "while", "break", "continue",
      "pass", "try", "except", "finally", "raise", "class", "import", "from",
      "as", "with", "lambda", "yield", "global", "nonlocal", "assert", "and",
      "or", "not", "in", "is", "True", "False", "None", "async", "await"
    ],
    html: [
      "html", "head", "body", "div", "span", "p", "a", "img", "script", "style",
      "link", "meta", "title", "header", "footer", "nav", "section", "article",
      "aside", "main", "form", "input", "button", "label", "select", "textarea"
    ],
    css: [
      "color", "background", "margin", "padding", "border", "width", "height",
      "font", "display", "position", "top", "right", "bottom", "left", "z-index",
      "flex", "grid", "box-shadow", "text-align", "line-height", "opacity"
    ],
    json: ["true", "false", "null"],
    markdown: ["#", "##", "###", "####", "#####", "######", "-", "*", "+", ">"],
    mjs: baseKeywords,
    cjs: baseKeywords,
    jsx: baseKeywords,
    tsx: [...baseKeywords, "interface", "type", "enum", "public", "private", "protected"],
    yml: ["true", "false", "null", "yes", "no"],
    yaml: ["true", "false", "null", "yes", "no"],
    bash: ["if", "then", "else", "fi", "for", "do", "done", "while", "until", "case", "esac", "function"],
    sh: ["if", "then", "else", "fi", "for", "do", "done", "while", "until", "case", "esac", "function"]
  };
  
  const lang = language.toLowerCase().trim();
  
  // Handle common aliases
  const aliases: Record<string, string> = {
    "js": "javascript",
    "ts": "typescript",
    "py": "python",
    "yml": "yaml",
    "mjs": "mjs",
    "cjs": "cjs",
    "jsx": "jsx",
    "tsx": "tsx"
  };
  
  const normalizedLang = aliases[lang] || lang;
  
  return languageKeywords[normalizedLang] || baseKeywords;
}

export function renderHighlightedCode(code: string, language: string): React.JSX.Element[] {
  const tokens = highlightSyntax(code, language);
  
  return tokens.map((token, index) => {
    // String tokens that contain a file path: keep quotes in string color, highlight the path in pane-error
    if (token.type === "string" && token.content.length >= 3) {
      const first = token.content[0];
      const last = token.content[token.content.length - 1];
      if ((first === '"' || first === "'" || first === "`") && last === first) {
        const inner = token.content.slice(1, -1);
        if (SPECIAL_REGEX.test(inner)) {
          return (
            <span key={index}>
              <span className="text-pane-syn-string">{first}</span>
              <span className="text-pane-error">{inner}</span>
              <span className="text-pane-syn-string">{last}</span>
            </span>
          );
        }
      }
    }

    let className = "";
    switch (token.type) {
      case "keyword":
        className = "text-pane-syn-keyword font-semibold";
        break;
      case "string":
        className = "text-pane-syn-string";
        break;
      case "number":
        className = "text-pane-syn-number";
        break;
      case "comment":
        className = "text-pane-syn-comment italic";
        break;
      case "function":
        className = "text-pane-syn-function";
        break;
      case "operator":
        className = "text-pane-syn-operator";
        break;
      case "punctuation":
        className = "text-pane-syn-property";
        break;
      default:
        className = "text-pane-text/85";
    }

    return (
      <span key={index} className={className}>
        {token.content}
      </span>
    );
  });
}

// --- Emoji stripping ---

const emojiPattern =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function stripEmojis(text: string): string {
  return text.replace(emojiPattern, "").replace(/  +/g, " ");
}

interface MarkdownTextProps {
  text: string;
  isStreaming?: boolean;
  isThinking?: boolean;
  projectId?: string; // when provided, file paths become clickable
}

export const MarkdownText = memo(function MarkdownText({
  text,
  isStreaming,
  isThinking,
  projectId,
}: MarkdownTextProps) {
  if (!text) return null;

  // During streaming, we use incremental parsing to provide rich formatting
  // without the performance cost of full document parsing on every frame.
  // We parse inline formatting (bold, code, links) and detect simple block
  // boundaries for a better streaming experience.
  const shouldParseMarkdown = !isStreaming && text.length <= 30_000;
  const shouldParseIncremental = isStreaming;

  // Defer full markdown parsing to after first paint. wrapBareJson uses a
  // greedy regex that is slow on code-heavy messages, and parseBlocks running
  // synchronously across 30 restored messages blocks the main thread.
  // Initial render shows plain text; blocks fill in on the next idle frame.
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  useEffect(() => {
    if (!shouldParseMarkdown) { setBlocks(null); return; }
    let cancelled = false;
    const cancel = _parseQueue.enqueue(() => {
      if (!cancelled) setBlocks(parseBlocks(text));
    });
    return () => { cancelled = true; cancel(); };
  }, [text, shouldParseMarkdown]);

  const incrementalBlocks = useMemo(
    () => (shouldParseIncremental ? parseIncremental(text) : null),
    [text, shouldParseIncremental],
  );

  // Define types for grouped items
  type GroupedCodeBlock = { type: "code_block"; lang: string; chunks: IncrementalBlock[] };
  type GroupedInline = { type: "group"; blocks: IncrementalBlock[] };
  type GroupedItem = IncrementalBlock | GroupedCodeBlock | GroupedInline;

  if (incrementalBlocks) {
    // Group consecutive chunks into stable containers to prevent "slipping"
    const groups: GroupedItem[] = [];
    let currentCodeBlock: GroupedCodeBlock | null = null;
    
    for (const b of incrementalBlocks) {
      const last = groups[groups.length - 1];
      
      // Handle code block grouping
      if (b.type === "code_start") {
        currentCodeBlock = { type: "code_block", lang: b.lang, chunks: [] };
        groups.push(currentCodeBlock);
        continue;
      } else if (b.type === "code_end") {
        currentCodeBlock = null;
        continue;
      } else if (b.type === "code_chunk" && currentCodeBlock) {
        currentCodeBlock.chunks.push(b);
        continue;
      }
      
      // Reset code block if we encounter a non-code block while in code block
      if (currentCodeBlock && b.type !== "code_chunk") {
        currentCodeBlock = null;
      }
      
      // Types that should be grouped into a single paragraph
      const isInline = b.type === "inline" || b.type === "paragraph_chunk" || b.type === "list_item";
      
      if (isInline && last && (last as GroupedInline).type === "group") {
        (last as GroupedInline).blocks.push(b);
      } else if (isInline) {
        groups.push({ type: "group", blocks: [b] });
      } else {
        groups.push(b);
      }
    }

    return (
      <div className={isThinking ? "space-y-1" : "space-y-4"}>
        {groups.map((item, i) => {
          if (item.type === "group") {
            const groupItem = item as GroupedInline;
            const isListItem = groupItem.blocks[0]?.type === "list_item";
            const Tag = isListItem ? "li" : "p";
            return (
              <Tag
                key={i}
                className={`${isThinking ? "whitespace-pre-wrap break-words" : "text-pane-text leading-[1.75] whitespace-pre-wrap break-words mb-5"}`}
                style={{
                  fontSize: isThinking ? "inherit" : "var(--pane-font-size)",
                  maxWidth: "65ch",
                }}
              >
                {groupItem.blocks.map((b, bi) => (
                  <span key={bi}>
                    {"content" in b && typeof b.content === "string" && renderInline(b.content, isThinking, projectId)}
                  </span>
                ))}
              </Tag>
            );
          }
          
          // Handle code_block type
          if (item.type === "code_block") {
            const codeBlock = item as GroupedCodeBlock;
            const codeContent = codeBlock.chunks
              .map((c) => c.type === "code_chunk" ? c.content : "")
              .join("\n");
            
            return (
              <div key={i} className={isThinking ? "my-2" : "my-6"}>
                {codeBlock.lang && (
                  <div className="flex items-center gap-2 text-[10px] font-mono text-pane-text-secondary/60 mb-2 uppercase tracking-[0.1em]">
                    <span className="w-2 h-2 rounded-full bg-pane-terminal/60"></span>
                    {codeBlock.lang}
                  </div>
                )}
                <div
                  className="font-mono overflow-x-auto leading-[1.75] px-4 py-3 rounded-md"
                  style={{ 
                    fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)`
                  }}
                >
                  <pre className="whitespace-pre-wrap break-words m-0">
                    <code>
                      {renderHighlightedCode(codeContent, codeBlock.lang)}
                    </code>
                  </pre>
                </div>
              </div>
            );
          }
          
          // For regular IncrementalBlock items
          return renderIncrementalBlock(item as IncrementalBlock, i, isThinking, projectId);
        })}
      </div>
    );
  }

  if (!blocks) {
    // Plain text while parseBlocks is deferred — avoids running PATH_REGEX
    // synchronously across all restored messages before the first paint.
    return (
      <p
        className={`${isThinking ? "whitespace-pre-wrap" : "text-pane-text leading-[1.75] whitespace-pre-wrap mb-5"}`}
        style={{ fontSize: isThinking ? "inherit" : "var(--pane-font-size)", maxWidth: "65ch" }}
      >
        {text}
      </p>
    );
  }

  return <>{blocks.map((block, i) => renderBlock(block, i, isThinking, projectId))}</>;
});

// --- Block-level parsing ---

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "paragraph"; content: string };

// Incremental block types for streaming
type IncrementalBlock =
  | { type: "code_start"; lang: string }
  | { type: "code_chunk"; content: string }
  | { type: "code_end" }
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph_chunk"; content: string }
  | { type: "list_item"; content: string; ordered: boolean }
  | { type: "inline"; content: string };


function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code fence
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        content: headingMatch[2]!,
      });
      i++;
      continue;
    }

    // Table — line starts with | and next line is separator (|---|---|)
    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[-:\s|]+\|$/.test(lines[i + 1]!)
    ) {
      const headerCells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = lines[i]!.split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        rows.push(cells);
        i++;
      }
      blocks.push({ type: "table", headers: headerCells, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.startsWith("> ") || lines[i]! === ">")
      ) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", content: quoteLines.join("\n") });
      continue;
    }

    // List (unordered or ordered)
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const lm = lines[i]!.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
        if (!lm) break;
        items.push(lm[3]!);
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        l.startsWith("```") ||
        /^#{1,4}\s/.test(l) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        /^\s*([-*]|\d+\.)\s/.test(l) ||
        /^>\s?/.test(l) ||
        l.startsWith("|")
      ) {
        break;
      }
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", content: paraLines.join("\n") });
    } else {
      // No lines were consumed — the current line matched a paragraph-break
      // condition (e.g. starts with `|` but isn't a valid table) yet wasn't
      // caught by any earlier outer guard. Treat it as a plain text line to
      // prevent an infinite loop.
      blocks.push({ type: "paragraph", content: lines[i]! });
      i++;
    }
  }

  return blocks;
}

// Defers syntax highlighting to after first paint so initial render of restored
// conversations doesn't block the main thread. Code blocks appear as plain text
// first, then get colored after mount. Uses requestIdleCallback so each block
// is spread across idle frames rather than all firing in one effect flush.
export const LazyHighlightedCode = memo(function LazyHighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const [tokens, setTokens] = useState<React.JSX.Element[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cancel = _parseQueue.enqueue(() => {
      if (!cancelled) setTokens(renderHighlightedCode(code, lang));
    });
    return () => { cancelled = true; cancel(); };
  }, [code, lang]);
  if (!tokens) return <>{code}</>;
  return <>{tokens}</>;
});

// --- Block rendering ---

const TOOL_NAMES = "read_file|write_file|replace|run_shell_command|glob|grep_search|google_web_search|TodoWrite|Task|pane_directory|pane_checkpoint|pane_delegate|activate_skill|save_memory|web_fetch|read|write|edit|grep|bash|search|todo|task";
const PATH_REGEX = new RegExp(`(?:^|\\s)((?:(?:\\.?\\.?\\/|~|(?:[\\w.@-]+\\/)+)[\\w.@-]+\\.[a-zA-Z0-9]{1,10}|(?:\\.?\\.?\\/|~|(?:[\\w.@-]+\\/)+)[\\w.@-]+\\/?|[\\w.@-]+\\.[a-zA-Z0-9]{2,10}|${TOOL_NAMES})(?::)?)`, "g");
const SPECIAL_REGEX = new RegExp(`^(?:\\.?\\.?\\/|~|[a-zA-Z]:\\\\|(?:[\\w.@-]+\\/)+)[^\\s]*$|^[\\w.@-]+\\.[a-zA-Z0-9]{1,10}$|^\\.[a-zA-Z][a-zA-Z0-9_.-]*$|^(?:${TOOL_NAMES})(?::)?$`);

function renderBlock(block: Block, key: number, isThinking?: boolean, projectId?: string) {
  switch (block.type) {
    case "code": {
      const trimmedContent = block.content.trim();
      const isSingleLine = !trimmedContent.includes("\n");
      const isSpecial = isSingleLine && SPECIAL_REGEX.test(trimmedContent);

      return (
        <div key={key} className={isThinking ? "my-2" : "my-6"}>
          {block.lang && (
            <div className="flex items-center gap-2 text-[10px] font-mono text-pane-text-secondary/60 mb-2 uppercase tracking-[0.1em]">
              <span className="w-2 h-2 rounded-full bg-pane-terminal/60"></span>
              {block.lang}
            </div>
          )}
          <div
            className="font-mono overflow-x-auto leading-[1.75]"
            style={{ 
              fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)`
            }}
          >
            <pre className="whitespace-pre-wrap break-words m-0">
              <code className={isSpecial ? "text-pane-error" : undefined}>
                {isSpecial ? block.content : <LazyHighlightedCode code={block.content} lang={block.lang} />}
              </code>
            </pre>
          </div>
        </div>
      );
    }

    case "heading": {
      const styles: Record<number, { fontSize: string; className: string }> = {
        1: {
          fontSize: "calc(var(--pane-font-size) + 4px)",
          className: `font-semibold ${isThinking ? "mt-4 mb-2" : "mt-8 mb-4"} tracking-[-0.02em]`,
        },
        2: {
          fontSize: "calc(var(--pane-font-size) + 2px)",
          className: `font-semibold ${isThinking ? "mt-3 mb-1.5" : "mt-7 mb-3"} tracking-[-0.02em]`,
        },
        3: {
          fontSize: "calc(var(--pane-font-size) + 1px)",
          className: `font-medium ${isThinking ? "mt-2 mb-1" : "mt-6 mb-3"} tracking-[-0.01em]`,
        },
        4: {
          fontSize: "var(--pane-font-size)",
          className: `font-medium ${isThinking ? "mt-1.5 mb-1" : "mt-5 mb-2"} uppercase tracking-[0.05em]`,
        },
      };
      const s = styles[block.level] ?? styles[3]!;
      return (
        <div
          key={key}
          className={`${isThinking ? s.className : `text-pane-text ${s.className}`}`}
          style={{ fontSize: isThinking ? "inherit" : s.fontSize }}
        >
          {renderInline(block.content, isThinking, projectId)}
        </div>
      );
    }

    case "hr":
      return (
        <hr
          key={key}
          className={`border-none ${isThinking ? "my-4" : "my-8"}`}
        />
      );

    case "blockquote":
      return (
        <div
          key={key}
          className={`${isThinking ? "my-2" : "my-4"} pl-4`}
        >
          <p
            className={`text-pane-text-secondary leading-[1.75] ${isThinking ? "" : "italic"}`}
            style={{ fontSize: isThinking ? "inherit" : "var(--pane-font-size)" }}
          >
            {renderInline(block.content, isThinking, projectId)}
          </p>
        </div>
      );

    case "table":
      return (
        <div key={key} className={isThinking ? "my-2" : "my-6"} style={{ overflowX: "auto" }}>
          <table
            className="w-full font-mono border-collapse"
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 1px)` }}
          >
            <thead>
              <tr>
                {block.headers.map((h, j) => (
                  <th
                    key={j}
                    className="text-left text-pane-text-secondary/70 font-medium
                               px-3 py-1.5"
                  >
                    {renderInline(h, isThinking)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="text-pane-text/80 px-3 py-1.5"
                    >
                      {renderInline(cell, isThinking)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={`${isThinking ? "my-2" : "my-4"} space-y-1 ${block.ordered ? "list-decimal" : "list-disc"} list-inside`}
        >
          {block.items.map((item, j) => (
            <li
              key={j}
              className={`${isThinking ? "leading-[1.7]" : "text-pane-text leading-[1.7]"}`}
              style={{ fontSize: isThinking ? "inherit" : "var(--pane-font-size)" }}
            >
              {renderInline(item, isThinking)}
            </li>
          ))}
        </Tag>
      );
    }

    case "paragraph":
      return (
        <p
          key={key}
          className={`${isThinking ? "leading-[1.75] mb-2 break-words" : "text-pane-text leading-[1.75] mb-5 break-words"}`}
          style={{ 
            fontSize: isThinking ? "inherit" : "var(--pane-font-size)", 
            maxWidth: "65ch" 
          }}
        >
          {renderInline(block.content, isThinking, projectId)}
        </p>
      );
  }
}

// --- Incremental parsing for streaming ---

function parseIncremental(text: string): IncrementalBlock[] {
  const lines = text.split("\n");
  const blocks: IncrementalBlock[] = [];
  let i = 0;
  let inCodeBlock = false;
  let currentCodeContent: string[] = [];

  // Helper to flush code block if we're in one
  const flushCodeBlock = () => {
    if (inCodeBlock && currentCodeContent.length > 0) {
      blocks.push({
        type: "code_chunk",
        content: currentCodeContent.join("\n"),
      });
      currentCodeContent = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Code fence detection
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch && !inCodeBlock) {
      // Start of code block
      flushCodeBlock();
      inCodeBlock = true;
      const currentCodeLang = fenceMatch[1] ?? "";
      blocks.push({ type: "code_start", lang: currentCodeLang });
      i++;
      continue;
    } else if (line.startsWith("```") && inCodeBlock) {
      // End of code block
      flushCodeBlock();
      inCodeBlock = false;
      blocks.push({ type: "code_end" });
      i++;
      continue;
    }

    if (inCodeBlock) {
      // Inside code block - accumulate lines
      currentCodeContent.push(line);
      i++;
      continue;
    }

    // Heading detection
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      flushCodeBlock();
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        content: headingMatch[2]!,
      });
      i++;
      continue;
    }

    // List item detection
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)/);
    if (listMatch) {
      flushCodeBlock();
      const ordered = /^\d+\./.test(listMatch[2]!);
      blocks.push({
        type: "list_item",
        content: listMatch[3]!,
        ordered,
      });
      i++;
      continue;
    }

    // Regular text - keep lines intact for stable rendering
    flushCodeBlock();
    if (line.trim() !== "") {
      blocks.push({ type: "inline", content: line });
    }
    i++;
  }

  // Flush any remaining code content
  flushCodeBlock();

  return blocks;
}

// --- Incremental block rendering ---

function renderIncrementalBlock(
  block: IncrementalBlock,
  key: number,
  isThinking?: boolean,
  projectId?: string,
) {
  switch (block.type) {
    case "code_start": {
      // For streaming, we need to collect code chunks and render them together
      // This is handled by the group rendering logic above
      return null;
    }

    case "code_chunk":
      // Code chunks are handled by the group rendering logic
      return null;

    case "code_end":
      return null;

    case "heading": {
      const styles: Record<number, { fontSize: string; className: string }> = {
        1: {
          fontSize: "calc(var(--pane-font-size) + 4px)",
          className: `font-semibold ${isThinking ? "mt-4 mb-2" : "mt-8 mb-4"} tracking-[-0.02em]`,
        },
        2: {
          fontSize: "calc(var(--pane-font-size) + 2px)",
          className: `font-semibold ${isThinking ? "mt-3 mb-1.5" : "mt-7 mb-3"} tracking-[-0.02em]`,
        },
        3: {
          fontSize: "calc(var(--pane-font-size) + 1px)",
          className: `font-medium ${isThinking ? "mt-2 mb-1" : "mt-6 mb-3"} tracking-[-0.01em]`,
        },
        4: {
          fontSize: "var(--pane-font-size)",
          className: `font-medium ${isThinking ? "mt-1.5 mb-1" : "mt-5 mb-2"} uppercase tracking-[0.05em]`,
        },
      };
      const s = styles[block.level] ?? styles[3]!;
      return (
        <div
          key={key}
          className={`${isThinking ? s.className : `text-pane-text ${s.className}`}`}
          style={{ fontSize: isThinking ? "inherit" : s.fontSize }}
        >
          {renderInline(block.content, isThinking, projectId)}
        </div>
      );
    }

    case "list_item":
      return (
        <li
          key={key}
          className={`${isThinking ? "leading-[1.7] my-1" : "text-pane-text leading-[1.7] my-1"}`}
          style={{ fontSize: isThinking ? "inherit" : "var(--pane-font-size)" }}
        >
          {renderInline(block.content, isThinking, projectId)}
        </li>
      );

    case "paragraph_chunk":
    case "inline":
      return (
        <span
          key={key}
          className={`${isThinking ? "leading-[1.75] whitespace-pre-wrap break-words" : "text-pane-text leading-[1.75] whitespace-pre-wrap break-words"}`}
          style={{ fontSize: isThinking ? "inherit" : "var(--pane-font-size)" }}
        >
          {renderInline(block.content, isThinking, projectId)}
        </span>
      );
  }
}

// --- Inline parsing ---

export function renderInline(text: string, isThinking?: boolean, projectId?: string): (string | React.JSX.Element)[] {
  const cleaned = stripEmojis(text);
  const parts: (string | React.JSX.Element)[] = [];
  // Match: @mind:id, [link](url), `code`, 'single-quoted', **bold**, *italic*, [@thought]
  const regex = /(@mind:[^\s]+|\[[^\]]+\]\([^)]+\)|`[^`]+`|'[^\s'][^\s']*'|\*\*[^*]+\*\*|\*[^*]+\*|\[@thought\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const renderTextWithPaths = (txt: string, startIndex: number) => {
    let txtIdx = 0;
    let pMatch: RegExpExecArray | null;
    const result: (string | React.JSX.Element)[] = [];

    // Reset regex state since it's global
    PATH_REGEX.lastIndex = 0;

    while ((pMatch = PATH_REGEX.exec(txt)) !== null) {
      const matchFull = pMatch[0];
      const matchPath = pMatch[1]!;
      const matchStart = pMatch.index + (matchFull.indexOf(matchPath));

      if (matchStart > txtIdx) {
        result.push(txt.slice(txtIdx, matchStart));
      }
      // Strip trailing colon from paths like "src/foo.ts:" (tool output formatting)
      const cleanPath = matchPath.replace(/:$/, "");
      result.push(
        projectId ? (
          <button
            key={`path-${startIndex}-${matchStart}`}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("pane:open-path", { detail: { path: cleanPath, projectId } }),
              )
            }
            className="font-mono text-pane-error hover:opacity-70 hover:underline cursor-pointer transition-opacity"
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)` }}
          >
            {cleanPath}
          </button>
        ) : (
          <code
            key={`path-${startIndex}-${matchStart}`}
            className="font-mono text-pane-error"
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)` }}
          >
            {cleanPath}
          </code>
        )
      );
      txtIdx = matchStart + matchPath.length;
    }
    if (txtIdx < txt.length) {
      result.push(txt.slice(txtIdx));
    }
    return result;
  };

  while ((match = regex.exec(cleaned)) !== null) {
    // Push preceding text with path detection
    if (match.index > lastIndex) {
      parts.push(...renderTextWithPaths(cleaned.slice(lastIndex, match.index), lastIndex));
    }

    const token = match[0];
    const key = `inline-${match.index}`;
    const fontMono = "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'Fira Code', Consolas, monospace";

    if (token.startsWith("@mind:")) {
      parts.push(
        <span
          key={key}
          style={{
            color: "var(--pane-status-modified)",
            fontFamily: fontMono,
            fontWeight: 500,
          }}
        >
          thought
        </span>
      );
    } else if (token === "[@thought]") {
      parts.push(
        <span
          key={key}
          style={{
            color: "var(--pane-status-modified)",
            fontFamily: fontMono,
            fontWeight: 500,
            textTransform: "lowercase",
          }}
        >
          @thought
        </span>
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pane-terminal hover:text-pane-terminal/80
                       underline underline-offset-2
                       decoration-pane-terminal/30 hover:decoration-pane-terminal/60"
          >
            {linkMatch[1]}
          </a>,
        );
      }
    } else if (token.startsWith("`")) {
      const codeContent = token.slice(1, -1);
      const trimmed = codeContent.trim();
      const isSpecial = SPECIAL_REGEX.test(trimmed);

      if (isSpecial) {
        parts.push(
          <code
            key={key}
            className="font-mono text-pane-error"
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)` }}
          >
            {codeContent}
          </code>,
        );
      } else {
        parts.push(
          <code
            key={key}
            className={`font-mono px-1.5 py-0.5 ${isThinking ? "" : "text-pane-text/80"} rounded-sm`}
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)` }}
          >
            {codeContent}
          </code>,
        );
      }
    } else if (token.startsWith("'") && token.endsWith("'")) {
      const innerContent = token.slice(1, -1);
      const isSpecial = SPECIAL_REGEX.test(innerContent.trim());
      if (isSpecial) {
        parts.push(
          <code
            key={key}
            className="font-mono text-pane-error"
            style={{ fontSize: `calc(${isThinking ? "inherit" : "var(--pane-font-size)"} - 2px)` }}
          >
            {innerContent}
          </code>,
        );
      } else {
        // Not a filename — preserve as plain text with quotes intact
        parts.push(token);
      }
    } else if (token.startsWith("**")) {
      parts.push(
        <strong key={key} className={`font-semibold ${isThinking ? "" : "text-pane-text"}`}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      parts.push(
        <em 
          key={key} 
          className={`${isThinking ? "" : "italic"} ${isThinking ? "" : "text-pane-text/80"}`}
          style={{ fontStyle: isThinking ? "normal" : "italic" }}
        >
          {token.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = match.index + token.length;
  }

  // Remaining text with path detection
  if (lastIndex < cleaned.length) {
    parts.push(...renderTextWithPaths(cleaned.slice(lastIndex), lastIndex));
  }

  return parts;
}
