/**
 * measureCaretPos — Measure caret position using a zero-height marker
 * aligned to the top of the line box.
 *
 * Clones textarea content into a hidden mirror, then inserts an
 * inline-block marker after the text before the cursor.  The marker
 * uses `vertical-align: top` and `height: 0`, so its
 * getBoundingClientRect().top is exactly the top of the line box —
 * not a character's glyph box (period baseline) and not a broken
 * rect from an empty text node.
 *
 * This works for empty text (marker is the only child) and wrapped
 * lines (afterText ensures correct wrapping).
 */
export function measureCaretPos(
  el: HTMLTextAreaElement,
  container: HTMLElement,
): { top: number; left: number; lineHeight: number; fontSize: number } | null {
  const sel = el.selectionStart;
  if (sel === null) return null;

  const computed = window.getComputedStyle(el);
  const containerRect = container.getBoundingClientRect();
  const scrollTop = el.scrollTop;
  const scrollLeft = el.scrollLeft || 0;

  const fontSize = parseFloat(computed.fontSize) || 15;
  const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.75;
  const paddingTop = parseFloat(computed.paddingTop) || 0;
  const paddingLeft = parseFloat(computed.paddingLeft) || 0;
  const paddingRight = parseFloat(computed.paddingRight) || 0;

  // Mirror — exact clone of textarea rendering
  const mirror = document.createElement('div');
  mirror.style.cssText = [
    "position: absolute; top: 0; left: 0; pointer-events: none; visibility: hidden;",
    "white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;",
    `width: ${el.clientWidth}px;`,
    `font-size: ${fontSize}px;`,
    `line-height: ${lineHeight}px;`,
    `font-family: ${computed.fontFamily};`,
    `padding: ${paddingTop}px ${paddingRight}px 0 ${paddingLeft}px;`,
    "border: 0;",
    "box-sizing: border-box;",
  ].join(" ");
  container.appendChild(mirror);

  try {
    const beforeText = el.value.slice(0, sel);
    const afterText = el.value.slice(sel);

    if (beforeText) {
      mirror.appendChild(document.createTextNode(beforeText));
    }

    // Zero-height inline-block aligned to line top.
    // Its bounding box top IS the line top.
    const marker = document.createElement('span');
    marker.style.display = 'inline-block';
    marker.style.width = '0';
    marker.style.height = '0';
    marker.style.overflow = 'hidden';
    marker.style.verticalAlign = 'top';
    mirror.appendChild(marker);

    if (afterText) {
      mirror.appendChild(document.createTextNode(afterText));
    }

    const markerRect = marker.getBoundingClientRect();

    return {
      top: markerRect.top - containerRect.top - scrollTop,
      left: markerRect.left - containerRect.left - scrollLeft,
      lineHeight,
      fontSize,
    };
  } finally {
    mirror.remove();
  }
}
