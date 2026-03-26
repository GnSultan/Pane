import { useEffect, useRef, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { detectProjectRoot } from "../../lib/tauri-commands";

import type { ElectronAPI } from "../../lib/electron";

const electronAPI = window.electronAPI as ElectronAPI;

interface Props {
  onClose: () => void;
}

// Resolve what the user typed into a real absolute path.
// "myapp"        → ~/myapp
// "dev/myapp"    → ~/dev/myapp
// "~/dev/myapp"  → ~/dev/myapp (tilde preserved for IPC to resolve)
// "/abs/path"    → /abs/path
function resolvePath(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (t.startsWith("/") || t.startsWith("~/")) return t;
  return "~/" + t;
}

export function NewThreadPicker({ onClose }: Props) {
  const addProject = useProjectsStore((s) => s.addProject);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleCreate = async () => {
    const path = resolvePath(value);
    if (!path) return;
    setError("");
    try {
      const created = await electronAPI.invoke("create-directory", path);
      addProject(created as string);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "failed");
    }
  };

  const handleBrowse = async () => {
    onClose();
    const selected = await electronAPI.invoke("open-directory-dialog");
    if (selected && typeof selected === "string") {
      const root = await detectProjectRoot(selected);
      addProject(root);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center h-8 px-2 gap-1.5">
        <span
          className="text-pane-text-secondary/40 shrink-0 select-none"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
        >
          ~/
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
          }}
          placeholder="project name"
          className="flex-1 min-w-0 bg-transparent outline-none text-pane-text-secondary
                     placeholder:text-pane-text-secondary/30"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
        />
        <button
          onClick={handleBrowse}
          className="shrink-0 text-pane-text-secondary/30 hover:text-pane-text-secondary transition-colors"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
        >
          browse
        </button>
      </div>
      {error && (
        <span
          className="px-2 pb-1 text-pane-error"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size-xs, 10px)" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
