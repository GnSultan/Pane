import { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { useProjectsStore } from "../../stores/projects";
import { searchInFiles, readFile } from "../../lib/tauri-commands";
import type { SearchResult } from "../../lib/tauri-commands";
import { getFileName } from "../../lib/file-utils";

export function FileSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeFileSearch = useWorkspaceStore((s) => s.closeFileSearch);

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectRoot = useProjectsStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.get(s.activeProjectId)?.root ?? null;
  });

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (!projectRoot || query.length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchInFiles(projectRoot, query)
        .then((r) => {
          setResults(r);
          setSelectedIndex(0);
        })
        .catch(console.error)
        .finally(() => setIsSearching(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, projectRoot]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    async (result: SearchResult) => {
      if (!activeProjectId) return;
      try {
        const content = await readFile(result.absolute_path);
        useProjectsStore
          .getState()
          .openFile(activeProjectId, result.absolute_path, content);
      } catch (err) {
        console.error("Failed to open file:", err);
      }
      closeFileSearch();
    },
    [activeProjectId, closeFileSearch],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeFileSearch();
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

  const hasResults = results.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12%]"
      onClick={closeFileSearch}
    >
      <div
        className={`w-full max-w-[640px] mx-4 bg-pane-surface rounded-lg overflow-hidden flex flex-col animate-fadeSlideUp ${
          hasResults ? "max-h-[520px]" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="px-5 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <span
              className="shrink-0 font-mono"
              style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)" }}
            >
              grep
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="pattern"
              className="w-full bg-transparent text-pane-text font-mono outline-none placeholder:text-pane-text-secondary/30"
              style={{ fontSize: "var(--pane-font-size)" }}
            />
            {isSearching && (
              <span className="flex items-center gap-1 shrink-0">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-pane-text/50 animate-dotPulse1" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-pane-text/50 animate-dotPulse2" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-pane-text/50 animate-dotPulse3" />
              </span>
            )}
          </div>
        </div>

        {hasResults && (
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {results.map((result, i) => (
              <button
                key={`${result.file_path}:${result.line_number}`}
                onClick={() => handleSelect(result)}
                className={`w-full px-5 py-3 text-left font-mono flex flex-col gap-1.5 ${
                  i === selectedIndex
                    ? "bg-pane-text/[0.07]"
                    : "hover:bg-pane-text/[0.04]"
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span
                    className="text-pane-text shrink-0"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    {getFileName(result.file_path)}
                  </span>
                  <span
                    className="shrink-0"
                    style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)" }}
                  >
                    :{result.line_number}
                  </span>
                  <span
                    className="text-pane-text-secondary/30 truncate"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {result.file_path}
                  </span>
                </span>
                <span
                  className="text-pane-text-secondary/60 truncate"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  {result.line_content.trim()}
                </span>
              </button>
            ))}
          </div>
        )}

        {query.length >= 2 && results.length === 0 && !isSearching && (
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
