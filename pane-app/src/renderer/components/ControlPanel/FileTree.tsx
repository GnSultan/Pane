import { useEffect, useCallback, useState, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { readDirectory, readFile, deleteFile, revealInFinder, writeFile } from "../../lib/tauri-commands";
import type { FileEntry } from "../../lib/tauri-commands";
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
  // Get root entries only — each FileTreeNode fetches its own children
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

  // Listen for Cmd+N to create file at project root
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
      // Reload directory to show new file
      const entries = await readDirectory(dir);
      useProjectsStore.getState().setDirContents(projectId, dir, entries);
      // Open the new file
      useProjectsStore.getState().openFile(projectId, filePath, "");
    } catch (err) {
      console.error("Failed to create file:", err);
    }
    setNewFileDir(null);
  }, []);

  // Load root directory when project becomes active
  useEffect(() => {
    if (root && !hasRootLoaded) {
      loadDir(root);
    }
  }, [root, activeProjectId, hasRootLoaded, loadDir]);

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
        items.push({
          label: "New File",
          action: () => setNewFileDir(menu.path),
        });
      }
      items.push(
        {
          label: "Copy Path",
          action: () => navigator.clipboard.writeText(menu.path),
        },
        {
          label: "Reveal in Finder",
          action: () => revealInFinder(menu.path).catch(console.error),
        },
      );
      if (!menu.isDir) {
        items.push({
          label: "Delete File",
          danger: true,
          action: () => deleteFile(menu.path).catch(console.error),
        });
      }
      return items;
    },
    [],
  );

  const entries = rootEntries.length > 0 ? rootEntries : undefined;

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!root) return;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      path: root,
      isDir: true,
    });
  }, [root]);

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden py-2 relative overscroll-contain"
      onContextMenu={handleRootContextMenu}
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
    // Delay focus slightly to avoid race with other focus effects
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
          if (e.key === "Enter" && name.trim()) {
            onSubmit(name);
          }
          if (e.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={() => {
          // Don't cancel immediately on blur — user may have just triggered Cmd+N
          // and something else stole focus briefly
          if (Date.now() - mountedAt.current < 300) return;
          if (name.trim()) {
            onSubmit(name);
          } else {
            onCancel();
          }
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

function FileTreeNode({
  entry,
  depth,
  loadDir,
  onContextMenu,
  newFileDir,
  onCreateFile,
  onCancelCreate,
}: {
  entry: FileEntry;
  depth: number;
  loadDir: (path: string) => Promise<void>;
  onContextMenu: (x: number, y: number, path: string, isDir: boolean) => void;
  newFileDir: string | null;
  onCreateFile: (dir: string, name: string) => void;
  onCancelCreate: () => void;
}) {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  // Select only the specific booleans/primitives this node needs
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
  // Children entries for this specific dir — useShallow for array stability
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
  // Compute dirHasChanges inside selector to return a boolean (primitive)
  const dirHasChanges = useProjectsStore((s) => {
    if (!entry.is_dir || !s.activeProjectId) return false;
    const statuses = s.projects.get(s.activeProjectId)?.git.fileStatuses;
    if (!statuses) return false;
    for (const p of statuses.keys()) {
      if (p.startsWith(entry.path + "/")) return true;
    }
    return false;
  });

  // Check if this directory has been loaded (even if empty)
  const isDirLoaded = useProjectsStore((s) => {
    if (!s.activeProjectId) return false;
    return s.projects.get(s.activeProjectId)?.dirContents.has(entry.path) ?? false;
  });

  const hasChildren = children.length > 0;

  // Auto-load contents for dirs restored as expanded (e.g. after settings restore)
  // Use isDirLoaded instead of hasChildren — empty dirs have no children but ARE loaded
  useEffect(() => {
    if (entry.is_dir && isExpanded && !isDirLoaded && !isLoading) {
      loadDir(entry.path);
    }
  }, [entry.is_dir, entry.path, isExpanded, isDirLoaded, isLoading, loadDir]);

  if (!activeProjectId) return null;

  const handleClick = () => {
    const { toggleDir, setSelectedPath, openFile, setMode } = useProjectsStore.getState();
    if (entry.is_dir) {
      // Immediate UI feedback - expand/collapse folder instantly
      toggleDir(activeProjectId, entry.path);

      // Load directory contents in background - don't block UI
      if (!isExpanded && !isDirLoaded) {
        loadDir(entry.path).catch((err) => {
          console.error("Failed to load directory:", err);
        });
      }
    } else {
      // Immediate UI feedback - select file
      setSelectedPath(activeProjectId, entry.path);

      // Load content and open file - openFile() will set mode to viewer
      readFile(entry.path)
        .then((content) => {
          openFile(activeProjectId, entry.path, content);
        })
        .catch((err) => {
          console.error("Failed to read file:", err);
          // On error, at least switch to viewer mode to show the error state
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
          hover:bg-pane-text/[0.08] active:bg-pane-text/[0.12]
          ${isSelected ? "bg-pane-text/[0.10] text-pane-text" : "text-pane-text"}
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
            />
          ))}
        </>
      )}
    </>
  );
}
