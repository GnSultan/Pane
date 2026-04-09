import { useState, useEffect, useRef, useCallback } from "react";
import {
  brainMindAdd,
  brainMindGetAll,
  brainMindDelete,
  brainMindUpdate,
  type MindEntry,
} from "../../lib/tauri-commands";
import { useProjectsStore } from "../../stores/projects";
import { useMindStore } from "../../stores/mind";
import { measureCaretPos } from "../../lib/measure-caret";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ─── Entry Item ───────────────────────────────────────────────────────────────

function EntryItem({
  entry,
  isEditing,
  hasUnread,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleComplete,
  onDelete,
}: {
  entry: MindEntry;
  isEditing: boolean;
  hasUnread?: boolean;
  onStartEdit: () => void;
  onSaveEdit: (content: string) => void;
  onCancelEdit: () => void;
  onToggleComplete: () => void;
  onDelete: () => void;
}) {
  const [editValue, setEditValue] = useState(entry.content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const caretContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [caretPos, setCaretPos] = useState<{
    top: number;
    left: number;
    lineHeight: number;
  } | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLong =
    entry.content.length > 280 || entry.content.split("\n").length > 4;
  const displayedContent =
    isLong && !expanded ? entry.content.slice(0, 280) + "..." : entry.content;

  const updateCaret = useCallback(() => {
    const el = editRef.current;
    const container = caretContainerRef.current;
    const overlay = overlayRef.current;
    if (!el || !container || !overlay || document.activeElement !== el) {
      setCaretPos(null);
      return;
    }
    setCaretPos(measureCaretPos(el, container, overlay));
  }, []);

  useEffect(() => {
    if (textareaFocused) updateCaret();
  }, [editValue, textareaFocused, updateCaret]);

  useEffect(() => {
    if (!isEditing) return;
    const el = editRef.current;
    if (!el) return;
    const events = ["click", "keyup", "mouseup", "select", "scroll"];
    events.forEach((e) => el.addEventListener(e, updateCaret));
    return () => events.forEach((e) => el.removeEventListener(e, updateCaret));
  }, [isEditing, updateCaret]);

  useEffect(() => {
    if (!isEditing) return;
    setEditValue(entry.content);
    setTimeout(() => {
      if (!editRef.current) return;
      editRef.current.focus();
      const len = editRef.current.value.length;
      editRef.current.setSelectionRange(len, len);
      editRef.current.style.height = "auto";
      editRef.current.style.height = `${editRef.current.scrollHeight}px`;
    }, 0);
  }, [isEditing, entry.content]);

  const handleEditChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditValue(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancelEdit();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (editValue.trim()) onSaveEdit(editValue);
    }
  };

  const handleDeleteClick = () => {
    if (confirmDelete) {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      onDelete();
    } else {
      setConfirmDelete(true);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(entry.content).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  if (isEditing) {
    return (
      <div
        onClick={() => editRef.current?.focus()}
        className="mb-3 rounded-xl ring-1 ring-pane-border/40 px-5 py-4 bg-pane-bg cursor-text"
      >
        <div ref={caretContainerRef} className="relative">
          <textarea
            ref={editRef}
            value={editValue}
            onChange={handleEditChange}
            onKeyDown={handleEditKeyDown}
            onFocus={() => {
              setTextareaFocused(true);
              updateCaret();
            }}
            onBlur={() => {
              setTextareaFocused(false);
              setCaretPos(null);
              if (editValue.trim()) onSaveEdit(editValue);
              else onCancelEdit();
            }}
            className="w-full font-mono text-pane-text bg-transparent outline-none resize-none leading-[1.85] placeholder:text-pane-text-secondary/20"
            style={{
              fontSize: "var(--pane-font-size-sm)",
              caretColor: "transparent",
              minHeight: "120px",
            }}
            placeholder="edit your thought..."
          />
          {/* Invisible overlay — Range API measures caret position from this text node */}
          <div
            ref={overlayRef}
            aria-hidden
            style={{
              position: "absolute",
              top: 0, left: 0, right: 0, bottom: 0,
              overflow: "hidden",
              pointerEvents: "none",
              opacity: 0,
              userSelect: "none",
              fontSize: "var(--pane-font-size-sm)",
              lineHeight: "1.85",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              boxSizing: "border-box",
            }}
          >
            <span>{editValue}</span>
          </div>
          {textareaFocused && caretPos && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: caretPos.top,
                left: caretPos.left,
                width: 2,
                height: caretPos.lineHeight,
                background: "var(--pane-accent)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-between mt-3">
          <span
            className="font-mono text-pane-text-secondary/25"
            style={{ fontSize: "10px" }}
          >
            ⌘↵ save · esc cancel
          </span>
          <div className="flex gap-4">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={onCancelEdit}
              className="font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              cancel
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editValue.trim() && onSaveEdit(editValue)}
              disabled={!editValue.trim()}
              className="font-mono text-pane-text hover:text-pane-text-secondary transition-colors disabled:opacity-20"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group mb-3 rounded-xl ring-1 ring-pane-border/40 px-5 py-4 hover:ring-pane-border/70 transition-all ${entry.completed ? "opacity-40" : ""}`}
    >
      <div className="flex items-start gap-4">
        {/* Completion Toggle */}
        <button
          onClick={onToggleComplete}
          className="mt-1 flex-shrink-0 p-1 -m-1 btn-press"
          title={entry.completed ? "Mark as active" : "Mark as executed"}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            className={
              entry.completed
                ? "text-pane-status-added"
                : "text-pane-text-secondary/25 group-hover/toggle:text-pane-text-secondary/50"
            }
          >
            <circle
              cx="12"
              cy="12"
              r="7"
              fill={entry.completed ? "currentColor" : "none"}
              className={
                !entry.completed
                  ? "group-hover/toggle:fill-pane-text-secondary/5"
                  : ""
              }
              strokeWidth="1.5"
            />
            {entry.completed && (
              <path
                d="M9 12l2 2 4-4"
                stroke="var(--pane-bg)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {/* Clicking the text body opens inline edit */}
          <p
            onClick={onStartEdit}
            className={`font-mono leading-[1.85] whitespace-pre-wrap break-words cursor-text transition-colors ${
              entry.completed
                ? "text-pane-text/40"
                : "text-pane-text/70 hover:text-pane-text/90"
            }`}
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {displayedContent}
          </p>

          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-2 font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary transition-colors"
              style={{ fontSize: "10px" }}
            >
              {expanded ? "show less" : "show more"}
            </button>
          )}

          {/* Meta + actions row */}
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-pane-text-secondary/25"
                style={{ fontSize: "10px" }}
              >
                {formatDate(entry.created_at)}
                {entry.updated_at !== entry.created_at && " · edited"}
              </span>
              {hasUnread && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: "var(--pane-terminal)" }}
                />
              )}
            </div>

            {/* Text word actions — ghost until hover */}
            <div className="flex items-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="font-mono transition-colors hover:!opacity-100"
                style={{
                  fontSize: "10px",
                  color: copied
                    ? "var(--pane-status-added)"
                    : "var(--pane-text-secondary)",
                  opacity: copied ? 0.7 : 0.4,
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
              <button
                onClick={handleDeleteClick}
                className="font-mono transition-colors hover:!opacity-100"
                style={{
                  fontSize: "10px",
                  color: confirmDelete
                    ? "var(--pane-error)"
                    : "var(--pane-text-secondary)",
                  opacity: confirmDelete ? 0.8 : 0.4,
                }}
              >
                {confirmDelete ? "confirm?" : "delete"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Mind Component ──────────────────────────────────────────────────────

type SaveStatus = "idle" | "saving" | "saved";

export function Mind() {
  const entries = useMindStore((s) => s.entries);
  const setEntries = useMindStore((s) => s.setEntries);
  const loaded = useMindStore((s) => s.loaded);
  const setLoaded = useMindStore((s) => s.setLoaded);
  const addEntry = useMindStore((s) => s.addEntry);
  const updateEntry = useMindStore((s) => s.updateEntry);
  const removeEntry = useMindStore((s) => s.removeEntry);
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [caretPos, setCaretPos] = useState<{
    top: number;
    left: number;
    lineHeight: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Promise<void> | null>(null);

  const unreadThreadEntryIds = useMindStore((s) => s.unreadThreadEntryIds);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  // Load entries once
  useEffect(() => {
    if (loaded) return;
    brainMindGetAll()
      .then((result) => {
        setEntries(result.entries ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [loaded, setEntries, setLoaded]);

  // Listen for punk-finding events — reload entry list when sentinel creates new entries
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on(
      "pane://punk-finding",
      (data: { entryId?: string; punkType?: string; projectId?: string }) => {
        if (data?.projectId && !data?.entryId) {
          // Sentinel created new mind entries — reload the full entry list
          brainMindGetAll()
            .then((result) => setEntries(result.entries ?? []))
            .catch(() => {});
        }
      }
    );
    return () => unlisten();
  }, [setEntries]);

  // Update static caret position
  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    const container = caretContainerRef.current;
    const overlay = overlayRef.current;
    if (!el || !container || !overlay || document.activeElement !== el) {
      setCaretPos(null);
      return;
    }
    setCaretPos(measureCaretPos(el, container, overlay));
  }, []);

  // Reposition on every value change (covers typing)
  useEffect(() => {
    if (textareaFocused) updateCaret();
  }, [draft, textareaFocused, updateCaret]);

  // Reposition on selection movement (arrows, mouse clicks, scroll)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const events = ["click", "keyup", "mouseup", "select", "scroll"];
    events.forEach((e) => el.addEventListener(e, updateCaret));
    return () => events.forEach((e) => el.removeEventListener(e, updateCaret));
  }, [updateCaret]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Focus textarea when Mind becomes visible
  const mindVisible = useProjectsStore((s) => {
    const pid = s.activeProjectId;
    return pid ? s.projects.get(pid)?.mode === "mind" : false;
  });
  useEffect(() => {
    if (mindVisible) setTimeout(() => textareaRef.current?.focus(), 60);
  }, [mindVisible]);

  const doSave = useCallback(async (content: string): Promise<void> => {
    if (!content.trim()) return;
    setSaveStatus("saving");
    try {
      const result = await brainMindAdd(content.trim(), activeProjectId || undefined);
      const entry = result?.entry;
      if (entry) {
        addEntry(entry);
        setDraft("");
        setSaveStatus("saved");
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 1600);
      } else {
        setSaveStatus("idle");
      }
    } catch {
      setSaveStatus("idle");
    }
  }, [addEntry]);

  const handleBlur = useCallback(() => {
    if (!draft.trim() || pendingSaveRef.current) return;
    const p = doSave(draft);
    pendingSaveRef.current = p;
    p.finally(() => {
      pendingSaveRef.current = null;
    });
  }, [draft, doSave]);

  const handleSaveClick = useCallback(() => {
    if (!draft.trim() || saveStatus === "saving" || pendingSaveRef.current)
      return;
    const p = doSave(draft);
    pendingSaveRef.current = p;
    p.finally(() => {
      pendingSaveRef.current = null;
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [draft, saveStatus, doSave]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSaveClick();
    }
  };

  const handleSaveEdit = async (id: string, content: string) => {
    try {
      const result = await brainMindUpdate(id, content);
      const entry = result?.entry;
      if (entry) {
        updateEntry(id, entry);
      }
    } catch {
      /* silent */
    } finally {
      setEditingId(null);
    }
  };

  const handleToggleComplete = async (id: string, currentStatus: boolean) => {
    try {
      const result = await brainMindUpdate(id, undefined, !currentStatus);
      const entry = result?.entry;
      if (entry) {
        updateEntry(id, entry);
      }
    } catch {
      /* silent */
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await brainMindDelete(id);
      removeEntry(id);
    } catch {
      /* silent */
    }
  };

  const activeEntries = entries
    .filter((e) => !e.completed)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

  const executedEntries = entries
    .filter((e) => e.completed)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

  const hasContent = draft.trim().length > 0;
  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <div className="h-full relative">
      {/* Scrollable list view */}
      <div className="absolute inset-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        <div className="max-w-[780px] mx-auto w-full px-10 pt-[35vh] pb-48">
          {/* ── Compose zone ── */}
          <div
            onClick={() => textareaRef.current?.focus()}
            className={`rounded-xl ring-1 px-5 py-4 bg-pane-bg mb-12 transition-all cursor-text
              ${textareaFocused ? "ring-pane-text/10 ring-2" : "ring-pane-border/40"}
            `}
          >
            <div ref={caretContainerRef} className="relative">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  handleBlur();
                  setTextareaFocused(false);
                  setCaretPos(null);
                }}
                onFocus={() => {
                  setTextareaFocused(true);
                  updateCaret();
                }}
                placeholder="what's on your mind..."
                className="w-full font-mono text-pane-text bg-transparent outline-none resize-none leading-[1.85] placeholder:text-pane-text-secondary/20"
                style={{
                  fontSize: "var(--pane-font-size)",
                  caretColor: "transparent",
                  minHeight: "120px",
                }}
              />
              {/* Invisible overlay — Range API measures caret position from this text node */}
              <div
                ref={overlayRef}
                aria-hidden
                style={{
                  position: "absolute",
                  top: 0, left: 0, right: 0, bottom: 0,
                  overflow: "hidden",
                  pointerEvents: "none",
                  opacity: 0,
                  userSelect: "none",
                  fontSize: "var(--pane-font-size)",
                  lineHeight: "1.85",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  boxSizing: "border-box",
                }}
              >
                <span>{draft}</span>
              </div>
              {/* Static amber cursor — replaces the native blinking caret */}
              {textareaFocused && caretPos && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: caretPos.top,
                    left: caretPos.left,
                    width: 2,
                    height: caretPos.lineHeight,
                    background: "var(--pane-accent)",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>

            <div className="flex items-center justify-between pt-3 mt-2">
              <span
                className="font-mono text-pane-text-secondary/25"
                style={{ fontSize: "10px" }}
              >
                {saveStatus === "saving" && (
                  <span className="animate-pulse">saving...</span>
                )}
                {saveStatus === "saved" && (
                  <span className="text-pane-status-added/60">saved</span>
                )}
                {saveStatus === "idle" && hasContent && `${wordCount}w`}
                {saveStatus === "idle" &&
                  !hasContent &&
                  "click away or ⌘↵ to save"}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleSaveClick}
                  disabled={!hasContent || saveStatus === "saving"}
                  className="font-mono text-pane-text-secondary/50 hover:text-pane-text transition-colors disabled:opacity-0"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  save
                </button>
              </div>
            </div>
          </div>

          {/* ── Entries — grouped by status ── */}
          {loaded && (
            <div className="w-full">
              {/* Active Thoughts */}
              {activeEntries.length > 0 && (
                <div className="mb-12">
                  <div className="mb-4">
                    <span
                      className="font-mono text-pane-text-secondary/60 uppercase tracking-wider"
                      style={{ fontSize: "10px" }}
                    >
                      {activeEntries.length} active{" "}
                      {activeEntries.length === 1 ? "thought" : "thoughts"}
                    </span>
                  </div>
                  {activeEntries.map((entry) => (
                    <EntryItem
                      key={entry.id}
                      entry={entry}
                      isEditing={editingId === entry.id}
                      hasUnread={unreadThreadEntryIds.has(entry.id)}
                      onStartEdit={() => setEditingId(entry.id)}
                      onSaveEdit={(content) => handleSaveEdit(entry.id, content)}
                      onCancelEdit={() => setEditingId(null)}
                      onToggleComplete={() =>
                        handleToggleComplete(entry.id, !!entry.completed)
                      }
                      onDelete={() => handleDelete(entry.id)}
                    />
                  ))}
                </div>
              )}

              {/* Executed Thoughts */}
              {executedEntries.length > 0 && (
                <div className="mt-12">
                  <div className="mb-4">
                    <span
                      className="font-mono text-pane-text-secondary/60 uppercase tracking-wider"
                      style={{ fontSize: "10px" }}
                    >
                      {executedEntries.length} executed{" "}
                      {executedEntries.length === 1 ? "thought" : "thoughts"}
                    </span>
                  </div>
                  {executedEntries.map((entry) => (
                    <EntryItem
                      key={entry.id}
                      entry={entry}
                      isEditing={editingId === entry.id}
                      hasUnread={unreadThreadEntryIds.has(entry.id)}
                      onStartEdit={() => setEditingId(entry.id)}
                      onSaveEdit={(content) => handleSaveEdit(entry.id, content)}
                      onCancelEdit={() => setEditingId(null)}
                      onToggleComplete={() =>
                        handleToggleComplete(entry.id, !!entry.completed)
                      }
                      onDelete={() => handleDelete(entry.id)}
                    />
                  ))}
                </div>
              )}

              {activeEntries.length === 0 && executedEntries.length === 0 && (
                <div className="text-center pt-12">
                  <span
                    className="font-mono text-pane-text-secondary/18"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    nothing here yet.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
