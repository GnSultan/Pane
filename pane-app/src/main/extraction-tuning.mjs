/**
 * Extraction Tuning — Layer 4 (LLM fallback) + Layer 5 (learning loop)
 *
 * Complements the regex extraction in session-context.mjs with:
 *   Layer 4 — LLM-powered fallback when regex yields too little structured signal
 *   Layer 5 — per-source confidence adjustment based on historical correction rates
 *
 * Base confidence values live here. session-context.mjs imports them and
 * uses them when tagging extracted items. The feedback loop updates effective
 * confidence over time as models correct previous session claims.
 *
 * Feedback stored at: ~/.pane/session/{projectId}/extraction-feedback.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".pane", "session");

// ---------------------------------------------------------------------------
// Base confidence map — factory defaults per extraction source.
// These are the starting values. recordCorrections() adjusts them downward
// as sessions accumulate correction signal.
// ---------------------------------------------------------------------------

export const BASE_CONFIDENCE = {
  // Regex extraction — explicit marker at line start (highest signal)
  marker_checkmark:    0.95,  // ✓ at line start
  marker_outcome:      0.90,  // fixed: / solved: at line start
  marker_completion:   0.85,  // completed: / implemented: at line start

  // Blockers
  marker_warning:      0.95,  // ⚠ at line start
  marker_blocker:      0.90,  // blocker: / blocked on: at line start
  marker_failure:      0.80,  // failed to: at line start

  // Next steps
  marker_next:         0.90,  // next: at line start
  symbol_arrow:        0.80,  // → at line start
  marker_proceed:      0.75,  // will proceed: / coming up: at line start

  // Discoveries
  marker_discovery:    0.90,  // discovered: / realized: at line start
  marker_learned:      0.85,  // learned: at line start
  marker_insight:      0.80,  // insight: at line start

  // Corrections (Layer 5 capture)
  correction_explicit: 0.90,  // actually: / correction: at line start
  correction_resolved: 0.85,  // already resolved: / not accurate: at line start

  // State-derived (from session state, not model output)
  state_action:        0.80,  // recentActions type=file_edit
  state_command:       0.70,  // recentActions type=command
  state_decision:      0.90,  // recentActions type=decision
  state_todo:          0.85,  // pending todos

  // LLM fallback (Layer 4)
  llm_fallback:        0.70,  // LLM extraction when regex found too little

  // Legacy / unknown
  legacy:              0.50,  // old-format string items from pre-L3 handoffs
};

// ---------------------------------------------------------------------------
// Feedback storage
// ---------------------------------------------------------------------------

function feedbackPath(projectId) {
  return path.join(SESSION_DIR, projectId, "extraction-feedback.json");
}

function readFeedback(projectId) {
  try {
    return JSON.parse(fs.readFileSync(feedbackPath(projectId), "utf-8"));
  } catch {
    return { patterns: {}, lastUpdated: 0 };
  }
}

function writeFeedback(projectId, feedback) {
  try {
    fs.mkdirSync(path.join(SESSION_DIR, projectId), { recursive: true });
    fs.writeFileSync(feedbackPath(projectId), JSON.stringify(feedback, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[extraction-tuning] writeFeedback: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Effective confidence — base confidence adjusted by historical correction rate
// ---------------------------------------------------------------------------

/**
 * Returns the effective confidence for a given source, adjusted by how often
 * claims from that source have been corrected by subsequent model sessions.
 *
 * Requires at least 10 hits before adjusting (prevents noisy early data from
 * collapsing confidence on day one).
 *
 * Formula: effectiveConf = base * (1 - min(correctionRate, 0.70))
 * Floor at 0.30 — nothing becomes permanently untrusted.
 *
 * @param {string} projectId
 * @param {string} source — key from BASE_CONFIDENCE
 * @returns {number} — effective confidence in [0.30, base]
 */
export function getEffectiveConfidence(projectId, source) {
  const base = BASE_CONFIDENCE[source] ?? 0.50;
  try {
    const feedback = readFeedback(projectId);
    const entry = feedback.patterns?.[source];
    if (!entry || entry.hits < 10) return base;
    const correctionRate = Math.min(entry.corrections / entry.hits, 0.70);
    return Math.max(0.30, base * (1 - correctionRate));
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// Correction recording (Layer 5 write path)
// ---------------------------------------------------------------------------

/**
 * Match a correction text to the source tag of the item it likely refers to
 * in the previous handoff, using a generous substring overlap heuristic.
 *
 * @param {string} correctionText
 * @param {object} previousHandoff
 * @returns {string|null} — matched source key, or null
 */
function matchCorrectionToSource(correctionText, previousHandoff) {
  if (!correctionText || !previousHandoff) return null;

  const lower = correctionText.toLowerCase();
  const fields = ["accomplishment", "blockers", "nextSteps", "findings"];

  for (const field of fields) {
    for (const item of previousHandoff[field] || []) {
      const itemText = (typeof item === "string" ? item : item?.text || "").toLowerCase();
      if (!itemText) continue;
      // Match if 30% of the shorter string appears in the other
      const minLen = Math.min(lower.length, itemText.length);
      const window = Math.max(8, Math.floor(minLen * 0.30));
      if (
        lower.includes(itemText.slice(0, window)) ||
        itemText.includes(lower.slice(0, window))
      ) {
        return typeof item === "object" ? (item.source || "legacy") : "legacy";
      }
    }
  }
  return null;
}

/**
 * Record model corrections against the previous handoff.
 * Updates extraction-feedback.json with hit/correction counts per source.
 *
 * Called at session end when extracted corrections is non-empty.
 * Pure side effect — does not modify the handoff.
 *
 * @param {string} projectId
 * @param {ScoredItem[]} corrections — items captured by correction patterns
 * @param {object} previousHandoff — the handoff injected at session start (before overwrite)
 */
export function recordCorrections(projectId, corrections, previousHandoff) {
  if (!corrections?.length || !previousHandoff) return;

  const feedback = readFeedback(projectId);
  if (!feedback.patterns) feedback.patterns = {};

  // Count which source types were shown to the model (hit tracking)
  const shownSources = new Set();
  for (const field of ["accomplishment", "blockers", "nextSteps", "findings"]) {
    for (const item of previousHandoff[field] || []) {
      const src = typeof item === "object" ? (item.source || "legacy") : "legacy";
      shownSources.add(src);
    }
  }

  for (const src of shownSources) {
    if (!feedback.patterns[src]) feedback.patterns[src] = { hits: 0, corrections: 0 };
    feedback.patterns[src].hits += 1;
  }

  // Match each correction to a source and record it
  for (const correction of corrections) {
    const matchedSource = matchCorrectionToSource(correction.text, previousHandoff);
    if (matchedSource && feedback.patterns[matchedSource]) {
      feedback.patterns[matchedSource].corrections += 1;
    }
  }

  feedback.lastUpdated = Date.now();
  writeFeedback(projectId, feedback);
}

// ---------------------------------------------------------------------------
// LLM fallback extraction (Layer 4)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are a session extraction tool. Extract structured information from AI assistant output.
Return ONLY valid JSON — no prose, no markdown, no explanation.
Format: {"accomplishments":["..."],"blockers":["..."],"nextSteps":["..."],"discoveries":["..."]}
Rules:
- Only include items you are confident about
- Each item is a concrete, specific statement under 100 chars
- No trailing periods
- Use empty arrays when a category has nothing clear`;

/**
 * LLM-powered extraction fallback.
 *
 * Fires only when regex extraction yields < 2 high-confidence items and the
 * session text is substantial enough to warrant an LLM call. This catches
 * sessions where the model described accomplishments in natural prose without
 * using explicit markers (✓, fixed:, next:, etc.).
 *
 * Items returned have confidence 0.70 and source "llm_fallback".
 *
 * @param {string} sessionText — accumulated model output for the session
 * @param {Function|null} quickCallFn — (systemPrompt, userPrompt) => Promise<string>
 *   Pass null to skip (CLI workers, offline mode, etc.)
 * @returns {Promise<object>} — same shape as extractFromModelOutput() return value
 */
export async function extractWithLLM(sessionText, quickCallFn) {
  if (!quickCallFn || !sessionText) return {};

  // Focus on the conclusion — last 3000 chars contain the summary/wrap-up
  const snippet = sessionText.length > 3000
    ? `[...]\n${sessionText.slice(-3000)}`
    : sessionText;

  try {
    const result = await Promise.race([
      quickCallFn(EXTRACTION_SYSTEM, `Session output:\n${snippet}`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("llm_extraction_timeout")), 8000)
      ),
    ]);

    if (!result || typeof result !== "string") return {};

    // Strip markdown fences the model might add despite instructions
    const stripped = result
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```\s*$/im, "")
      .trim();

    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return {};

    const parsed = JSON.parse(match[0]);

    const toScored = (arr, cap = 5) =>
      (Array.isArray(arr) ? arr : [])
        .filter(s => typeof s === "string" && s.trim().length > 3)
        .slice(0, cap)
        .map(text => ({
          text: text.trim().slice(0, 100),
          confidence: 0.70,
          source: "llm_fallback",
        }));

    return {
      accomplishments: toScored(parsed.accomplishments, 5),
      blockers:        toScored(parsed.blockers, 3),
      nextSteps:       toScored(parsed.nextSteps, 3),
      discoveries:     toScored(parsed.discoveries, 5),
      corrections:     [],
    };
  } catch {
    return {}; // Graceful degradation — regex results stand
  }
}

/**
 * Count items with confidence at or above a threshold across all extraction fields.
 * Used to decide whether to trigger the LLM fallback.
 *
 * @param {object} extracted — return value of extractFromModelOutput()
 * @param {number} threshold — default 0.75
 * @returns {number}
 */
export function countHighConfidence(extracted, threshold = 0.75) {
  let count = 0;
  for (const field of ["accomplishments", "blockers", "nextSteps", "discoveries"]) {
    for (const item of extracted[field] || []) {
      if ((item.confidence ?? 0) >= threshold) count++;
    }
  }
  return count;
}
