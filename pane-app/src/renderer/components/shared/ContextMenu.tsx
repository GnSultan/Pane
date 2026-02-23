import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => onClose();
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay adding listeners so the current contextmenu event doesn't close it
    const timer = setTimeout(() => {
      window.addEventListener("click", handler);
      window.addEventListener("contextmenu", handler);
      window.addEventListener("keydown", keyHandler);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 8);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-pane-surface border border-pane-border py-1 min-w-[160px] shadow-lg"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.action();
            onClose();
          }}
          className={`w-full text-left px-3 py-1.5 text-xs font-mono
            ${
              item.danger
                ? "text-pane-error hover:bg-pane-error/10"
                : "text-pane-text hover:bg-pane-text/[0.04]"
            }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
