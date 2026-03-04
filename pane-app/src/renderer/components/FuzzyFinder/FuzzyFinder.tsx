import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Fuse from "fuse.js";
import { useWorkspaceStore } from "../../stores/workspace";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { walkProjectFiles, readFile } from "../../lib/tauri-commands";
import { getFileName } from "../../lib/file-utils";

const EMPTY_FILES: string[] = [];

export function FuzzyFinder() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const closeFuzzyFinder = useWorkspaceStore((s) => s.closeFuzzyFinder);

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectRoot = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.root ?? null;
  });
  const files = useProjectsStore(
    useShallow((s) => s.projects.get(s.activeProjectId ?? "")?.fileIndex.files ?? EMPTY_FILES)
  );
  const isLoading = useProjectsStore((s) => s.projects.get(s.activeProjectId ?? "")?.fileIndex.isLoading ?? false);
  const lastIndexed = useProjectsStore((s) => s.projects.get(s.activeProjectId ?? "")?.fileIndex.lastIndexed ?? 0);

  // Load file index if stale
  useEffect(() => {
    if (!projectRoot || !activeProjectId) return;
    const isStale = Date.now() - lastIndexed > 30000;
    if (isStale && !isLoading) {
      useProjectsStore.getState().setFileIndexLoading(activeProjectId, true);
      walkProjectFiles(projectRoot)
        .then((result) => {
          useProjectsStore.getState().setFileIndex(activeProjectId, result);
        })
        .catch(console.error);
    }
  }, [projectRoot, activeProjectId, lastIndexed, isLoading]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const fuse = useMemo(() => {
    return new Fuse(files, {
      threshold: 0.4,
      distance: 100,
    });
  }, [files]);

  const results = useMemo(() => {
    if (query.length === 0) return [];
    return fuse.search(query, { limit: 50 }).map((r) => r.item);
  }, [query, fuse]);

  const hasResults = results.length > 0;

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    async (relativePath: string) => {
      if (!projectRoot || !activeProjectId) return;
      const fullPath = `${projectRoot}/${relativePath}`;
      try {
        const content = await readFile(fullPath);
        useProjectsStore.getState().openFile(activeProjectId, fullPath, content);
      } catch (err) {
        console.error("Failed to open file:", err);
      }
      closeFuzzyFinder();
    },
    [projectRoot, activeProjectId, closeFuzzyFinder],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeFuzzyFinder();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) handleSelect(selected);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12%]"
      onClick={closeFuzzyFinder}
    >
      <div
        className={`w-full max-w-[560px] mx-4 bg-pane-bg rounded-2xl ring-1 ring-pane-border/40 overflow-hidden flex flex-col animate-fadeSlideUp ${
          hasResults ? "max-h-[420px]" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="px-5 py-4 shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isLoading ? "indexing..." : "search"}
            className="w-full bg-transparent text-pane-text font-mono outline-none placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size)" }}
          />
        </div>

        {hasResults && (
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {results.map((relativePath, i) => (
              <button
                key={relativePath}
                onClick={() => handleSelect(relativePath)}
                className={`w-full px-5 py-2.5 text-left font-mono flex items-center gap-3 ${
                  i === selectedIndex
                    ? "bg-pane-text/[0.07]"
                    : "hover:bg-pane-text/[0.04]"
                }`}
              >
                <span
                  className="shrink-0 text-pane-text"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  {getFileName(relativePath)}
                </span>
                <span
                  className="text-pane-text-secondary/40 truncate"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  {relativePath.split("/").slice(0, -1).join("/")}
                  {relativePath.includes("/") && "/"}
                </span>
              </button>
            ))}
          </div>
        )}

        {query.length > 0 && results.length === 0 && !isLoading && (
          <div className="px-5 pb-4">
            <p
              className="text-pane-text-secondary/30 font-mono tracking-wider"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              no matches
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
