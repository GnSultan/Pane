import { useState, useCallback, useRef, useEffect, useLayoutEffect, forwardRef, useImperativeHandle } from "react";
import { measureCaretPos } from "../../lib/measure-caret";

export interface CaretTextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minHeight?: number;
  maxHeight?: number;
  autoResize?: boolean;
}

export const CaretTextArea = forwardRef<HTMLTextAreaElement, CaretTextAreaProps>(
  ({ value = "", onChange, onFocus, onBlur, onKeyDown, onScroll, placeholder, className, style, minHeight = 56, maxHeight = 400, autoResize = true, ...props }, ref) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const [caretPos, setCaretPos] = useState<{ top: number; left: number; lineHeight: number } | null>(null);
    const [focused, setFocused] = useState(false);

    useImperativeHandle(ref, () => internalRef.current!);

    const updateCaret = useCallback(() => {
      const el = internalRef.current;
      const container = containerRef.current;
      const overlay = overlayRef.current;
      if (!el || !container || !overlay || document.activeElement !== el) {
        setCaretPos(null);
        return;
      }
      setCaretPos(measureCaretPos(el, container, overlay));
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

    return (
      <div ref={containerRef} className={`relative overflow-hidden ${className || ""}`}>
        <textarea
          {...props}
          ref={internalRef}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
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
            if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
            onScroll?.(e);
          }}
          className="w-full bg-transparent text-transparent resize-none outline-none border-none m-0 block"
          style={{
            ...sharedStyle,
            caretColor: "transparent",
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
          }}
        />
        
        {/* Visible Overlay */}
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none overflow-hidden"
          style={{
            ...sharedStyle,
            color: "var(--pane-text)",
          }}
        >
          <span>{value}</span>
          {/* Invisible trailing character keeps scrollHeight stable */}
          <span aria-hidden> </span>
        </div>

        {/* Custom Caret */}
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
