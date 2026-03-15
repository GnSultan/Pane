import { memo, useMemo } from "react";
import type React from "react";

/**
 * Lightweight markdown renderer — zero dependencies.
 * Handles code fences, inline code, bold, italic, links, headings,
 * blockquotes, tables, lists, and horizontal rules.
 * Anything unrecognized renders as literal text.
 *
 * All sizes scale with --pane-font-size CSS variable (Cmd+/- adjustable).
 */

// --- Emoji stripping ---

const emojiPattern =
  // eslint-disable-next-line no-misleading-character-class -- intentional Unicode range for emoji stripping
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function stripEmojis(text: string): string {
  return text.replace(emojiPattern, "").replace(/  +/g, " ");
}

interface MarkdownTextProps {
  text: string;
  isStreaming?: boolean;
}

export const MarkdownText = memo(function MarkdownText({
  text,
  isStreaming,
}: MarkdownTextProps) {
  // During streaming, we use incremental parsing to provide rich formatting
  // without the performance cost of full document parsing on every frame.
  // We parse inline formatting (bold, code, links) and detect simple block
  // boundaries for a better streaming experience.
  const shouldParseMarkdown = !isStreaming && text.length <= 30_000;
  const shouldParseIncremental = isStreaming;

  const blocks = useMemo(
    () => (shouldParseMarkdown ? parseBlocks(text) : null),
    [text, shouldParseMarkdown],
  );

  const incrementalBlocks = useMemo(
    () => (shouldParseIncremental ? parseIncremental(text) : null),
    [text, shouldParseIncremental],
  );

  if (incrementalBlocks) {
    return (
      <div className="space-y-4">
        {incrementalBlocks.map((block, i) => renderIncrementalBlock(block, i))}
      </div>
    );
  }

  if (!blocks) {
    return (
      <p
        className="text-pane-text leading-[1.75] whitespace-pre-wrap mb-5"
        style={{
          fontSize: "var(--pane-font-size)",
          maxWidth: "65ch",
        }}
      >
        {renderInline(text)}
      </p>
    );
  }

  return <>{blocks.map((block, i) => renderBlock(block, i))}</>;
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
    }
  }

  return blocks;
}

// --- Block rendering ---

const TOOL_NAMES = "read_file|write_file|replace|run_shell_command|glob|grep_search|google_web_search|TodoWrite|Task|list_directory|activate_skill|save_memory|web_fetch|codebase_investigator|cli_help|generalist|read|write|edit|grep|bash|search|todo|task|Claude CLI|Gemini CLI";
const PATH_REGEX = new RegExp(`(?:^|\\s)((?:(?:\\.?\\.?\\/|~|(?:[\\w.@-]+\\/)+)[\\w.@-]+\\.[a-zA-Z0-9]{1,10}|(?:\\.?\\.?\\/|~|(?:[\\w.@-]+\\/)+)[\\w.@-]+\\/?|${TOOL_NAMES})(?::)?)`, "g");
const SPECIAL_REGEX = new RegExp(`^(?:\\.?\\.?\\/|~|[a-zA-Z]:\\\\|(?:[\\w.@-]+\\/)+)[^\\s]*$|^[\\w.@-]+\\.[a-zA-Z0-9]{1,10}$|^(?:${TOOL_NAMES})(?::)?$`);

function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case "code": {
      const trimmedContent = block.content.trim();
      const isSingleLine = !trimmedContent.includes("\n");
      const isSpecial = isSingleLine && SPECIAL_REGEX.test(trimmedContent);

      return (
        <div key={key} className="my-6">
          {block.lang && (
            <div className="text-[10px] font-mono text-pane-text-secondary/40 mb-2 uppercase tracking-[0.1em]">
              {block.lang}
            </div>
          )}
          <pre
            className={`font-mono overflow-x-auto leading-[1.75] px-5 py-4 rounded-sm ${
              isSpecial 
                ? "text-pane-error" 
                : "text-pane-text/85"
            }`}
            style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {block.content}
          </pre>
        </div>
      );
    }

    case "heading": {
      const styles: Record<number, { fontSize: string; className: string }> = {
        1: {
          fontSize: "calc(var(--pane-font-size) + 4px)",
          className: "font-semibold mt-8 mb-4 tracking-[-0.02em]",
        },
        2: {
          fontSize: "calc(var(--pane-font-size) + 2px)",
          className: "font-semibold mt-7 mb-3 tracking-[-0.02em]",
        },
        3: {
          fontSize: "calc(var(--pane-font-size) + 1px)",
          className: "font-medium mt-6 mb-3 tracking-[-0.01em]",
        },
        4: {
          fontSize: "var(--pane-font-size)",
          className: "font-medium mt-5 mb-2 uppercase tracking-[0.05em]",
        },
      };
      const s = styles[block.level] ?? styles[3]!;
      return (
        <div
          key={key}
          className={`text-pane-text ${s.className}`}
          style={{ fontSize: s.fontSize }}
        >
          {renderInline(block.content)}
        </div>
      );
    }

    case "hr":
      return (
        <hr
          key={key}
          className="border-none my-8"
        />
      );

    case "blockquote":
      return (
        <div
          key={key}
          className="my-4 pl-4"
        >
          <p
            className="text-pane-text-secondary leading-[1.75] italic"
            style={{ fontSize: "var(--pane-font-size)" }}
          >
            {renderInline(block.content)}
          </p>
        </div>
      );

    case "table":
      return (
        <div key={key} className="my-6 overflow-x-auto">
          <table
            className="w-full font-mono border-collapse"
            style={{ fontSize: "calc(var(--pane-font-size) - 1px)" }}
          >
            <thead>
              <tr>
                {block.headers.map((h, j) => (
                  <th
                    key={j}
                    className="text-left text-pane-text-secondary/70 font-medium
                               px-3 py-1.5"
                  >
                    {renderInline(h)}
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
                      {renderInline(cell)}
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
          className={`my-4 space-y-2 ${block.ordered ? "list-decimal" : "list-disc"} list-inside`}
        >
          {block.items.map((item, j) => (
            <li
              key={j}
              className="text-pane-text leading-[1.7]"
              style={{ fontSize: "var(--pane-font-size)" }}
            >
              {renderInline(item)}
            </li>
          ))}
        </Tag>
      );
    }

    case "paragraph":
      return (
        <p
          key={key}
          className="text-pane-text leading-[1.75] mb-5 break-words"
          style={{ fontSize: "var(--pane-font-size)", maxWidth: "65ch" }}
        >
          {renderInline(block.content)}
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

    // Regular text - break into chunks for better streaming
    flushCodeBlock();
    if (line.trim() !== "") {
      // Break long lines into smaller chunks for smoother streaming
      const maxChunkLength = 200;
      if (line.length > maxChunkLength) {
        for (let j = 0; j < line.length; j += maxChunkLength) {
          const chunk = line.slice(j, j + maxChunkLength);
          blocks.push({ type: "inline", content: chunk });
        }
      } else {
        blocks.push({ type: "inline", content: line });
      }
    }
    i++;
  }

  // Flush any remaining code content
  flushCodeBlock();

  return blocks;
}

// --- Incremental block rendering ---

function renderIncrementalBlock(block: IncrementalBlock, key: number) {
  switch (block.type) {
    case "code_start":
      return (
        <div key={key} className="my-4">
          {block.lang && (
            <div className="text-[10px] font-mono text-pane-text-secondary/40 mb-2 uppercase tracking-[0.1em]">
              {block.lang}
            </div>
          )}
          <pre
            className="font-mono text-pane-text/85
                        px-5 py-4 overflow-x-auto leading-[1.75] rounded-sm"
            style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {/* Content will be added by code_chunk blocks */}
          </pre>
        </div>
      );

    case "code_chunk":
      return (
        <code key={key} className="font-mono text-pane-text/85 whitespace-pre">
          {block.content}
          {block.content.endsWith("\n") ? "" : "\n"}
        </code>
      );

    case "code_end":
      return null; // Already handled by code_start structure

    case "heading": {
      const styles: Record<number, { fontSize: string; className: string }> = {
        1: {
          fontSize: "calc(var(--pane-font-size) + 4px)",
          className: "font-semibold mt-8 mb-4 tracking-[-0.02em]",
        },
        2: {
          fontSize: "calc(var(--pane-font-size) + 2px)",
          className: "font-semibold mt-7 mb-3 tracking-[-0.02em]",
        },
        3: {
          fontSize: "calc(var(--pane-font-size) + 1px)",
          className: "font-medium mt-6 mb-3 tracking-[-0.01em]",
        },
        4: {
          fontSize: "var(--pane-font-size)",
          className: "font-medium mt-5 mb-2 uppercase tracking-[0.05em]",
        },
      };
      const s = styles[block.level] ?? styles[3]!;
      return (
        <div
          key={key}
          className={`text-pane-text ${s.className}`}
          style={{ fontSize: s.fontSize }}
        >
          {renderInline(block.content)}
        </div>
      );
    }

    case "list_item":
      return (
        <li
          key={key}
          className="text-pane-text leading-[1.7] my-1"
          style={{ fontSize: "var(--pane-font-size)" }}
        >
          {renderInline(block.content)}
        </li>
      );

    case "paragraph_chunk":
    case "inline":
      return (
        <span
          key={key}
          className="text-pane-text leading-[1.75] whitespace-pre-wrap break-words animate-fadeIn"
          style={{ fontSize: "var(--pane-font-size)" }}
        >
          {renderInline(block.content)}
        </span>
      );
  }
}

// --- Inline parsing ---

function renderInline(text: string): (string | React.JSX.Element)[] {
  const cleaned = stripEmojis(text);
  const parts: (string | React.JSX.Element)[] = [];
  // Match: [link](url), `code`, **bold**, *italic*
  const regex = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
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
      result.push(
        <code
          key={`path-${startIndex}-${matchStart}`}
          className="font-mono text-pane-error"
          style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
        >
          {matchPath}
        </code>
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

    if (token.startsWith("[")) {
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
            style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {codeContent}
          </code>,
        );
      } else {
        parts.push(
          <code
            key={key}
            className="font-mono px-1.5 py-0.5 text-pane-text/80 rounded-sm"
            style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {codeContent}
          </code>,
        );
      }
    }
 else if (token.startsWith("**")) {
      parts.push(
        <strong key={key} className="font-semibold text-pane-text">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      parts.push(
        <em key={key} className="italic text-pane-text/80">
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
