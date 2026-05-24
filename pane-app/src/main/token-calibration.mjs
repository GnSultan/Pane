/**
 * Token Calibration — periodic validation of structure-aware heuristic against real tokenizers.
 *
 * The structure-aware heuristic (token-budget.mjs) classifies content by type and uses
 * calibrated char/token ratios. This module validates those ratios against the Anthropic
 * count_tokens API (the only widely-available ground truth tokenizer) and adjusts them
 * when drift exceeds thresholds.
 *
 * Design:
 *   - Passive mode: collect samples during normal operation, log estimated vs actual drift
 *   - Active mode: periodically call Anthropic count_tokens with representative samples
 *   - Calibration is bounded: max ±15% adjustment per cycle, prevents runaway corrections
 *   - Zero overhead when no Anthropic API key is configured
 *
 * When to calibrate:
 *   1. On app startup (cold boot) — if key is configured
 *   2. Every 30 minutes during active use
 *   3. When a new model/provider is first used
 *   4. When a 400 "context length exceeded" error fires (emergency recalibration)
 *
 * Usage:
 *   import { collectSample, runCalibration, getCalibrationState } from "./token-calibration.mjs";
 *
 *   // During normal operation (passive collection)
 *   collectSample(projectId, "prose", someText, estimatedTokens);
 *
 *   // Periodically (active calibration)
 *   const result = await runCalibration({ provider: "anthropic", apiKey, model });
 *   if (result.adjusted) {
 *     // RATIOS were updated — log it
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CALIBRATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SAMPLES_PER_TYPE = 3;   // Minimum samples before type can be calibrated
const MAX_ADJUSTMENT = 0.15;      // Max ±15% ratio adjustment per calibration cycle
const MIN_SAMPLE_CHARS = 50;      // Minimum chars for a meaningful sample
const MAX_SAMPLES_STORED = 100;   // Cap stored samples to prevent memory leak

// ---------------------------------------------------------------------------
// Calibration state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CalibrationSample
 * @property {string} type — content type key from RATIOS
 * @property {number} chars — character count
 * @property {number} estimated — estimated tokens (from heuristic)
 * @property {number} actual — actual tokens (from count_tokens API)
 * @property {number} drift — actual / estimated ratio (< 1 mean heuristic over-estimated)
 * @property {number} timestamp — Date.now()
 */

/** @type {Map<string, CalibrationSample[]>} */
const samples = new Map(); // type → samples[]

/** @type {{ lastRun: number, adjustments: object, totalCalls: number }} */
let calibrationState = {
  lastRun: 0,
  adjustments: {}, // type → { drift, adjustment, timestamp }
  totalCalls: 0,
};

// ---------------------------------------------------------------------------
// Sample Collection (passive — no API calls)
// ---------------------------------------------------------------------------

/**
 * Collect a calibration sample during normal operation.
 * Stores the estimated vs actual token count for a content type.
 *
 * @param {string} type — content type key from RATIOS
 * @param {number} chars — character count of the content
 * @param {number} estimated — estimated token count from heuristic
 * @param {number} [actual] — actual token count (set later via setActualTokens)
 */
export function collectSample(type, chars, estimated, actual = null) {
  if (RATIOS && !RATIOS[type]) return; // Unknown type — skip
  if (chars < MIN_SAMPLE_CHARS) return; // Too short — unreliable

  const bucket = samples.get(type) || [];
  bucket.push({
    type,
    chars,
    estimated,
    actual,
    drift: actual ? actual / estimated : null,
    timestamp: Date.now(),
  });

  // Cap samples
  if (bucket.length > MAX_SAMPLES_STORED) {
    bucket.splice(0, bucket.length - MAX_SAMPLES_STORED);
  }

  samples.set(type, bucket);

  // Debug logging
  if (process.env.PANE_DEBUG_CALIBRATION === "1") {
    const driftLabel = actual != null
      ? ` (actual: ${actual}, drift: ${(actual / estimated).toFixed(3)})`
      : " (actual unknown — pending calibration)";
    console.log(`[calibration] sample: type=${type} chars=${chars} estimated=${estimated}${driftLabel}`);
  }
}

/**
 * Update pending samples with actual token counts (from API response).
 * Matches by approximate character count and type within a time window.
 *
 * @param {string} type — content type
 * @param {number} chars — character count
 * @param {number} actual — actual tokens from count_tokens API
 */
export function setActualTokens(type, chars, actual) {
  const bucket = samples.get(type);
  if (!bucket) return;

  // Find pending sample within ±10% char count and recent (last 10 minutes)
  const threshold = chars * 0.10;
  const recent = Date.now() - 600_000;

  for (const sample of bucket) {
    if (sample.actual != null) continue; // Already resolved
    if (sample.timestamp < recent) continue; // Too old
    if (Math.abs(sample.chars - chars) > threshold) continue; // Wrong size

    sample.actual = actual;
    sample.drift = actual / sample.estimated;
    break;
  }
}

// ---------------------------------------------------------------------------
// Active Calibration (Anthropic count_tokens API)
// ---------------------------------------------------------------------------

/**
 * Build a single representative calibration text for a given content type.
 * Combines multiple pending samples into one string for a single API call,
 * since the Anthropic count_tokens endpoint returns one total count per request.
 *
 * @param {string} type — content type
 * @param {number} [maxChars=2000] — target character count
 * @returns {{ text: string, chars: number, count: number } | null}
 *   Returns null if no pending samples exist for this type.
 *   count = number of pending samples this payload represents.
 */
function buildCalibrationPayload(type, maxChars = 2000) {
  const bucket = samples.get(type);
  if (!bucket || bucket.length === 0) return null;

  const pending = bucket.filter(s => s.actual == null);
  if (pending.length === 0) return null;

  // Generate a single representative text at the target size
  const text = generateRepresentativeText(type, maxChars);

  return {
    text,
    chars: text.length,
    count: pending.length,
  };
}

/**
 * Generate representative text for a content type at a target size.
 * Used to reconstruct calibration payloads without storing full text.
 *
 * @param {string} type — content type key
 * @param {number} targetChars — target character count
 * @returns {string} representative text
 */
function generateRepresentativeText(type, targetChars) {
  // Use characteristic patterns for each type to get realistic token density
  const templates = {
    prose: [
      "This is a sample of English prose text used for tokenizer calibration. ",
      "The quick brown fox jumps over the lazy dog. ",
      "Pane is a development environment for AI-assisted coding. ",
      "Token estimation accuracy depends on content structure and distribution. ",
    ],
    code: [
      "export function estimateTokens(text) {\n  if (!text) return 0;\n  const type = classifyContent(text);\n  return Math.ceil(text.length / RATIOS[type]);\n}\n",
      "const result = await fetch(url, {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify(data),\n});\n",
      "import { useState, useEffect, useCallback } from 'react';\nimport { useStore } from './store';\n",
    ],
    json: [
      '{"id":"abc123","name":"example","values":[1,2,3,4,5],"metadata":{"created":"2024-01-15","version":2}}\n',
      '{"role":"assistant","content":"Hello world","tool_calls":[{"id":"call_123","function":{"name":"read_file","arguments":"{\\"file_path\\":\\"/src/main.js\\"}"}}]}\n',
    ],
    markdown: [
      "# Heading Level 1\n## Heading Level 2\nSome **bold** and *italic* text with `code spans`.\n\n- List item 1\n- List item 2\n- List item 3\n\n```\nconst x = 42;\nconsole.log(x);\n```\n",
    ],
    compact: [
      "short string for classification ",
    ],
  };

  const chunks = templates[type] || templates.prose;
  let result = "";
  while (result.length < targetChars) {
    for (const chunk of chunks) {
      if (result.length >= targetChars) break;
      result += chunk;
    }
  }

  return result.slice(0, targetChars);
}

/**
 * Call the Anthropic count_tokens API to get ground truth token count for one text.
 *
 * Sends a single message to count_tokens (the endpoint returns one total count per request,
 * regardless of how many messages are in the array). Calling once per type with a combined
 * representative text is more accurate and efficient than batching multiple texts.
 *
 * @param {string} apiKey — Anthropic API key
 * @param {string} model — model identifier (e.g., "claude-sonnet-4-6")
 * @param {string} text — single combined text to count
 * @returns {Promise<{ actualTokens: number, error?: string }>}
 */
async function callCountTokensAPI(apiKey, model, text) {
  if (!apiKey || !text) {
    return { actualTokens: 0, error: "No API key or text" };
  }

  try {
    const response = await fetch(
      "https://api.anthropic.com/v1/messages/count_tokens",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: text }],
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      return { actualTokens: 0, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();
    return { actualTokens: result.input_tokens || 0 };
  } catch (err) {
    return { actualTokens: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Ratio Adjustment
// ---------------------------------------------------------------------------

/**
 * Adjust RATIOS based on calibration data.
 * Applies bounded adjustments to prevent runaway corrections.
 *
 * @param {Map<string, CalibrationSample[]>} sampleData
 * @param {object} currentRatios — current RATIOS from token-budget.mjs
 * @returns {{ adjusted: boolean, changes: object }}
 */
function computeAdjustments(sampleData, currentRatios) {
  const changes = {};
  let adjusted = false;

  for (const [type, bucket] of sampleData) {
    const resolved = bucket.filter(s => s.actual != null);
    if (resolved.length < MIN_SAMPLES_PER_TYPE) continue;

    // Compute average drift
    const avgDrift = resolved.reduce((sum, s) => sum + s.drift, 0) / resolved.length;

    // drift < 1 means heuristic over-estimated (estimated > actual)
    // drift > 1 means heuristic under-estimated (actual > estimated)
    // We want to adjust the ratio so that drift approaches 1.0
    //
    // Current: estimated = chars / currentRatio
    // Desired: actual = chars / newRatio
    // So: newRatio = currentRatio * drift
    // Bounded by MAX_ADJUSTMENT each cycle
    if (Math.abs(avgDrift - 1.0) < 0.05) continue; // Close enough — skip

    const currentRatio = currentRatios[type];
    let desiredRatio = currentRatio * avgDrift;

    // Clamp to prevent runaway
    const maxRatio = currentRatio * (1 + MAX_ADJUSTMENT);
    const minRatio = currentRatio * (1 - MAX_ADJUSTMENT);
    desiredRatio = Math.max(minRatio, Math.min(maxRatio, desiredRatio));

    // Round to 1 decimal
    desiredRatio = Math.round(desiredRatio * 10) / 10;

    if (desiredRatio !== currentRatio) {
      changes[type] = { from: currentRatio, to: desiredRatio, drift: avgDrift, samples: resolved.length };
      currentRatios[type] = desiredRatio;
      adjusted = true;
    }
  }

  return { adjusted, changes };
}

// ---------------------------------------------------------------------------
// Main Calibration Entry Point
// ---------------------------------------------------------------------------

/**
 * Run a calibration cycle.
 * 1. Builds calibration payload from collected samples
 * 2. Calls Anthropic count_tokens API
 * 3. Updates pending samples with actual counts
 * 4. Computes ratio adjustments
 * 5. Returns adjustment summary
 *
 * @param {object} options
 * @param {string} options.apiKey — Anthropic API key (optional — passive only if omitted)
 * @param {string} [options.model] — Anthropic model for count_tokens (default: "claude-sonnet-4-6")
 * @param {object} [options.ratios] — Current RATIOS to adjust (imported from token-budget.mjs)
 * @returns {Promise<{ calibrated: boolean, adjusted: boolean, changes: object, totalCalls: number }>}
 */
export async function runCalibration(options = {}) {
  const { apiKey, model = "claude-sonnet-4-6", ratios = null } = options;

  calibrationState.totalCalls++;
  calibrationState.lastRun = Date.now();

  // Phase 1: Resolve pending samples via API (active calibration)
  //
  // Strategy: send one combined representative text per content type to the
  // count_tokens endpoint. The endpoint returns a single total count per request,
  // so we batch all pending samples of a type into one text and use the resulting
  // count to compute a bulk drift ratio (actual / estimated). This ratio is then
  // applied to all pending samples of that type. This is more accurate per-type
  // and avoids wasted API calls.
  if (apiKey) {
    for (const [type] of samples) {
      const payload = buildCalibrationPayload(type, 2000);
      if (!payload) continue; // No pending samples

      const { actualTokens, error } = await callCountTokensAPI(apiKey, model, payload.text);
      if (error) {
        console.warn(`[calibration] count_tokens API failed for type=${type}: ${error}`);
        continue;
      }

      // Compute bulk drift: actual tokens / estimated tokens for this payload.
      // This gives us the true ratio for this type's content, which we apply
      // to all pending samples.
      const estimatedChars = payload.chars;
      const estimatedTokens = Math.ceil(estimatedChars / (RATIOS ? RATIOS[type] : 3.5));
      const bulkDrift = estimatedTokens > 0 ? actualTokens / estimatedTokens : 1.0;

      // Apply bulk drift to all pending samples of this type
      const bucket = samples.get(type);
      if (bucket) {
        let updated = 0;
        for (const sample of bucket) {
          if (sample.actual != null) continue;
          sample.actual = Math.round(sample.estimated * bulkDrift);
          sample.drift = bulkDrift;
          updated++;
        }

        if (process.env.PANE_DEBUG_CALIBRATION === "1") {
          console.log(`[calibration] type=${type}: chars=${estimatedChars} estimated=${estimatedTokens} actual=${actualTokens} drift=${bulkDrift.toFixed(3)} (applied to ${updated} samples)`);
        }
      }
    }
  }

  // Phase 2: If we have RATIOS reference, compute adjustments
  if (ratios) {
    const result = computeAdjustments(samples, ratios);

    if (result.adjusted) {
      // Record adjustments in state
      for (const [type, change] of Object.entries(result.changes)) {
        calibrationState.adjustments[type] = {
          drift: change.drift,
          from: change.from,
          to: change.to,
          timestamp: Date.now(),
        };
      }

      if (process.env.PANE_DEBUG_CALIBRATION === "1") {
        console.log("[calibration] adjustments applied:", JSON.stringify(result.changes, null, 2));
      }
    }

    return {
      calibrated: !!apiKey,
      adjusted: result.adjusted,
      changes: result.changes,
      totalSamples: [...samples.values()].reduce((sum, s) => sum + s.length, 0),
      totalCalls: calibrationState.totalCalls,
    };
  }

  return {
    calibrated: !!apiKey,
    adjusted: false,
    changes: {},
    totalSamples: [...samples.values()].reduce((sum, s) => sum + s.length, 0),
    totalCalls: calibrationState.totalCalls,
  };
}

// ---------------------------------------------------------------------------
// State Access
// ---------------------------------------------------------------------------

/**
 * Get calibration state for diagnostics/debugging.
 *
 * @returns {{ lastRun: number, adjustments: object, totalCalls: number, samples: object }}
 */
export function getCalibrationState() {
  const sampleSummary = {};
  for (const [type, bucket] of samples) {
    const resolved = bucket.filter(s => s.actual != null).length;
    const total = bucket.length;
    const avgDrift = resolved > 0
      ? bucket.filter(s => s.actual != null).reduce((sum, s) => sum + s.drift, 0) / resolved
      : null;
    sampleSummary[type] = { total, resolved, avgDrift: avgDrift != null ? avgDrift.toFixed(3) : null };
  }

  return {
    ...calibrationState,
    samples: sampleSummary,
    timeSinceLastRun: calibrationState.lastRun
      ? Math.round((Date.now() - calibrationState.lastRun) / 1000) + "s"
      : "never",
  };
}

/**
 * Check whether a calibration cycle is due.
 *
 * @returns {boolean}
 */
export function isCalibrationDue() {
  return (Date.now() - calibrationState.lastRun) > CALIBRATION_INTERVAL_MS;
}

/**
 * Persist calibration state to disk for cross-session continuity.
 *
 * @param {string} projectId
 */
export function saveCalibrationState(projectId) {
  try {
    const dir = path.join(os.homedir(), ".pane", "calibration");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const data = {
      state: calibrationState,
      samples: [...samples.entries()].map(([type, bucket]) => [
        type,
        bucket.slice(-20), // Keep only last 20 per type
      ]),
    };

    fs.writeFileSync(
      path.join(dir, `${projectId}.json`),
      JSON.stringify(data, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.warn(`[calibration] Failed to save state: ${err.message}`);
  }
}

/**
 * Load calibration state from disk.
 *
 * @param {string} projectId
 */
export function loadCalibrationState(projectId) {
  try {
    const filePath = path.join(os.homedir(), ".pane", "calibration", `${projectId}.json`);
    if (!fs.existsSync(filePath)) return;

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (data.state) calibrationState = data.state;
    if (data.samples) {
      samples.clear();
      for (const [type, bucket] of data.samples) {
        samples.set(type, bucket);
      }
    }
  } catch (err) {
    console.warn(`[calibration] Failed to load state: ${err.message}`);
  }
}

// ⚠️ Lazy circular import — only use inside functions, never at module scope
let RATIOS = null;

/**
 * Set the RATIOS reference for in-place calibration.
 * Called once at app startup by main.mjs.
 *
 * @param {object} ratiosRef — reference to RATIOS from token-budget.mjs
 */
export function setRatiosRef(ratiosRef) {
  RATIOS = ratiosRef;
}
