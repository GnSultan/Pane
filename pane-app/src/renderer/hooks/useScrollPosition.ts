import { useEffect, useRef, type RefObject, type MutableRefObject } from "react";
import { loadScrollPositions, saveScrollPositions } from "../lib/tauri-commands";

// Shared across all Conversation instances — one load, one save file.
const posMap = new Map<string, number | "bottom">();

// Start loading immediately when the module is first imported.
let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = loadScrollPositions()
      .then((saved) => {
        for (const [id, pos] of Object.entries(saved)) {
          posMap.set(id, pos as number | "bottom");
        }
      })
      .catch(() => {});
  }
  return loadPromise;
}
// Kick off the load at import time so positions are ready before messages arrive.
ensureLoaded();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveScrollPositions(Object.fromEntries(posMap)).catch(() => {});
  }, 400);
}

export function useScrollPosition(
  projectId: string,
  scrollRef: RefObject<HTMLDivElement | null>,
  followRef: MutableRefObject<boolean>,
) {
  const appliedRef = useRef(false);

  // Restore saved position when messages first arrive from disk.
  // Safe to call on visibility:hidden elements — layout is still computed.
  const applyRestored = () => {
    const el = scrollRef.current;
    if (!el || appliedRef.current) return;
    appliedRef.current = true;

    const pos = posMap.get(projectId);
    if (typeof pos === "number") {
      el.scrollTop = pos;
      followRef.current = false;
    } else {
      // "bottom" or no saved position — scroll to bottom and stay in follow mode.
      el.scrollTop = el.scrollHeight;
      followRef.current = true;
    }
  };

  // Scroll listener: track position + update followRef + debounce save.
  // Replaces the old "re-engage follow" scroll listener.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const atBottom = scrollHeight - scrollTop - clientHeight < 10;
      followRef.current = atBottom;
      posMap.set(projectId, atBottom ? "bottom" : scrollTop);
      scheduleSave();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [projectId]);

  return { applyRestored };
}
