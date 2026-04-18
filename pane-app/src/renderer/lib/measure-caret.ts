/**
 * measureCaretPos — Range-based caret position measurement.
 *
 * Queries a collapsed Range directly on the overlay text node — the same
 * element the user actually sees.  Range.getClientRects() returns the exact
 * sub-pixel insertion-point rect with no font/wrap approximation possible.
 *
 * Requirements:
 *   container  — the `position: relative` wrapper that both the textarea
 *                and the overlay live inside.
 *   overlay    — an absolutely-positioned div whose first child is a <span>
 *                containing the textarea's value text.  Its scrollTop must
 *                be kept in sync with the textarea's scrollTop via onScroll.
 */
export function measureCaretPos(
  el: HTMLTextAreaElement,
  container: HTMLElement,
  overlay: HTMLElement,
): { top: number; left: number; lineHeight: number } | null {
  const sel = el.selectionStart;
  if (sel === null) return null;

  const computed = window.getComputedStyle(el);
  const caretH = parseFloat(computed.fontSize) || 15;
  const containerRect = container.getBoundingClientRect();

  // The overlay structure: <div> <span>{value}</span> … </div>
  const textSpan = overlay.firstElementChild as HTMLElement | null;
  const textNode = textSpan?.firstChild;

  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const originalValue = textNode.nodeValue || "";
    const selStart = Math.min(sel, originalValue.length);
    const range = document.createRange();
    
    // First attempt: direct measurement
    range.setStart(textNode, selStart);
    range.setEnd(textNode, selStart);
    let rects = range.getClientRects();

    // Second attempt: if zero rects (trailing newline edge case), 
    // temporarily insert a dummy char to force a layout box.
    if (rects.length === 0) {
      textNode.nodeValue = originalValue.slice(0, selStart) + "\u200B" + originalValue.slice(selStart);
      range.setStart(textNode, selStart);
      range.setEnd(textNode, selStart + 1);
      rects = range.getClientRects();
      // Restore original value immediately
      textNode.nodeValue = originalValue;
    }

    const r = rects[0];
    if (r) {
      // Render the caret slightly taller than the raw cap-height so it reads
      // clearly at any font size.  Re-centre top so it stays visually balanced
      // within the line box (r.height = full leading, caretH = font-size).
      const renderH = caretH + 4;
      return {
        top: r.top - containerRect.top + (r.height - renderH) / 2,
        left: r.left - containerRect.left,
        lineHeight: renderH,
      };
    }
  }

  // Fallback for empty textarea or edge cases: anchor to text span origin.
  if (textSpan) {
    const r = textSpan.getBoundingClientRect();
    return {
      top: r.top - containerRect.top,
      left: r.left - containerRect.left,
      lineHeight: caretH + 4,
    };
  }

  return null;
}
