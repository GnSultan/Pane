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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const closeFileSearch = useWorkspaceStore((s) => s.closeFileSearch);

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const activeProject = useProjectsStore((s) => {
    if (!s.activeProjectId) return undefined;
    return s.projects.get(s.activeProjectId);
  });

  const projectRoot = activeProject?.root ?? null;

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15%]"
      style={{ backgroundColor: "var(--pane-overlay)" }}
      onClick={closeFileSearch}
    >
      <div
        className="w-[640px] max-h-[500px] bg-pane-surface border border-pane-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="px-3 py-2 border-b border-pane-border flex items-center gap-2">
          <span className="text-pane-text-secondary text-xs font-mono shrink-0">
            grep
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in files..."
            className="w-full bg-transparent text-pane-text text-sm font-mono outline-none placeholder:text-pane-text-secondary"
          />
          {isSearching && (
            <span className="text-pane-text-secondary text-[10px] shrink-0">
              ...
            </span>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {results.map((result, i) => (
            <button
              key={`${result.file_path}:${result.line_number}`}
              onClick={() => handleSelect(result)}
              className={`w-full px-3 py-1.5 text-left text-xs font-mono flex flex-col gap-0.5 ${
                i === selectedIndex
                  ? "bg-pane-text/[0.07] text-pane-text"
                  : "text-pane-text hover:bg-pane-text/[0.04]"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-pane-text truncate">
                  {getFileName(result.file_path)}
                </span>
                <span className="text-pane-text-secondary shrink-0">
                  :{result.line_number}
                </span>
                <span className="text-pane-text-secondary truncate flex-1 text-[10px]">
                  {result.file_path}
                </span>
              </span>
              <span className="text-pane-text-secondary truncate">
                {result.line_content.trim()}
              </span>
            </button>
          ))}
          {results.length === 0 && query.length >= 2 && !isSearching && (
            <p className="px-3 py-4 text-pane-text-secondary text-xs font-mono text-center">
              No matches found
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
