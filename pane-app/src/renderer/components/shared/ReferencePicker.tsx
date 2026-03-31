import { useEffect, useRef, useState } from "react";
import { brainMindGetAll, type MindEntry } from "../../lib/tauri-commands";

export interface ReferenceItem {
  namespace: string;
  label: string;
  description?: string;
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

  // Build items: minds first, then session/todo actions
  const items = (() => {
    const q = query.toLowerCase().trim();

    const mindItems: ReferenceItem[] = mindEntries
      .filter((m) => {
        if (!q) return true;
        return m.id.toLowerCase().includes(q) || m.content.toLowerCase().includes(q);
      })
      .map((m) => ({
        namespace: "mind",
        label: m.id || m.content.slice(0, 30),
        description: m.content.slice(0, 80),
      }));

    const actionItems: ReferenceItem[] = [
      { namespace: "session", label: "clear", description: "Wipe session context" },
      { namespace: "session", label: "compact", description: "Compress session context" },
      { namespace: "todo", label: "clear-completed", description: "Remove finished tasks" },
    ].filter((a) => !q || a.label.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q)));

    return [...mindItems, ...actionItems];
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
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onSelect(items[highlighted]);
      } else if (e.key === "Escape") {
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [items, highlighted, onSelect, onDismiss]);

  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-idx="${highlighted}"]`);
    el?.scrollIntoView({ block: "nearest" });
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

  const namespaceColor = (ns: string) => {
    switch (ns) {
      case "mind": return "text-emerald-400";
      case "session": return "text-violet-400";
      case "todo": return "text-amber-400";
      default: return "text-slate-400";
    }
  };

  const namespaceIcon = (ns: string) => {
    switch (ns) {
      case "mind":
        return (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
        );
      case "session":
        return (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 18V6" />
          </svg>
        );
      case "todo":
        return (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 11l3 3 8-8" />
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-2 mb-2 z-50 w-[340px] min-h-[64px] max-h-[280px] overflow-auto rounded-xl border border-slate-700/60 bg-[#131417] shadow-[0_8px_30px_rgba(0,0,0,0.35)] py-0.5"
    >
      <div className="px-3 pt-2 pb-1.5">
        <div className="text-xs font-semibold text-slate-100">
          References
          {query && <span className="text-slate-400 font-normal ml-1">"{query}"</span>}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">Pick a reference to attach</div>
      </div>

      <div className="border-t border-slate-700/50" />

      {items.map((item, idx) => (
        <div
          key={`${item.namespace}:${item.label}:${idx}`}
          data-idx={idx}
          role="option"
          aria-selected={highlighted === idx}
          onMouseMove={() => setHighlighted(idx)}
          onClick={() => onSelect(item)}
          className={`px-3 py-2 cursor-pointer transition-[background] ${highlighted === idx ? "bg-violet-500/15" : "hover:bg-slate-700/20"}`}
        >
          <div className="text-sm text-slate-100 flex items-center gap-2">
            <span className={namespaceColor(item.namespace)}>
              {namespaceIcon(item.namespace)}
            </span>
            @{item.namespace}:{item.label}
          </div>
          {item.description && (
            <div className="text-xs text-slate-400 mt-0.5 ml-6 line-clamp-1">
              {item.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
