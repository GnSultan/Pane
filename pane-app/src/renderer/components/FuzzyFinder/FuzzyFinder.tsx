import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Fuse from "fuse.js";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { walkProjectFiles, readFile, searchInFiles, type SearchResult } from "../../lib/tauri-commands";
import { getFileName } from "../../lib/file-utils";

const EMPTY_FILES: string[] = [];

// Unified result type for both file names and code content
interface UnifiedResult {
  type: "file" | "code";
  path: string;
  line?: number;
  lineContent?: string;
  score: number;
}

export function FuzzyFinder() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [codeResults, setCodeResults] = useState<SearchResult[]>([]);
  const [isSearchingCode, setIsSearchingCode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Mode-driven auto-focus: focus input whenever mode becomes "search"
  const mode = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.mode ?? null;
  });
  useEffect(() => {
    if (mode === "search") {
      inputRef.current?.focus();
    }
  }, [mode]);

  // Search for code content when query changes
  useEffect(() => {
    if (!projectRoot || query.length < 2) {
      setCodeResults([]);
      setIsSearchingCode(false);
      return;
    }
    
    setIsSearchingCode(true);
    const debounceTimer = setTimeout(() => {
      searchInFiles(projectRoot, query, 100)
        .then((results) => {
          setCodeResults(results);
        })
        .catch(console.error)
        .finally(() => setIsSearchingCode(false));
    }, 150);
    
    return () => clearTimeout(debounceTimer);
  }, [query, projectRoot]);

  const fuse = useMemo(() => {
    return new Fuse(files, {
      threshold: 0.4,
      distance: 100,
    });
  }, [files]);

  // Combine file name results and code content results
  const allResults = useMemo(() => {
    if (query.length === 0) return [];
    
    const fileResults = fuse.search(query, { limit: 30 }).map((r) => ({
      type: "file" as const,
      path: r.item,
      score: 100 - (r.score ?? 1), // Fuse.js scores are higher for worse matches
    }));
    
    const codeResultsMapped = codeResults.map((r) => ({
      type: "code" as const,
      path: r.file_path,
      line: r.line_number,
      lineContent: r.line_content,
      score: 50, // Give code results lower priority than exact file matches
    }));
    
    // Combine and sort by score
    const combined = [...fileResults, ...codeResultsMapped];
    return combined.sort((a, b) => b.score - a.score).slice(0, 50);
  }, [query, fuse, codeResults]);

  const hasResults = allResults.length > 0;

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allResults]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    async (result: UnifiedResult) => {
      if (!projectRoot || !activeProjectId) return;
      const fullPath = `${projectRoot}/${result.path}`;
      try {
        const content = await readFile(fullPath);
        useProjectsStore.getState().openFile(activeProjectId, fullPath, content);
        
        // If it's a code result, scroll to the line
        if (result.type === "code" && result.line) {
          // Dispatch an event to scroll to the line after opening the file
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("pane:scroll-to-line", {
              detail: { line: result.line }
            }));
          }, 100);
        }
      } catch (err) {
        console.error("Failed to open file:", err);
      }
      if (activeProjectId) useProjectsStore.getState().setMode(activeProjectId, "viewer");
    },
    [projectRoot, activeProjectId],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (activeProjectId) useProjectsStore.getState().setMode(activeProjectId, "conversation");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, allResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = allResults[selectedIndex];
      if (selected) handleSelect(selected);
    }
  };

  return (
    <div
      className="h-full w-full flex items-start justify-center pt-[12%]"
      onKeyDown={handleKeyDown}
    >
      <div
        className={`w-full max-w-[560px] mx-4 bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden flex flex-col animate-fadeSlideUp ${
          hasResults ? "max-h-[420px]" : ""
        }`}
      >
        <div className="px-5 py-4 shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isLoading ? "indexing..." : "search files and code..."}
            className="w-full bg-transparent text-pane-text font-mono outline-none placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size)" }}
          />
        </div>

        {hasResults && (
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {allResults.map((result, i) => (
              <button
                key={`${result.path}-${result.type === "code" ? result.line : ""}`}
                onClick={() => handleSelect(result)}
                className={`w-full px-5 py-2.5 text-left font-mono flex items-center gap-3 ${
                  i === selectedIndex
                    ? "bg-pane-text/[0.07]"
                    : "hover:bg-pane-text/[0.04]"
                }`}
              >
                {result.type === "file" ? (
                  <>
                    <span
                      className="shrink-0 text-pane-text"
                      style={{ fontSize: "var(--pane-font-size-sm)" }}
                    >
                      {getFileName(result.path)}
                    </span>
                    <span
                      className="text-pane-text-secondary/40 truncate"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {result.path.split("/").slice(0, -1).join("/")}
                      {result.path.includes("/") && "/"}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex flex-col min-w-0 flex-1">
                      <span
                        className="text-pane-text-secondary/70 truncate"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        {getFileName(result.path)}
                        <span className="text-pane-text-secondary/40">
                          {" :"}{result.line}
                        </span>
                      </span>
                      <span
                        className="text-pane-text truncate"
                        style={{ fontSize: "var(--pane-font-size-sm)" }}
                      >
                        {result.lineContent}
                      </span>
                    </div>
                  </>
                )}
              </button>
            ))}
          </div>
        )}

        {query.length > 0 && allResults.length === 0 && !isLoading && !isSearchingCode && (
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
