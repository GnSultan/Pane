import { useState, useCallback, useRef, useEffect, useLayoutEffect, forwardRef, useImperativeHandle } from "react";
import { measureCaretPos } from "../../lib/measure-caret";

/** Image MIME types the canvas pipeline can decode + re-encode losslessly-enough
 *  for inline attachment. Animated GIF, SVG, and TIFF intentionally excluded —
 *  they keep the file-path route so the original file stays intact. */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
]);

export interface CaretTextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minHeight?: number;
  maxHeight?: number;
  autoResize?: boolean;
  /** Called when files/folders are dropped onto the textarea. paths are absolute filesystem paths. */
  onDropFiles?: (paths: string[]) => void;
  /** Called when an image is pasted from the clipboard or dropped as a file.
   *  sourceName carries the dropped file's name (undefined for clipboard). */
  onPasteImage?: (blob: Blob, sourceName?: string) => void;
}

export const CaretTextArea = forwardRef<HTMLTextAreaElement, CaretTextAreaProps>(
  ({ value = "", onChange, onFocus, onBlur, onKeyDown, onScroll, placeholder, className, style, minHeight = 56, maxHeight = 400, autoResize = true, onDropFiles, onPasteImage, ...props }, ref) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [caretPos, setCaretPos] = useState<{ top: number; left: number; lineHeight: number; fontSize: number } | null>(null);
    const [focused, setFocused] = useState(false);

    useImperativeHandle(ref, () => internalRef.current!);

    const updateCaret = useCallback(() => {
      const el = internalRef.current;
      const container = containerRef.current;
      if (!el || !container || document.activeElement !== el) {
        setCaretPos(null);
        return;
      }
      setCaretPos(measureCaretPos(el, container));
    }, []);

    const applyHeight = useCallback(() => {
      if (!autoResize) return;
      const el = internalRef.current;
      if (!el) return;
      el.style.height = "1px";
      const newHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
      el.style.height = `${newHeight}px`;
      
      // Auto-scroll when typing at the very end
      if (el.selectionEnd >= el.value.length - 1) {
        el.scrollTop = el.scrollHeight;
      }
    }, [autoResize, minHeight, maxHeight]);

    useLayoutEffect(() => {
      applyHeight();
      if (focused) updateCaret();
    }, [value, focused, applyHeight, updateCaret]);

    useEffect(() => {
      const el = internalRef.current;
      if (!el) return;
      const events = ["click", "keyup", "mouseup", "select", "scroll"];
      const handler = () => updateCaret();
      events.forEach(e => el.addEventListener(e, handler));
      return () => events.forEach(e => el.removeEventListener(e, handler));
    }, [updateCaret]);

    useEffect(() => {
      const handler = () => {
        if (document.activeElement === internalRef.current) updateCaret();
      };
      document.addEventListener("selectionchange", handler);
      return () => document.removeEventListener("selectionchange", handler);
    }, [updateCaret]);

    const sharedStyle: React.CSSProperties = {
      fontSize: style?.fontSize || "var(--pane-font-size)",
      lineHeight: style?.lineHeight || "1.75",
      fontFamily: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'Fira Code', Consolas, monospace",
      padding: style?.padding || "1rem 1.25rem 0.75rem 1.25rem",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      boxSizing: "border-box",
      ...style,
    };

    // Drag-and-drop: extract filesystem paths from dropped files
    const [dragOver, setDragOver] = useState(false);
    const dragEnabled = Boolean(onDropFiles || onPasteImage);
    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.types.includes("Files")) {
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }
    }, []);
    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Only set false if we're leaving the container itself (not a child)
      if (e.currentTarget === e.target) setDragOver(false);
    }, []);
    const handleDrop = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!onDropFiles) return;
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string };
        // In sandboxed renderers File.path is undefined; webUtils (exposed via
        // preload) is the supported replacement. It must be called synchronously
        // with the live File object.
        const filePath = file.path ?? window.electronAPI?.getPathForFile?.(file);
        if (!filePath) continue;
        // Canvas-encodable images become inline attachments (same pipeline as
        // paste). Others keep the path route: animated GIFs would lose motion
        // in a canvas re-encode, and SVG/TIFF aren't decodable everywhere —
        // the model can still view_image the original file by path.
        if (onPasteImage && INLINE_IMAGE_TYPES.has(file.type)) {
          onPasteImage(file, file.name);
        } else {
          paths.push(filePath);
        }
      }
      if (paths.length > 0) onDropFiles(paths);
    }, [onDropFiles, onPasteImage]);

    // Clipboard image paste — pull image blobs out before the default paste
    // (which would do nothing useful with binary). Text pastes pass through.
    const handlePaste = useCallback((e: React.ClipboardEvent) => {
      if (!onPasteImage) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            onPasteImage(blob);
            return;
          }
        }
      }
    }, [onPasteImage]);

    return (
      <div
        ref={containerRef}
        className={`relative overflow-hidden ${className || ""}`}
        onDragOver={dragEnabled ? handleDragOver : undefined}
        onDragLeave={dragEnabled ? handleDragLeave : undefined}
        onDrop={dragEnabled ? handleDrop : undefined}
      >
        {/* Drop indicator — dashed accent border when dragging files over */}
        {dragOver && (
          <div
            aria-hidden
            className="absolute inset-0 z-10 pointer-events-none rounded-xl flex items-center justify-center"
            style={{
              border: "2px dashed var(--pane-accent)",
              background:
                "color-mix(in oklab, var(--pane-bg) 82%, transparent)",
            }}
          >
            <span
              className="text-xs"
              style={{ color: "var(--pane-accent)" }}
            >
              {onPasteImage
                ? "drop images to attach · drop files to insert paths"
                : "drop files to insert paths"}
            </span>
          </div>
        )}
        <textarea
          {...props}
          ref={internalRef}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          onFocus={(e) => {
            setFocused(true);
            updateCaret();
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            setCaretPos(null);
            onBlur?.(e);
          }}
          onScroll={(e) => {
            updateCaret();
            onScroll?.(e);
          }}
          className="w-full bg-transparent resize-none outline-none border-none m-0 block placeholder:text-pane-text-secondary/25"
          style={{
            ...sharedStyle,
            color: "var(--pane-text)",
            caretColor: "transparent",
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
          }}
        />

        {/* Custom Caret — full line-height I-beam at the line top */}
        {focused && caretPos && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: caretPos.top,
              left: caretPos.left,
              width: 2,
              height: caretPos.lineHeight,
              background: "var(--pane-accent)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    );
  }
);

CaretTextArea.displayName = "CaretTextArea";
