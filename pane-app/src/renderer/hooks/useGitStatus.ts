import { useEffect, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import { getGitStatus } from "../lib/tauri-commands";
import { appReadyPromise } from "./useSettingsPersistence";

const electronAPI = (window as any).electronAPI;

export function useGitStatus() {
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const lastFetchRef = useRef<Map<string, number>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchAllStatuses = () => {
      if (cancelled) return;
      const state = useProjectsStore.getState();
      for (const [projectId, project] of state.projects) {
        const now = Date.now();
        const lastFetch = lastFetchRef.current.get(projectId) ?? 0;
        if (now - lastFetch < 3000) continue;
        lastFetchRef.current.set(projectId, now);

        getGitStatus(project.root)
          .then((status) => {
            // Build new map and compare before updating store
            const absoluteMap = new Map<string, string>();
            for (const [relPath, code] of Object.entries(status.files)) {
              absoluteMap.set(`${project.root}/${relPath}`, code);
            }

            // Skip store update if nothing changed — avoids creating new Map ref
            const current = useProjectsStore.getState().projects.get(projectId);
            if (current) {
              const oldGit = current.git;
              if (
                oldGit.branch === status.branch &&
                oldGit.isGitRepo === true &&
                oldGit.fileStatuses.size === absoluteMap.size &&
                [...absoluteMap].every(([k, v]) => oldGit.fileStatuses.get(k) === v)
              ) {
                return; // No change, skip store mutation
              }
            }

            useProjectsStore
              .getState()
              .setGitStatus(projectId, status.branch, absoluteMap, true);
          })
          .catch(() => {
            useProjectsStore
              .getState()
              .setGitStatus(projectId, "", new Map(), false);
          });
      }
    };

    // Debounced version for file-change events — coalesce rapid bursts
    const debouncedFetch = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fetchAllStatuses, 800);
    };

    // Wait for app to finish loading settings before starting git polling
    let unlisten: (() => void) | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    appReadyPromise.then(() => {
      if (cancelled) return;
      fetchAllStatuses();

      unlisten = electronAPI.on("pane://file-changed", () => {
        debouncedFetch();
      });

      interval = setInterval(fetchAllStatuses, 10000);
    });

    return () => {
      cancelled = true;
      unlisten?.();
      if (interval) clearInterval(interval);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [projectOrder]);
}
