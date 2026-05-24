import { useEffect, useRef, useState } from "react";
import { brainMindGetAll, type MindEntry } from "../../lib/tauri-commands";

export interface ReferenceItem {
  namespace: string;
  label: string;
  content: string;
}

function scoreItem(text: string, q: string): number {
  if (!q) return 0;
  const lower = q.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(lower)) return 100;
  if (t.includes(lower)) return 50;
  let idx = 0;
  for (const ch of t) {
    if (ch === lower[idx]) idx++;
    if (idx === lower.length) return 10;
  }
  return -1;
}

export default function ReferencePicker({
  query,
  onSelect,
  onDismiss,
}: {
  query: string;
  onSelect: (item: ReferenceItem) => void;
  onDismiss: () => void;
}) {
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mindEntries, setMindEntries] = useState<MindEntry[]>([]);

  useEffect(() => {
    brainMindGetAll()
      .then((r) => setMindEntries(r.entries ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  const items = (() => {
    const q = query.toLowerCase().trim();

    return mindEntries
      .map((m) => ({
        namespace: "mind" as const,
        label: m.id,
        content: m.content,
        score: scoreItem(m.content, q),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ namespace, label, content }) => ({ namespace, label, content }));
  })();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlighted((h) => Math.min(h + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlighted((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const item = items[highlighted];
        if (item) onSelect(item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [items, highlighted, onSelect, onDismiss]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss]);

  if (!items.length) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 z-50
                 bg-pane-bg ring-1 ring-pane-border/40 rounded-xl
                 overflow-hidden animate-fadeSlideUp"
    >
      <div className="max-h-[240px] overflow-y-auto p-1.5">
        {items.map((item, idx) => (
          <button
            key={`${item.namespace}:${item.label}`}
            ref={idx === highlighted ? activeRef : undefined}
            onClick={() => onSelect(item)}
            onMouseEnter={() => setHighlighted(idx)}
            className={`w-full text-left px-3 py-2 font-mono line-clamp-2 rounded-md transition-colors
              ${idx === highlighted
                ? "bg-pane-text/[0.08] text-pane-text"
                : "text-pane-text-secondary hover:bg-pane-text/[0.03]"
              }`}
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {item.content}
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
