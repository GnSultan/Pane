import { useEffect, useRef, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { detectProjectRoot, rebindProject } from "../../lib/tauri-commands";

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

type Step = "name" | "bind";

export function NewThreadPicker({ onClose }: Props) {
  const addProject = useProjectsStore((s) => s.addProject);
  const storeRebindProject = useProjectsStore((s) => s.rebindProject);

  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (step === "bind") onClose();
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, step]);

  // Step 1: create the thread with just a name (no folder)
  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name is required");
      return;
    }
    setError("");
    const id = addProject("", undefined, trimmed);
    setCreatedId(id);
    setStep("bind");
  };

  // Step 2a: create a new folder and bind it
  const handleCreateFolder = async () => {
    if (!createdId) return;
    const path = resolvePath(name);
    if (!path) return;
    setError("");
    try {
      const created = await electronAPI.invoke("create-directory", path);
      const root = await detectProjectRoot(created as string);
      await rebindProject(createdId, "", root);
      storeRebindProject(createdId, root);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "failed to create folder");
    }
  };

  // Step 2b: browse existing folder and bind it
  const handleBrowseExisting = async () => {
    if (!createdId) return;
    const selected = await electronAPI.invoke("open-directory-dialog");
    if (selected && typeof selected === "string") {
      const root = await detectProjectRoot(selected);
      await rebindProject(createdId, "", root);
      storeRebindProject(createdId, root);
      onClose();
    }
  };

  // Step 2c: skip binding — thread stays rootless
  const handleSkip = () => {
    onClose();
  };

  // Step 1: Name the thread
  if (step === "name") {
    return (
      <div className="flex flex-col">
        <div className="flex items-center h-8 px-2 gap-1.5">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
            }}
            placeholder="thread name"
            className="flex-1 min-w-0 bg-transparent outline-none text-pane-text-secondary
                       placeholder:text-pane-text-secondary/30"
            style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
          />
          <button
            onClick={handleCreate}
            className="shrink-0 text-pane-text-secondary/50 hover:text-pane-text transition-colors"
            style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
          >
            create
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

  // Step 2: Bind a folder
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <span
        className="text-pane-text-secondary/60"
        style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size-xs, 10px)" }}
      >
        &ldquo;{name}&rdquo; created — bind a folder?
      </span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleCreateFolder}
          className="text-pane-text-secondary/50 hover:text-pane-text transition-colors"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
        >
          new folder
        </button>
        <span
          className="text-pane-text-secondary/30"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
        >
          ~/{name || "project"}
        </span>
      </div>
      <button
        onClick={handleBrowseExisting}
        className="text-left text-pane-text-secondary/50 hover:text-pane-text transition-colors"
        style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
      >
        browse existing&hellip;
      </button>
      <button
        onClick={handleSkip}
        className="text-left text-pane-text-secondary/30 hover:text-pane-text-secondary/60 transition-colors"
        style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size)" }}
      >
        skip for now
      </button>
      {error && (
        <span
          className="text-pane-error"
          style={{ fontFamily: "var(--font-geist-mono)", fontSize: "var(--pane-panel-font-size-xs, 10px)" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
