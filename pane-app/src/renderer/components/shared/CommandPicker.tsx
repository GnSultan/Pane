import { useEffect, useMemo, useRef, useState } from "react";
import { brainMindGetAll, type MindEntry } from "../../lib/tauri-commands";
import {
  matchCommands,
  type AtCommand,
  type AtActionCommand,
  type AtSubcommand,
} from "../../lib/at-commands";

// ─── What a selected command resolves to ────────────────────────────────────

export type CommandSelection =
  | { kind: "reference"; label: string; content: string }
  | { kind: "mode";      command: AtCommand & { type: "mode" } }
  | { kind: "action";    command: AtActionCommand; subcommand: AtSubcommand };

// ─── Picker item type ────────────────────────────────────────────────────────

type PickerItem =
  | { kind: "command"; cmd: AtCommand }
  | { kind: "mind";    label: string; content: string }
  | { kind: "sub";     parent: AtActionCommand; sub: AtSubcommand };

// ─── Pure helpers (no hooks) ─────────────────────────────────────────────────

function typeLabel(item: PickerItem): string {
  if (item.kind === "mind") return "thought";
  if (item.kind === "sub") return item.parent.name;
  if (item.cmd.type === "mode") return "mode";
  if (item.cmd.type === "action") return "action";
  return "ref";
}

function typeColor(item: PickerItem): string {
  if (item.kind === "mind") return "var(--pane-status-modified)";
  if (item.kind === "sub") return "var(--pane-text-secondary)";
  if (item.kind === "command" && item.cmd.type === "mode") {
    return (item.cmd as Extract<AtCommand, { type: "mode" }>).color;
  }
  return "var(--pane-text-secondary)";
}

function isActiveMode(item: PickerItem, activeMode: string | null): boolean {
  if (item.kind !== "command" || item.cmd.type !== "mode") return false;
  return (item.cmd as Extract<AtCommand, { type: "mode" }>).mode === activeMode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CommandPicker({
  query,
  activeMode,
  onSelect,
  onDismiss,
}: {
  query: string;
  activeMode: string | null;
  onSelect: (sel: CommandSelection) => void;
  onDismiss: () => void;
}) {
  const [highlighted, setHighlighted] = useState(0);
  const [subcommandOf, setSubcommandOf] = useState<AtActionCommand | null>(null);
  const [mindEntries, setMindEntries] = useState<MindEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Load mind entries for @thought reference
  useEffect(() => {
    brainMindGetAll()
      .then((r) => setMindEntries(r.entries ?? []))
      .catch(() => {});
  }, []);

  // Reset highlight when list changes
  useEffect(() => { setHighlighted(0); }, [query, subcommandOf]);

  // ── Build item list ────────────────────────────────────────────────────

  const items = useMemo<PickerItem[]>(() => {
    // Subcommand mode: show subcommands of the selected action
    if (subcommandOf) {
      const subs = subcommandOf.subcommands ?? [];
      const q = query.toLowerCase();
      return subs
        .filter((s) => !q || s.name.startsWith(q))
        .map((sub) => ({ kind: "sub" as const, parent: subcommandOf, sub }));
    }

    // @thought namespace: show mind entries filtered by query
    const matchedCmds = matchCommands(query);
    const thoughtCmd = matchedCmds.find((c) => c.name === "thought");
    const nonThought = matchedCmds.filter((c) => c.name !== "thought");

    const rows: PickerItem[] = [];

    // Mind entries shown when "thought" is the only or first match
    if (thoughtCmd && (query.toLowerCase().startsWith("t") || query === "")) {
      const q = query.length > 7 ? query.slice(7) : ""; // after "thought"
      const mindRows = mindEntries
        .filter((m) => !q || m.content.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
        .map((m) => ({ kind: "mind" as const, label: m.id, content: m.content }));
      rows.push(...mindRows);
    }

    // Top-level commands
    for (const cmd of nonThought) {
      rows.push({ kind: "command" as const, cmd });
    }
    // Include @thought command row only when no mind entries were added
    if (thoughtCmd && !rows.some((r) => r.kind === "mind")) {
      rows.push({ kind: "command" as const, cmd: thoughtCmd });
    }

    return rows;
  }, [query, subcommandOf, mindEntries]);

  // ── Keyboard navigation ────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setHighlighted((h) => Math.min(h + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setHighlighted((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault(); e.stopPropagation();
        selectItem(items[highlighted]);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (subcommandOf) { setSubcommandOf(null); } else { onDismiss(); }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [items, highlighted, subcommandOf, onDismiss]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // Outside click dismiss
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss]);

  // ── Selection logic ────────────────────────────────────────────────────

  function selectItem(item: PickerItem | undefined) {
    if (!item) return;

    if (item.kind === "mind") {
      onSelect({ kind: "reference", label: item.label, content: item.content });
      return;
    }

    if (item.kind === "sub") {
      onSelect({ kind: "action", command: item.parent, subcommand: item.sub });
      return;
    }

    // Top-level command
    const cmd = item.cmd;
    if (cmd.type === "reference") {
      // @thought — open mind sub-list; if there are entries show them, otherwise dismiss
      // The parent InputBar handles @thought differently — just signal reference intent
      onSelect({ kind: "reference", label: "", content: "" });
      return;
    }
    if (cmd.type === "mode") {
      onSelect({ kind: "mode", command: cmd as AtCommand & { type: "mode" } });
      return;
    }
    if (cmd.type === "action") {
      const actionCmd = cmd as AtActionCommand;
      if (actionCmd.subcommands?.length) {
        setSubcommandOf(actionCmd);
        return; // keep picker open in subcommand mode
      }
      // Action with no subcommands — shouldn't happen but handle gracefully
      onDismiss();
    }
  }

  if (!items.length) return null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 z-50
                 bg-pane-bg/80 backdrop-blur-md ring-1 ring-pane-border/40 rounded-xl
                 overflow-hidden animate-fadeSlideUp"
    >
      {subcommandOf && (
        <div
          className="px-4 pt-2.5 pb-1.5 font-mono text-pane-text-secondary/50"
          style={{ fontSize: "10px" }}
        >
          @{subcommandOf.name} ·
        </div>
      )}
      <div className="max-h-[280px] overflow-y-auto p-1.5">
        {items.map((item, idx) => {
          const key = item.kind === "mind"
            ? `mind:${item.label}`
            : item.kind === "sub"
            ? `sub:${item.parent.name}:${item.sub.name}`
            : `cmd:${item.cmd.name}`;

          const label = item.kind === "mind"
            ? item.content
            : item.kind === "sub"
            ? item.sub.name
            : `@${item.cmd.name}`;

          const desc = item.kind === "mind"
            ? null
            : item.kind === "sub"
            ? item.sub.description
            : item.cmd.description;

          const active = isActiveMode(item, activeMode);

          return (
            <button
              key={key}
              ref={idx === highlighted ? activeRef : undefined}
              onClick={() => selectItem(item)}
              onMouseEnter={() => setHighlighted(idx)}
              className={`w-full text-left px-3 py-2 rounded-md transition-colors flex items-start gap-3
                ${idx === highlighted
                  ? "bg-pane-text/[0.08] text-pane-text"
                  : "text-pane-text-secondary hover:bg-pane-text/[0.03]"
                }`}
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {/* Type dot */}
              <span
                className="shrink-0 mt-[3px]"
                style={{ color: typeColor(item), fontSize: "8px", lineHeight: 1 }}
              >
                ●
              </span>

              {/* Label + description */}
              <span className="flex-1 min-w-0">
                <span className="font-mono font-medium">
                  {label}
                  {active && (
                    <span className="ml-2 opacity-50" style={{ fontSize: "10px" }}>✓ active</span>
                  )}
                </span>
                {desc && (
                  <span
                    className="block text-pane-text-secondary/60 font-mono truncate"
                    style={{ fontSize: "10px", marginTop: "1px" }}
                  >
                    {desc}
                  </span>
                )}
              </span>

              {/* Right label */}
              {item.kind !== "mind" && (
                <span
                  className="shrink-0 font-mono text-pane-text-secondary/30"
                  style={{ fontSize: "9px", marginTop: "3px" }}
                >
                  {typeLabel(item)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        className="px-4 py-2 border-t border-pane-border/20 text-pane-text-secondary/40 font-mono"
        style={{ fontSize: "10px" }}
      >
        ↑↓ navigate · enter select · esc {subcommandOf ? "back" : "dismiss"}
      </div>
    </div>
  );
}
