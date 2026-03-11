import { useEffect, useCallback, useState, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { readDirectory, readDirectoryTree, readFile, deleteFile, revealInFinder, writeFile, renameFile } from "../../lib/tauri-commands";
import type { FileEntry } from "../../lib/tauri-commands";
import { getParentDir } from "../../lib/file-utils";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";

const EMPTY_ENTRIES: FileEntry[] = [];

function getStatusColor(status: string): string {
  switch (status) {
    case "M": return "text-pane-status-modified";
    case "A": return "text-pane-status-added";
    case "??": return "text-pane-status-untracked";
    case "D": return "text-pane-status-deleted";
    case "R": return "text-pane-status-renamed";
    default: return "text-pane-text-secondary";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "M": return "M";
    case "A": return "A";
    case "??": return "U";
    case "D": return "D";
    case "R": return "R";
    default: return status.charAt(0);
  }
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export function FileTree() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const root = useProjectsStore((s) => {
    if (!s.activeProjectId) return undefined;
    return s.projects.get(s.activeProjectId)?.root;
  });
  const rootEntries = useProjectsStore(
    useShallow((s) => {
      if (!s.activeProjectId) return EMPTY_ENTRIES;
      const p = s.projects.get(s.activeProjectId);
      return p?.dirContents.get(p.root) ?? EMPTY_ENTRIES;
    })
  );
  const hasRootLoaded = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    const p = s.projects.get(s.activeProjectId);
    return p ? p.dirContents.has(p.root) : false;
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [newFileDir, setNewFileDir] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => {
      if (root) setNewFileDir(root);
    };
    window.addEventListener("pane:new-file", handler);
    return () => window.removeEventListener("pane:new-file", handler);
  }, [root]);

  const loadDir = useCallback(async (path: string) => {
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId) return;
    const { setLoading, setDirContents } = useProjectsStore.getState();
    setLoading(projectId, path, true);
    try {
      const entries = await readDirectory(path);
      setDirContents(projectId, path, entries);
    } catch (err) {
      console.error("Failed to read directory:", err);
    } finally {
      setLoading(projectId, path, false);
    }
  }, []);

  const handleCreateFile = useCallback(async (dir: string, name: string) => {
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId || !name.trim()) return;
    const fileName = name.trim().includes(".") ? name.trim() : `${name.trim()}.md`;
    const filePath = `${dir}/${fileName}`;
    try {
      await writeFile(filePath, "");
      const entries = await readDirectory(dir);
      useProjectsStore.getState().setDirContents(projectId, dir, entries);
      useProjectsStore.getState().openFile(projectId, filePath, "");
    } catch (err) {
      console.error("Failed to create file:", err);
    }
    setNewFileDir(null);
  }, []);

  const handleRename = useCallback(async (oldPath: string, newName: string) => {
    const projectId = useProjectsStore.getState().activeProjectId;
    if (!projectId || !newName.trim()) { setRenamingPath(null); return; }
    const parentDir = getParentDir(oldPath);
    const newPath = `${parentDir}/${newName.trim()}`;
    if (newPath === oldPath) { setRenamingPath(null); return; }
    try {
      await renameFile(oldPath, newPath);
      const entries = await readDirectory(parentDir);
      useProjectsStore.getState().setDirContents(projectId, parentDir, entries);
      const project = useProjectsStore.getState().projects.get(projectId);
      if (project?.activeFilePath === oldPath) {
        const content = await readFile(newPath);
        useProjectsStore.getState().openFile(projectId, newPath, content);
      }
      useProjectsStore.getState().invalidateFileIndex(projectId);
    } catch (err) {
      console.error("Failed to rename:", err);
    }
    setRenamingPath(null);
  }, []);

  const handleDelete = useCallback(async (filePath: string) => {
    try {
      await deleteFile(filePath);
      const store = useProjectsStore.getState();
      const p = activeProjectId ? store.projects.get(activeProjectId) : undefined;
      if (!p || !activeProjectId) return;
      if (p.activeFilePath && p.activeFilePath === filePath) {
        store.clearFile(activeProjectId);
      }
      const parentDir = getParentDir(filePath);
      const entries = await readDirectory(parentDir);
      store.setDirContents(activeProjectId, parentDir, entries);
      store.invalidateFileIndex(activeProjectId);
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  }, [activeProjectId]);

  const handleContextMenu = useCallback(
    (x: number, y: number, path: string, isDir: boolean) => {
      setContextMenu({ x, y, path, isDir });
    },
    [],
  );

  const getContextMenuItems = useCallback(
    (menu: ContextMenuState): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];
      if (menu.isDir) {
        items.push({ label: "New File", action: () => setNewFileDir(menu.path) });
      }
      items.push({ label: "Rename", action: () => setRenamingPath(menu.path) });
      items.push({ label: "Reveal in Finder", action: () => revealInFinder(menu.path).catch(console.error) });
      if (!menu.isDir) {
        items.push({ label: "Delete", danger: true, action: () => handleDelete(menu.path) });
      }
      return items;
    },
    [handleDelete],
  );

  // Load root directory when project becomes active
  useEffect(() => {
    if (!root || hasRootLoaded || !activeProjectId) return;
    const id = activeProjectId;

    readDirectory(root)
      .then((entries) => {
        useProjectsStore.getState().setDirContents(id, root, entries);
        requestIdleCallback(() => {
          readDirectoryTree(root, 3)
            .then((tree) => {
              useProjectsStore.getState().batchSetDirContents(id, tree);
            })
            .catch(() => {});
        });
      })
      .catch(() => {
        loadDir(root);
      });
  }, [root, activeProjectId, hasRootLoaded, loadDir]);

  const entries = rootEntries.length > 0 ? rootEntries : undefined;

  return (
    <div
      className="flex-1 overflow-y-auto py-2 px-1 relative"
    >
      {newFileDir === root && (
        <NewFileInput
          depth={0}
          onSubmit={(name) => root && handleCreateFile(root, name)}
          onCancel={() => setNewFileDir(null)}
        />
      )}
      {entries?.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          loadDir={loadDir}
          onContextMenu={handleContextMenu}
          newFileDir={newFileDir}
          onCreateFile={handleCreateFile}
          onCancelCreate={() => setNewFileDir(null)}
          renamingPath={renamingPath}
          onRename={handleRename}
          onCancelRename={() => setRenamingPath(null)}
        />
      ))}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function NewFileInput({
  depth,
  onSubmit,
  onCancel,
}: {
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="flex items-center h-8"
      style={{ paddingLeft: `${depth * 16 + 8 + 16}px`, paddingRight: "8px" }}
    >
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onSubmit(name);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (Date.now() - mountedAt.current < 300) return;
          if (name.trim()) onSubmit(name);
          else onCancel();
        }}
        placeholder="filename"
        className="w-full bg-pane-bg border border-pane-border px-2 py-0.5
                    text-pane-text outline-none
                   placeholder:text-pane-text-secondary/30"
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      />
    </div>
  );
}

function RenameInput({
  currentName,
  depth,
  onSubmit,
  onCancel,
}: {
  currentName: string;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(currentName);

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="flex items-center h-8"
      style={{ paddingLeft: `${depth * 16 + 8 + 16}px`, paddingRight: "8px" }}
    >
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onSubmit(name.trim());
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (name.trim() && name.trim() !== currentName) onSubmit(name.trim());
          else onCancel();
        }}
        className="w-full bg-pane-bg border border-pane-border px-2 py-0.5
                   text-pane-text outline-none"
        style={{ fontSize: "var(--pane-panel-font-size)" }}
      />
    </div>
  );
}

function FileTreeNode({
  entry,
  depth,
  loadDir,
  onContextMenu,
  newFileDir,
  onCreateFile,
  onCancelCreate,
  renamingPath,
  onRename,
  onCancelRename,
}: {
  entry: FileEntry;
  depth: number;
  loadDir: (path: string) => Promise<void>;
  onContextMenu: (x: number, y: number, path: string, isDir: boolean) => void;
  newFileDir: string | null;
  onCreateFile: (dir: string, name: string) => void;
  onCancelCreate: () => void;
  renamingPath: string | null;
  onRename: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
}) {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  const isExpanded = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.expandedDirs.has(entry.path) ?? false;
  });
  const isLoading = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.loadingDirs.has(entry.path) ?? false;
  });
  const isSelected = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.selectedPath === entry.path;
  });
  const children = useProjectsStore(
    useShallow((s) => {
      if (!s.activeProjectId) return EMPTY_ENTRIES;
      return s.projects.get(s.activeProjectId)?.dirContents.get(entry.path) ?? EMPTY_ENTRIES;
    })
  );
  const status = useProjectsStore((s) => {
    if (!s.activeProjectId) return undefined;
    return s.projects.get(s.activeProjectId)?.git.fileStatuses.get(entry.path);
  });
  const dirHasChanges = useProjectsStore((s) => {
    if (!entry.is_dir || !s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.git.dirtyDirs.has(entry.path) ?? false;
  });
  const isDirLoaded = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.dirContents.has(entry.path) ?? false;
  });

  useEffect(() => {
    if (entry.is_dir && isExpanded && !isDirLoaded && !isLoading) {
      loadDir(entry.path);
    }
  }, [entry.is_dir, entry.path, isExpanded, isDirLoaded, isLoading, loadDir]);

  if (!activeProjectId) return null;

  // Inline rename input replaces the row
  if (renamingPath === entry.path) {
    return (
      <RenameInput
        currentName={entry.name}
        depth={depth}
        onSubmit={(newName) => onRename(entry.path, newName)}
        onCancel={onCancelRename}
      />
    );
  }

  const handleClick = () => {
    const { toggleDir, setSelectedPath, openFile, setMode } = useProjectsStore.getState();
    if (entry.is_dir) {
      toggleDir(activeProjectId, entry.path);
      if (!isExpanded && !isDirLoaded) {
        loadDir(entry.path).catch((err) => {
          console.error("Failed to load directory:", err);
        });
      }
    } else {
      setSelectedPath(activeProjectId, entry.path);
      readFile(entry.path)
        .then((content) => {
          openFile(activeProjectId, entry.path, content);
        })
        .catch((err) => {
          console.error("Failed to read file:", err);
          setMode(activeProjectId, "viewer");
        });
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const { setSelectedPath } = useProjectsStore.getState();
    setSelectedPath(activeProjectId!, entry.path);
    onContextMenu(e.clientX, e.clientY, entry.path, entry.is_dir);
  };

  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleRightClick}
        className={`
          w-full flex items-center gap-1.5 h-8 truncate text-left btn-press
          hover:bg-pane-bg hover:ring-1 hover:ring-pane-border/40 hover:rounded-xl
          ${isSelected ? "bg-pane-text/[0.08] rounded-xl text-pane-text" : "text-pane-text"}
          ${entry.is_hidden ? "opacity-50" : ""}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: "8px", fontSize: "var(--pane-panel-font-size)" }}
      >
        {entry.is_dir ? (
          <span className={`w-3 shrink-0 ${dirHasChanges ? "text-pane-status-modified" : "text-pane-text-secondary"}`}
                style={{ fontSize: "var(--pane-panel-font-size-xs)" }}>
            {isLoading ? "·" : isExpanded ? "▾" : "▸"}
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="truncate flex-1">{entry.name}</span>
        {status && (
          <span className={`shrink-0 ${getStatusColor(status)}`}
                style={{ fontSize: "var(--pane-panel-font-size-xs)" }}>
            {getStatusLabel(status)}
          </span>
        )}
      </button>

      {entry.is_dir && isExpanded && (
        <>
          {newFileDir === entry.path && (
            <NewFileInput
              depth={depth + 1}
              onSubmit={(name) => onCreateFile(entry.path, name)}
              onCancel={onCancelCreate}
            />
          )}
          {children.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              loadDir={loadDir}
              onContextMenu={onContextMenu}
              newFileDir={newFileDir}
              onCreateFile={onCreateFile}
              onCancelCreate={onCancelCreate}
              renamingPath={renamingPath}
              onRename={onRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </>
      )}
    </>
  );
}
