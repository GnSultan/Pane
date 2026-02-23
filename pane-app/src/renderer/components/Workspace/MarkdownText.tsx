import type React from "react";

/**
 * Lightweight markdown renderer — zero dependencies.
 * Handles code fences, inline code, bold, italic, headings, lists, and horizontal rules.
 * Anything unrecognized renders as literal text.
 *
 * All sizes scale with --pane-font-size CSS variable (Cmd+/- adjustable).
 */

interface MarkdownTextProps {
  text: string;
}

export function MarkdownText({ text }: MarkdownTextProps) {
  const blocks = parseBlocks(text);
  return <>{blocks.map((block, i) => renderBlock(block, i))}</>;
}

// --- Block-level parsing ---

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; content: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
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
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // List (unordered or ordered)
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
        if (!lm) break;
        items.push(lm[3]);
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
      const l = lines[i];
      if (
        l.trim() === "" ||
        l.startsWith("```") ||
        /^#{1,4}\s/.test(l) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        /^\s*([-*]|\d+\.)\s/.test(l)
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

function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case "code":
      return (
        <div key={key} className="my-6">
          {block.lang && (
            <div className="text-[10px] font-mono text-pane-text-secondary/40 mb-2 uppercase tracking-[0.1em]">
              {block.lang}
            </div>
          )}
          <pre
            className="font-mono text-pane-text/85 bg-pane-bg
                        border border-pane-border/60 px-5 py-4
                        overflow-x-auto leading-[1.75]"
            style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
          >
            {block.content}
          </pre>
        </div>
      );

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
      const s = styles[block.level] || styles[3];
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
          className="border-none border-t border-pane-border/30 my-8"
        />
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
          className="text-pane-text leading-[1.75] mb-5"
          style={{ fontSize: "var(--pane-font-size)", maxWidth: "65ch" }}
        >
          {renderInline(block.content)}
        </p>
      );
  }
}

// --- Emoji stripping ---

const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+/gu;

function stripEmojis(text: string): string {
  return text.replace(emojiPattern, "").replace(/  +/g, " ").trim();
}

// --- Inline parsing ---

function renderInline(text: string): (string | React.JSX.Element)[] {
  const cleaned = stripEmojis(text);
  const parts: (string | React.JSX.Element)[] = [];
  // Match: `code`, **bold**, *italic*
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cleaned)) !== null) {
    // Push preceding text
    if (match.index > lastIndex) {
      parts.push(cleaned.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `inline-${match.index}`;

    if (token.startsWith("`")) {
      parts.push(
        <code
          key={key}
          className="font-mono bg-pane-bg border border-pane-border/60
                     px-1.5 py-0.5 text-pane-text/80"
          style={{ fontSize: "calc(var(--pane-font-size) - 2px)" }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
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

  // Remaining text
  if (lastIndex < cleaned.length) {
    parts.push(cleaned.slice(lastIndex));
  }

  return parts;
}
