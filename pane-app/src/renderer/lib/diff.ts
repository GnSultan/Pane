/**
 * Lightweight line-level diff using LCS (Longest Common Subsequence).
 *
 * Used by the edit/replace tool rendering to show only what actually changed,
 * not a wholesale "old block struck through, new block below" replacement.
 *
 * Performance: O(n*m) time and space. Fine for tool inputs which are
 * typically under a few hundred lines.
 */

export type DiffType = "equal" | "remove" | "add";

export interface DiffLine {
  type: DiffType;
  text: string;
  /** 1-based line number in the old string, null for pure insertions */
  oldLine: number | null;
  /** 1-based line number in the new string, null for pure removals */
  newLine: number | null;
}

/**
 * Compute a line-level diff between two strings.
 * Returns an ordered list of diff lines (equal / remove / add).
 */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  const m = oldLines.length;
  const n = newLines.length;

  // Trivial cases — avoid allocating a DP table
  if (m === 0 && n === 0) return [];
  if (m === 0) {
    return newLines.map((text, i) => ({
      type: "add" as const,
      text,
      oldLine: null,
      newLine: i + 1,
    }));
  }
  if (n === 0) {
    return oldLines.map((text, i) => ({
      type: "remove" as const,
      text,
      oldLine: i + 1,
      newLine: null,
    }));
  }
  if (oldStr === newStr) {
    return oldLines.map((text, i) => ({
      type: "equal" as const,
      text,
      oldLine: i + 1,
      newLine: i + 1,
    }));
  }

  // LCS DP table — dp[i][j] = LCS length of oldLines[0..i-1], newLines[0..j-1]
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () =>
    new Uint16Array(n + 1),
  );

  for (let i = 1; i <= m; i++) {
    const oldLine = oldLines[i - 1]!;
    const dpRow = dp[i]!;
    const dpPrev = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (oldLine === newLines[j - 1]) {
        dpRow[j] = dpPrev[j - 1]! + 1;
      } else {
        dpRow[j] = Math.max(dpPrev[j]!, dpRow[j - 1]!);
      }
    }
  }

  // Backtrack through the table to produce the diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    const oldLine = oldLines[i - 1]!;
    const newLine = newLines[j - 1]!;
    if (oldLine === newLine) {
      result.unshift({ type: "equal", text: oldLine, oldLine: i, newLine: j });
      i--;
      j--;
    } else if ((dp[i - 1]![j] ?? 0) >= (dp[i]![j - 1] ?? 0)) {
      result.unshift({ type: "remove", text: oldLine, oldLine: i, newLine: null });
      i--;
    } else {
      result.unshift({ type: "add", text: newLine, oldLine: null, newLine: j });
      j--;
    }
  }

  // Remaining old lines (deletions)
  while (i > 0) {
    result.unshift({ type: "remove", text: oldLines[i - 1]!, oldLine: i, newLine: null });
    i--;
  }

  // Remaining new lines (insertions)
  while (j > 0) {
    result.unshift({ type: "add", text: newLines[j - 1]!, oldLine: null, newLine: j });
    j--;
  }

  // Post-process: within each contiguous change hunk (no equal lines),
  // reorder so all removes come before adds. This produces the standard
  // "old struck through → new replacement" reading order.
  const ordered: DiffLine[] = [];
  let k = 0;
  while (k < result.length) {
    if (result[k]!.type === "equal") {
      ordered.push(result[k]!);
      k++;
      continue;
    }
    // Collect the contiguous hunk of non-equal lines
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (k < result.length && result[k]!.type !== "equal") {
      const line = result[k]!;
      if (line.type === "remove") removes.push(line);
      else adds.push(line);
      k++;
    }
    ordered.push(...removes, ...adds);
  }

  return ordered;
}
