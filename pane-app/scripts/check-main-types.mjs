/**
 * Typecheck gate for the main process — all .mjs sources under src/main.
 *
 * The 51K-line main-process core was historically unguarded — the renderer
 * tsconfig never covered it. checkJs over that volume surfaces 400+ inference
 * errors (JSDoc gaps, union narrowing noise — all verified runtime-safe, none
 * are parse failures). Fixing every one in one pass would touch half the
 * core; suppressing them per-file would hide real errors. So: a ratchet.
 *
 * The baseline records the current error count. This gate FAILS when the
 * count grows — no new type unsoundness enters the main process. It prints
 * a diff against the baseline. When errors are fixed deliberately, run
 * `npm run typecheck:main:update` to lower the baseline.
 *
 * Usage:
 *   npm run typecheck:main            (gate — fails on regression)
 *   npm run typecheck:main:update     (re-baseline after deliberate fixes)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baselinePath = path.join(root, "tsconfig.main.baseline");
const updateMode = process.argv.includes("--update");

let output;
try {
  output = execFileSync(
    "npx",
    ["tsc", "-p", "tsconfig.main.json", "--pretty", "false"],
    { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  // tsc exits non-zero when errors exist — that's the expected signal here
  output = err.stdout ?? String(err.message ?? "");
  if (!output || output.length < 10) {
    console.error("[typecheck:main] tsc produced no output — aborting (real failure?)");
    console.error(err.stderr ?? "");
    process.exit(2);
  }
}

const errors = output
  .split("\n")
  .filter((line) => /error TS\d+:/.test(line));

// tsc syntax-failure bail-outs print without a file prefix — a count of zero
// with non-empty output means the project didn't even parse; treat as failure.
const baseline = fs.existsSync(baselinePath)
  ? Number(fs.readFileSync(baselinePath, "utf-8").trim())
  : null;

if (updateMode) {
  fs.writeFileSync(baselinePath, `${errors.length}\n`);
  console.log(
    `[typecheck:main] baseline updated: ${baseline} → ${errors.length} errors`,
  );
  process.exit(0);
}

if (baseline === null || Number.isNaN(baseline)) {
  // First run: establish the baseline rather than failing on history.
  fs.writeFileSync(baselinePath, `${errors.length}\n`);
  console.log(
    `[typecheck:main] baseline established at ${errors.length} errors (tsconfig.main.baseline). Gate is now active.`,
  );
  process.exit(0);
}

console.log(`[typecheck:main] baseline: ${baseline} · current: ${errors.length}`);
if (errors.length > baseline) {
  console.error(
    `[typecheck:main] REGRESSION: ${errors.length - baseline} new type error(s) in the main process.`,
  );
  // Show only the NEW overflow for triage — the head of the list the
  // baseline already accepted is noise here.
  const overflow = errors.slice(baseline);
  for (const line of overflow.slice(0, 40)) console.error("  " + line);
  if (overflow.length > 40)
    console.error(`  … and ${overflow.length - 40} more`);
  console.error(
    "\nFix the errors, or if they are deliberate and understood, re-baseline with: npm run typecheck:main:update",
  );
  process.exit(1);
}
if (errors.length < baseline) {
  console.log(
    `[typecheck:main] improvement: ${baseline - errors.length} fewer than baseline. Re-baseline with npm run typecheck:main:update to lock it in.`,
  );
}
console.log("[typecheck:main] gate passed — no new main-process type errors.");
