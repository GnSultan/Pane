import { useEffect, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { readFile, readDirectory, watchDirectory, unwatchDirectory } from "../lib/tauri-commands";
import { getParentDir } from "../lib/file-utils";
import { appReadyPromise } from "./useSettingsPersistence";

const electronAPI = window.electronAPI;

// Track files we recently wrote so the watcher doesn't clobber the editor
const recentWrites = new Map<string, number>();

export function markFileWritten(path: string) {
  recentWrites.set(path, Date.now());
}

function wasRecentlyWritten(path: string): boolean {
  const t = recentWrites.get(path);
  if (!t) return false;
  // Ignore watcher events within 2s of our own write
  if (Date.now() - t < 2000) return true;
  recentWrites.delete(path);
  return false;
}

// Suppress file watcher events during checkpoint restore to avoid thrashing
let restoreInProgress = false;
export function setRestoreInProgress(value: boolean) {
  restoreInProgress = value;
}

export function useFileWatcher() {
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const watchedRootsRef = useRef<Set<string>>(new Set());

  // Watch all project roots — wait for app to settle first
  useEffect(() => {
    let cancelled = false;

    appReadyPromise.then(() => {
      if (cancelled) return;

      const { projects } = useProjectsStore.getState();
      const currentRoots = new Set<string>();
      for (const id of projectOrder) {
        const project = projects.get(id);
        // Rootless (unbound) threads have no folder to watch. Watching ""
        // resolves to process.cwd() in the main process — "/" in a
        // Finder-launched packaged app — which recursively walks the whole
        // filesystem and freezes the app.
        if (project && project.root) currentRoots.add(project.root);
      }

      // Start watching new roots
      for (const root of currentRoots) {
        if (!watchedRootsRef.current.has(root)) {
          watchDirectory(root).catch(console.error);
        }
      }

      // Unwatch removed roots
      for (const root of watchedRootsRef.current) {
        if (!currentRoots.has(root)) {
          unwatchDirectory(root).catch(console.error);
        }
      }

      watchedRootsRef.current = currentRoots;
    });

    return () => {
      cancelled = true;
      // Unwatch all roots when the component unmounts (window close, reload)
      // so chokidar instances in the main process don't leak.
      for (const root of watchedRootsRef.current) {
        unwatchDirectory(root).catch(() => {});
      }
      watchedRootsRef.current = new Set();
    };
  }, [projectOrder]);

  // Listen for file change events and route to correct project
  useEffect(() => {
    // Debounce file index invalidation — fuzzy finder doesn't need instant updates
    const indexDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Debounce brain index cleanup — coalesce rapid bursts (e.g. git checkout)
    const brainCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const unlisten = electronAPI.on(
      "pane://file-changed",
      (
        raw:
          | string[]
          | { path: string; type: string }[]
          | { paths: string[] },
      ) => {
        if (restoreInProgress) return;

        // Normalize to {path, type} events.
        // New format: Array<{path, type}> with chokidar event types
        //   (add, change, unlink, unlinkDir, addDir, etc.)
        // Legacy format: string[] (no event type — treat as change)
        let events: { path: string; type: string }[];
        if (Array.isArray(raw)) {
          events = raw
            .map((item) => {
              if (typeof item === "string")
                return { path: item, type: "change" };
              if (item && typeof item.path === "string")
                return { path: item.path, type: item.type || "change" };
              return null;
            })
            .filter(Boolean) as { path: string; type: string }[];
        } else if (raw && Array.isArray((raw as { paths: string[] }).paths)) {
          events = (raw as { paths: string[] }).paths.map((p) => ({
            path: p,
            type: "change",
          }));
        } else {
          return;
        }
        if (events.length === 0) return;

        const state = useProjectsStore.getState();

        // For each project, check if any changed paths belong to it
        for (const [projectId, project] of state.projects) {
          const relevant = events.filter((e) =>
            e.path.startsWith(project.root),
          );
          if (relevant.length === 0) continue;

          const relevantPaths = relevant.map((e) => e.path);

          // Re-read active file if it was modified externally
          if (
            project.activeFilePath &&
            relevantPaths.some((p) => p === project.activeFilePath) &&
            !wasRecentlyWritten(project.activeFilePath)
          ) {
            readFile(project.activeFilePath)
              .then((content) => {
                useProjectsStore
                  .getState()
                  .updateFileContent(projectId, content);
              })
              .catch(console.error);
          }

          // Re-read affected directories.
          // Always include the project root — it's the always-visible entry
          // point and new top-level files would otherwise require a restart.
          // Also refresh any expanded/loaded subdirs that contain changed files.
          const affectedDirs = new Set<string>([project.root]);
          for (const { path: changedPath } of relevant) {
            const parentDir = getParentDir(changedPath);
            if (
              project.expandedDirs.has(parentDir) ||
              project.dirContents.has(parentDir)
            ) {
              affectedDirs.add(parentDir);
            }
          }

          for (const dir of affectedDirs) {
            readDirectory(dir)
              .then((entries) => {
                useProjectsStore
                  .getState()
                  .setDirContents(projectId, dir, entries);
              })
              .catch(console.error);
          }

          // Brain index cleanup for deleted files — remove from symbol index
          // and file nodes immediately so explore/compass don't return ghosts.
          // Debounced to coalesce bursts (e.g. deleting a directory tree).
          const deletedPaths = relevant
            .filter((e) => e.type === "unlink" || e.type === "unlinkDir")
            .map((e) => e.path);

          if (deletedPaths.length > 0 && project.root) {
            const existing = brainCleanupTimers.get(projectId);
            if (existing) clearTimeout(existing);
            brainCleanupTimers.set(
              projectId,
              setTimeout(() => {
                for (const delPath of deletedPaths) {
                  window.electronAPI?.invoke?.("brain_remove_file_from_index", {
                    projectId,
                    filePath: delPath,
                    projectRoot: project.root,
                  });
                }
                brainCleanupTimers.delete(projectId);
              }, 600),
            );
          }

          // Debounce file index invalidation — coalesce rapid file changes
          const existing = indexDebounceTimers.get(projectId);
          if (existing) clearTimeout(existing);
          indexDebounceTimers.set(
            projectId,
            setTimeout(() => {
              useProjectsStore.getState().invalidateFileIndex(projectId);
              indexDebounceTimers.delete(projectId);
            }, 500),
          );
        }
      },
    );

    return () => {
      unlisten();
      for (const timer of indexDebounceTimers.values()) clearTimeout(timer);
      for (const timer of brainCleanupTimers.values()) clearTimeout(timer);
    };
  }, []);
}
