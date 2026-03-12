import { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  brainMindAdd,
  brainMindGetAll,
  brainMindDelete,
  brainMindUpdate,
  type MindEntry,
} from "../../lib/tauri-commands";

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
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  entry: MindEntry;
  isEditing: boolean;
  onStartEdit: () => void;
  onSaveEdit: (content: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const [editValue, setEditValue] = useState(entry.content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (e.key === "Escape") { e.preventDefault(); onCancelEdit(); }
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
      <div className="mb-3 rounded-2xl ring-1 ring-pane-text/20 px-5 py-4">
        <textarea
          ref={editRef}
          value={editValue}
          onChange={handleEditChange}
          onKeyDown={handleEditKeyDown}
          onBlur={() => { if (editValue.trim()) onSaveEdit(editValue); else onCancelEdit(); }}
          className="w-full font-mono text-pane-text bg-transparent outline-none resize-none leading-[1.85] placeholder:text-pane-text-secondary/20"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
          placeholder="edit your thought..."
        />
        <div className="flex items-center justify-between mt-3">
          <span className="font-mono text-pane-text-secondary/25" style={{ fontSize: "10px" }}>
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
    <div className="group mb-3 rounded-2xl ring-1 ring-pane-border/40 px-5 py-4 hover:ring-pane-border/70 transition-all">
      {/* Clicking the text body opens inline edit */}
      <p
        onClick={onStartEdit}
        className="font-mono text-pane-text/70 leading-[1.85] whitespace-pre-wrap break-words cursor-text hover:text-pane-text/90 transition-colors"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        {entry.content}
      </p>

      {/* Meta + actions row */}
      <div className="flex items-center justify-between mt-3">
        <span className="font-mono text-pane-text-secondary/25" style={{ fontSize: "10px" }}>
          {formatDate(entry.created_at)}
          {entry.updated_at !== entry.created_at && " · edited"}
        </span>

        {/* Text word actions — ghost until hover */}
        <div className="flex items-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="font-mono transition-colors"
            style={{
              fontSize: "10px",
              color: copied ? "var(--pane-status-added)" : "var(--pane-text-secondary)",
              opacity: copied ? 0.7 : 0.4,
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
          <button
            onClick={handleDeleteClick}
            className="font-mono transition-colors"
            style={{
              fontSize: "10px",
              color: confirmDelete ? "var(--pane-error)" : "var(--pane-text-secondary)",
              opacity: confirmDelete ? 0.8 : 0.4,
            }}
          >
            {confirmDelete ? "confirm?" : "delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Mind Component ──────────────────────────────────────────────────────

type SaveStatus = "idle" | "saving" | "saved";

export function Mind() {
  const closeMind = useWorkspaceStore((s) => s.closeMind);
  const mindOpen = useWorkspaceStore((s) => s.mindOpen);
  const [entries, setEntries] = useState<MindEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Promise<void> | null>(null);

  // Load entries once
  useEffect(() => {
    if (loaded) return;
    brainMindGetAll()
      .then(({ entries }) => { setEntries(entries ?? []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [loaded]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Focus textarea when Mind opens
  useEffect(() => {
    if (mindOpen) setTimeout(() => textareaRef.current?.focus(), 60);
  }, [mindOpen]);

  // Escape to close (unless mid-editing an entry)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId === null) { e.preventDefault(); closeMind(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeMind, editingId]);

  const doSave = useCallback(async (content: string): Promise<void> => {
    if (!content.trim()) return;
    setSaveStatus("saving");
    try {
      const result = await brainMindAdd(content.trim());
      const entry = result?.entry;
      if (entry) {
        setEntries((prev) => [entry, ...prev]);
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
  }, []);

  const handleBlur = useCallback(() => {
    if (!draft.trim() || pendingSaveRef.current) return;
    const p = doSave(draft);
    pendingSaveRef.current = p;
    p.finally(() => { pendingSaveRef.current = null; });
  }, [draft, doSave]);

  const handleSaveClick = useCallback(() => {
    if (!draft.trim() || saveStatus === "saving" || pendingSaveRef.current) return;
    const p = doSave(draft);
    pendingSaveRef.current = p;
    p.finally(() => { pendingSaveRef.current = null; });
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
        setEntries((prev) => {
          const next = prev.map((e) => (e.id === id ? entry : e));
          // Re-sort because updated_at changed
          return [...next].sort(
            (a, b) =>
              new Date(b.updated_at).getTime() -
              new Date(a.updated_at).getTime(),
          );
        });
      }
    } catch {
      /* silent */
    } finally {
      setEditingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await brainMindDelete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch { /* silent */ }
  };

  const hasContent = draft.trim().length > 0;
  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      {/* Close button — fixed top-right, always accessible while scrolling */}
      <button
        onClick={closeMind}
        className="fixed top-8 right-10 w-7 h-7 flex items-center justify-center rounded text-pane-text-secondary/25 hover:text-pane-text hover:bg-pane-text/[0.06] transition-colors z-50"
        title="Close (Esc)"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>

      <div className="max-w-[780px] mx-auto w-full px-10 pt-[35vh] pb-48">
        {/* ── Compose zone ── */}
        <div className="rounded-2xl ring-1 ring-pane-border/40 px-5 py-4 bg-pane-bg mb-12">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder="what's on your mind..."
            rows={2}
            className="w-full font-mono text-pane-text bg-transparent outline-none resize-none leading-[1.85] placeholder:text-pane-text-secondary/20"
            style={{ fontSize: "var(--pane-font-size)" }}
          />

          <div className="flex items-center justify-between border-t border-pane-border/20 pt-3 mt-2">
            <span className="font-mono text-pane-text-secondary/25" style={{ fontSize: "10px" }}>
              {saveStatus === "saving" && <span className="animate-pulse">saving...</span>}
              {saveStatus === "saved"  && <span className="text-pane-status-added/60">saved</span>}
              {saveStatus === "idle"   && hasContent && `${wordCount}w`}
              {saveStatus === "idle"   && !hasContent && "click away or ⌘↵ to save"}
            </span>
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

        {/* ── Entries — flow directly below the compose zone ── */}
        {loaded && (
          <div className="w-full">
            {entries.length > 0 ? (
              <>
                <div className="mb-4">
                  <span className="font-mono text-pane-text-secondary/25 uppercase tracking-wider" style={{ fontSize: "10px" }}>
                    {entries.length} {entries.length === 1 ? "thought" : "thoughts"}
                  </span>
                </div>
                {entries.map((entry) => (
                  <EntryItem
                    key={entry.id}
                    entry={entry}
                    isEditing={editingId === entry.id}
                    onStartEdit={() => setEditingId(entry.id)}
                    onSaveEdit={(content) => handleSaveEdit(entry.id, content)}
                    onCancelEdit={() => setEditingId(null)}
                    onDelete={() => handleDelete(entry.id)}
                  />
                ))}
              </>
            ) : (
              <div className="text-center">
                <span className="font-mono text-pane-text-secondary/18" style={{ fontSize: "var(--pane-font-size-sm)" }}>
                  nothing here yet.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
