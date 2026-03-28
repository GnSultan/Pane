import { useEffect, useRef, useState } from "react";
import type { MindEntry } from "../../lib/tauri-commands";

interface SlashMenuProps {
  entries: MindEntry[];
  query: string; // text typed after the leading /
  onSelect: (content: string) => void;
  onDismiss: () => void;
}

function scoreEntry(entry: MindEntry, q: string): number {
  if (!q) return 0;
  const text = entry.content.toLowerCase();
  const lower = q.toLowerCase();
  if (text.startsWith(lower)) return 100;
  if (text.includes(lower)) return 50;
  // fuzzy: all chars present in order
  let idx = 0;
  for (const ch of text) {
    if (ch === lower[idx]) idx++;
    if (idx === lower.length) return 10;
  }
  return -1;
}

export function SlashMenu({ entries, query, onSelect, onDismiss }: SlashMenuProps) {
  const [activeIdx, setActiveIdx] = useState(0);

  const filtered = entries
    .map((e) => ({ entry: e, score: scoreEntry(e, query) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ entry }) => entry);

  // Reset selection when filtered results change
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Keyboard handler — attached to window so it intercepts before the textarea
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = filtered[activeIdx];
        if (item) onSelect(item.content);
        return;
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [filtered, activeIdx, onSelect, onDismiss]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 z-50
                 bg-pane-bg ring-1 ring-pane-border/40 rounded-xl
                 overflow-hidden animate-fadeSlideUp"
    >
      <div className="max-h-[240px] overflow-y-auto">
        {filtered.map((entry, i) => (
          <button
            key={entry.id}
            ref={i === activeIdx ? activeRef : undefined}
            onClick={() => onSelect(entry.content)}
            onMouseEnter={() => setActiveIdx(i)}
            className={`w-full text-left px-4 py-2.5 font-mono truncate transition-colors
              ${i === activeIdx
                ? "bg-pane-text/[0.06] text-pane-text"
                : "text-pane-text-secondary hover:bg-pane-text/[0.03]"
              }`}
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {entry.content.length > 100
              ? entry.content.slice(0, 100) + "…"
              : entry.content}
          </button>
        ))}
      </div>
      <div
        className="px-4 py-2 border-t border-pane-border/20 text-pane-text-secondary/40 font-mono"
        style={{ fontSize: "10px" }}
      >
        ↑↓ navigate · enter/tab select · esc dismiss
      </div>
    </div>
  );
}
