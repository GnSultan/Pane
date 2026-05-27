import { useState, useEffect, useCallback, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";
import {
  readDirectory,
  readFile,
  writeFile,
  renameFile,
  deleteFile,
  revealInFinder,
  type FileEntry,
} from "../../lib/tauri-commands";
import { getParentDir } from "../../lib/file-utils";
import { FileViewer } from "./FileViewer";

// ─── Helpers ────────────────────────────────────────────────────────────────

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function relativePath(full: string, root: string): string {
  if (full.startsWith(root)) return full.slice(root.length).replace(/^\//, "");
  return full;
}

function breadcrumbSegments(
  displayPath: string,
  projectRoot: string,
): { label: string; path: string }[] {
  const rel = relativePath(displayPath, projectRoot);
  if (!rel) return [];
  const parts = rel.split("/").filter(Boolean);
  return parts.map((label, i) => ({
    label,
    path: projectRoot + "/" + parts.slice(0, i + 1).join("/"),
  }));
}

// ─── ExplorerHeader ──────────────────────────────────────────────────────────

interface HeaderProps {
  projectRoot: string;
  currentDir: string;
  activeFilePath: string | null;
  onBack: () => void;
  onUp: () => void;
  onNavigate: (path: string) => void;
}

function ExplorerHeader({
  projectRoot,
  currentDir,
  activeFilePath,
  onBack,
  onUp,
  onNavigate,
}: HeaderProps) {
  const atRoot = currentDir === projectRoot;
  const inFile = activeFilePath !== null;

  // In file state: breadcrumb of the file path
  // In browse state: breadcrumb of currentDir
  const segments = breadcrumbSegments(
    inFile ? activeFilePath : currentDir,
    projectRoot,
  );

  return (
    <div className="relative z-40 h-9 flex items-center gap-0.5 px-3 shrink-0 border-b border-pane-border/20 overflow-x-auto no-scrollbar" data-no-drag>
      {/* Back / up */}
      {inFile ? (
        <button
          onClick={onBack}
          className="shrink-0 text-pane-text-secondary/50 hover:text-pane-text font-mono btn-press pr-2"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
          title="back to folder"
        >
          ←
        </button>
      ) : !atRoot ? (
        <button
          onClick={onUp}
          className="shrink-0 text-pane-text-secondary/50 hover:text-pane-text font-mono btn-press pr-2"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
          title="parent directory"
        >
          ..
        </button>
      ) : null}

      {/* Segments */}
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={seg.path} className="flex items-center gap-0.5 shrink-0">
            {i > 0 && (
              <span
                className="text-pane-text-secondary/25 font-mono select-none"
                style={{ fontSize: "var(--pane-font-size-sm)" }}
              >
                /
              </span>
            )}
            <button
              onClick={() => {
                if (isLast) return;
                if (inFile) {
                  // navigate to a directory segment while in file view — clear file first
                  useProjectsStore.getState().clearFile(
                    useProjectsStore.getState().activeProjectId!,
                  );
                }
                onNavigate(seg.path);
              }}
              disabled={isLast}
              className={`font-mono btn-press px-0.5 rounded ${
                isLast
                  ? "text-pane-text cursor-default"
                  : "text-pane-text-secondary/60 hover:text-pane-text"
              }`}
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {seg.label}
            </button>
          </span>
        );
      })}

      {/* At root with no file — show project name as static label */}
      {!inFile && atRoot && segments.length === 0 && (
        <span
          className="text-pane-text-secondary/40 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          /
        </span>
      )}
    </div>
  );
}

// ─── RenameInput ─────────────────────────────────────────────────────────────

function RenameInput({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      // Select name without extension
      const dot = initialValue.lastIndexOf(".");
      ref.current?.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    }, 20);
    return () => clearTimeout(t);
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
          else onCancel();
        }
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => {
        if (value.trim() && value.trim() !== initialValue) onSubmit(value.trim());
        else onCancel();
      }}
      className="flex-1 min-w-0 bg-transparent text-pane-text font-mono outline-none"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ─── EntryRow ────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: FileEntry;
  isRenaming: boolean;
  isConfirmingDelete: boolean;
  onEnter: (path: string) => void;
  onOpen: (entry: FileEntry) => void;
  onStartRename: () => void;
  onSubmitRename: (newName: string) => void;
  onCancelRename: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onReveal: () => void;
}

function EntryRow({
  entry,
  isRenaming,
  isConfirmingDelete,
  onEnter,
  onOpen,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
  onReveal,
}: EntryRowProps) {
  return (
    <div
      className="group flex items-center h-8 px-4 hover:bg-pane-text/[0.04] select-none"
      data-no-drag
    >
      {isRenaming ? (
        <RenameInput
          initialValue={entry.name}
          onSubmit={onSubmitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          {/* Name — clickable */}
          <button
            onClick={() => (entry.is_dir ? onEnter(entry.path) : onOpen(entry))}
            className={`flex-1 min-w-0 text-left truncate font-mono btn-press ${
              entry.is_dir
                ? "text-pane-terminal"
                : "text-pane-text-secondary"
            }`}
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {entry.name}
            {entry.is_dir && (
              <span className="text-pane-terminal/40">/</span>
            )}
          </button>

          {/* Confirm-delete state */}
          {isConfirmingDelete ? (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onConfirmDelete}
                className="px-2 py-0.5 rounded-md bg-pane-error/10 text-pane-error font-mono btn-press"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                delete?
              </button>
              <button
                onClick={onCancelDelete}
                className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono btn-press"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                ×
              </button>
            </div>
          ) : (
            /* Hover actions */
            <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); onStartRename(); }}
                className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono btn-press"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                rename
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onReveal(); }}
                className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono btn-press"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                reveal
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onAskDelete(); }}
                className="text-pane-text-secondary/40 hover:text-pane-error font-mono btn-press"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                delete
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── NewFileRow ───────────────────────────────────────────────────────────────

function NewFileRow({
  active,
  value,
  onChange,
  onSubmit,
  onCancel,
  onBegin,
}: {
  active: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  onBegin: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => ref.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [active]);

  if (active) {
    return (
      <div className="flex items-center h-8 px-4" data-no-drag>
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (value.trim()) onSubmit(value.trim());
              else onCancel();
            }
            if (e.key === "Escape") onCancel();
          }}
          onBlur={() => {
            if (value.trim()) onSubmit(value.trim());
            else onCancel();
          }}
          placeholder="filename"
          className="flex-1 bg-transparent text-pane-text font-mono outline-none placeholder:text-pane-text-secondary/25"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        />
      </div>
    );
  }

  return (
    <button
      onClick={onBegin}
      className="w-full flex items-center h-8 px-4 text-pane-text-secondary/30 hover:text-pane-text-secondary font-mono btn-press"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
      data-no-drag
    >
      + new file
    </button>
  );
}

// ─── DirectoryListing ────────────────────────────────────────────────────────

interface ListingProps {
  entries: FileEntry[];
  loading: boolean;
  renamingPath: string | null;
  confirmDeletePath: string | null;
  creatingFile: boolean;
  newFileName: string;
  onEnterDir: (path: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  onStartRename: (entry: FileEntry) => void;
  onSubmitRename: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
  onAskDelete: (path: string) => void;
  onConfirmDelete: (path: string) => void;
  onCancelDelete: () => void;
  onReveal: (path: string) => void;
  onBeginCreate: () => void;
  onSubmitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onNewFileNameChange: (v: string) => void;
}

function DirectoryListing({
  entries,
  loading,
  renamingPath,
  confirmDeletePath,
  creatingFile,
  newFileName,
  onEnterDir,
  onOpenFile,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
  onReveal,
  onBeginCreate,
  onSubmitCreate,
  onCancelCreate,
  onNewFileNameChange,
}: ListingProps) {
  if (loading && entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span
          className="text-pane-text-secondary/30 font-mono animate-pulse"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          ·
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1 custom-scrollbar" data-no-drag>
      <NewFileRow
        active={creatingFile}
        value={newFileName}
        onChange={onNewFileNameChange}
        onSubmit={onSubmitCreate}
        onCancel={onCancelCreate}
        onBegin={onBeginCreate}
      />
      {entries.length === 0 && !loading && (
        <div
          className="px-4 py-2 text-pane-text-secondary/30 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          empty
        </div>
      )}
      {entries.map((entry) => (
        <EntryRow
          key={entry.path}
          entry={entry}
          isRenaming={renamingPath === entry.path}
          isConfirmingDelete={confirmDeletePath === entry.path}
          onEnter={onEnterDir}
          onOpen={onOpenFile}
          onStartRename={() => onStartRename(entry)}
          onSubmitRename={(newName) => onSubmitRename(entry.path, newName)}
          onCancelRename={onCancelRename}
          onAskDelete={() => onAskDelete(entry.path)}
          onConfirmDelete={() => onConfirmDelete(entry.path)}
          onCancelDelete={onCancelDelete}
          onReveal={() => onReveal(entry.path)}
        />
      ))}
    </div>
  );
}

// ─── FileExplorer (root) ─────────────────────────────────────────────────────

export function FileExplorer() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectRoot = useProjectsStore((s) =>
    s.activeProjectId ? (s.projects.get(s.activeProjectId)?.root ?? "") : "",
  );
  const activeFilePath = useProjectsStore((s) =>
    s.activeProjectId
      ? (s.projects.get(s.activeProjectId)?.activeFilePath ?? null)
      : null,
  );

  const [currentDir, setCurrentDir] = useState(projectRoot);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");

  // Reset when project root changes (project switch)
  useEffect(() => {
    if (!projectRoot) return;
    setCurrentDir(projectRoot);
    setEntries([]);
    setRenamingPath(null);
    setConfirmDeletePath(null);
    setCreatingFile(false);
    setNewFileName("");
  }, [projectRoot]);

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId) return;

    // Serve from cache immediately, then refresh in background
    const cached = useProjectsStore
      .getState()
      .projects.get(projectId)
      ?.dirContents.get(dir);
    if (cached) setEntries(sortEntries(cached));

    setLoading(true);
    try {
      const fresh = await readDirectory(dir);
      useProjectsStore.getState().setDirContents(projectId, dir, fresh);
      setEntries(sortEntries(fresh));
    } catch (err) {
      console.error("[FileExplorer] loadDir failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load entries whenever browsing a directory
  useEffect(() => {
    if (activeFilePath) return; // file view — no load needed
    if (!currentDir) return;
    loadDir(currentDir);
  }, [currentDir, activeFilePath, loadDir]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleOpenFile = useCallback(async (entry: FileEntry) => {
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      const content = await readFile(entry.path);
      useProjectsStore.getState().openFile(projectId, entry.path, content);
    } catch (err) {
      console.error("[FileExplorer] open failed:", err);
    }
  }, []);

  const handleBack = useCallback(() => {
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId || !activeFilePath) return;
    const parent = getParentDir(activeFilePath);
    useProjectsStore.getState().clearFile(projectId);
    setCurrentDir(parent);
  }, [activeFilePath]);

  const handleUp = useCallback(() => {
    if (currentDir === projectRoot) return;
    const parent = getParentDir(currentDir);
    setCurrentDir(parent);
    setConfirmDeletePath(null);
  }, [currentDir, projectRoot]);

  const handleEnterDir = useCallback((path: string) => {
    setCurrentDir(path);
    setConfirmDeletePath(null);
    setRenamingPath(null);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    setCurrentDir(path);
    setConfirmDeletePath(null);
    setRenamingPath(null);
  }, []);

  const handleStartRename = useCallback((entry: FileEntry) => {
    setConfirmDeletePath(null);
    setRenamingPath(entry.path);
  }, []);

  const handleSubmitRename = useCallback(
    async (oldPath: string, newName: string) => {
      const projectId = useProjectsStore.getState().activeProjectId;
      if (!projectId || !newName.trim()) {
        setRenamingPath(null);
        return;
      }
      const parent = getParentDir(oldPath);
      const newPath = `${parent}/${newName.trim()}`;
      if (newPath === oldPath) {
        setRenamingPath(null);
        return;
      }
      try {
        await renameFile(oldPath, newPath);
        const fresh = await readDirectory(currentDir);
        useProjectsStore.getState().setDirContents(projectId, currentDir, fresh);
        setEntries(sortEntries(fresh));
        const proj = useProjectsStore.getState().projects.get(projectId);
        if (proj?.activeFilePath === oldPath) {
          const content = await readFile(newPath);
          useProjectsStore.getState().openFile(projectId, newPath, content);
        }
        useProjectsStore.getState().invalidateFileIndex(projectId);
      } catch (err) {
        console.error("[FileExplorer] rename failed:", err);
      }
      setRenamingPath(null);
    },
    [currentDir],
  );

  const handleConfirmDelete = useCallback(
    async (filePath: string) => {
      const projectId = useProjectsStore.getState().activeProjectId;
      if (!projectId) return;
      setConfirmDeletePath(null);
      try {
        await deleteFile(filePath);
        const proj = useProjectsStore.getState().projects.get(projectId);
        if (proj?.activeFilePath === filePath) {
          useProjectsStore.getState().clearFile(projectId);
        }
        const fresh = await readDirectory(currentDir);
        useProjectsStore.getState().setDirContents(projectId, currentDir, fresh);
        setEntries(sortEntries(fresh));
        useProjectsStore.getState().invalidateFileIndex(projectId);
      } catch (err) {
        console.error("[FileExplorer] delete failed:", err);
      }
    },
    [currentDir],
  );

  const handleCreateFile = useCallback(
    async (name: string) => {
      const projectId = useProjectsStore.getState().activeProjectId;
      if (!projectId || !name.trim()) return;
      const fileName = name.trim().includes(".")
        ? name.trim()
        : `${name.trim()}.md`;
      const filePath = `${currentDir}/${fileName}`;
      try {
        await writeFile(filePath, "");
        const fresh = await readDirectory(currentDir);
        useProjectsStore.getState().setDirContents(projectId, currentDir, fresh);
        setEntries(sortEntries(fresh));
        useProjectsStore.getState().openFile(projectId, filePath, "");
      } catch (err) {
        console.error("[FileExplorer] create failed:", err);
      }
      setCreatingFile(false);
      setNewFileName("");
    },
    [currentDir],
  );

  if (!activeProjectId || !projectRoot) return null;

  return (
    <div className="flex flex-col h-full" data-no-drag>
      <ExplorerHeader
        projectRoot={projectRoot}
        currentDir={currentDir}
        activeFilePath={activeFilePath}
        onBack={handleBack}
        onUp={handleUp}
        onNavigate={handleNavigate}
      />

      {activeFilePath ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <FileViewer />
        </div>
      ) : (
        <DirectoryListing
          entries={entries}
          loading={loading}
          renamingPath={renamingPath}
          confirmDeletePath={confirmDeletePath}
          creatingFile={creatingFile}
          newFileName={newFileName}
          onEnterDir={handleEnterDir}
          onOpenFile={handleOpenFile}
          onStartRename={handleStartRename}
          onSubmitRename={handleSubmitRename}
          onCancelRename={() => setRenamingPath(null)}
          onAskDelete={(path) => setConfirmDeletePath(path)}
          onConfirmDelete={handleConfirmDelete}
          onCancelDelete={() => setConfirmDeletePath(null)}
          onReveal={(path) => revealInFinder(path)}
          onBeginCreate={() => setCreatingFile(true)}
          onSubmitCreate={handleCreateFile}
          onCancelCreate={() => {
            setCreatingFile(false);
            setNewFileName("");
          }}
          onNewFileNameChange={setNewFileName}
        />
      )}
    </div>
  );
}
