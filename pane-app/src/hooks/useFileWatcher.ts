import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../stores/projects";
import { readFile, readDirectory, watchDirectory, unwatchDirectory } from "../lib/tauri-commands";
import { getParentDir } from "../lib/file-utils";

interface FileChangePayload {
  paths: string[];
}

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

export function useFileWatcher() {
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const projects = useProjectsStore((s) => s.projects);
  const watchedRootsRef = useRef<Set<string>>(new Set());

  // Watch all project roots
  useEffect(() => {
    const currentRoots = new Set<string>();
    for (const id of projectOrder) {
      const project = projects.get(id);
      if (project) currentRoots.add(project.root);
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
  }, [projectOrder, projects]);

  // Listen for file change events and route to correct project
  useEffect(() => {
    const unlistenPromise = listen<FileChangePayload>(
      "pane://file-changed",
      (event) => {
        const { paths } = event.payload;
        const state = useProjectsStore.getState();

        // For each project, check if any changed paths belong to it
        for (const [projectId, project] of state.projects) {
          const relevantPaths = paths.filter((p) => p.startsWith(project.root));
          if (relevantPaths.length === 0) continue;

          // Re-read active file if it was modified externally
          if (
            project.activeFilePath &&
            relevantPaths.some((p) => p === project.activeFilePath) &&
            !wasRecentlyWritten(project.activeFilePath)
          ) {
            readFile(project.activeFilePath)
              .then((content) => {
                useProjectsStore.getState().updateFileContent(projectId, content);
              })
              .catch(console.error);
          }

          // Re-read affected expanded directories
          const affectedDirs = new Set<string>();
          for (const changedPath of relevantPaths) {
            const parentDir = getParentDir(changedPath);
            if (project.expandedDirs.has(parentDir) || project.dirContents.has(parentDir)) {
              affectedDirs.add(parentDir);
            }
          }

          for (const dir of affectedDirs) {
            readDirectory(dir)
              .then((entries) => {
                useProjectsStore.getState().setDirContents(projectId, dir, entries);
              })
              .catch(console.error);
          }

          // Invalidate file index for fuzzy finder
          useProjectsStore.getState().invalidateFileIndex(projectId);
        }
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
