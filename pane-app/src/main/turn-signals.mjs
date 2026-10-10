/**
 * turn-signals.mjs — user-turn struggle/success detection.
 *
 * This is the half of the old heuristic-router.mjs that isn't routing:
 * regex detection of whether the user's message signals the previous
 * attempt failed or succeeded. It feeds thread-state's failure/escalation
 * tracking and steering-classifier's near-duplicate comparison — both of
 * which punk-engine drives independently of model routing.
 *
 * The routing half (complexity scoring, task-type/mode classification,
 * tier selection) was removed Oct 2026: autoRoute now resolves through
 * the user's power combo by phase (think → thinking slot, build →
 * execution slot), and escalation comes from thread-state, which already
 * owned the failure counter.
 */

// ── Text helpers ────────────────────────────────────────────────────────────

/**
 * DJB2 hash — fast, deterministic string hash.
 * @param {string} str
 * @returns {number}
 */
export function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // unsigned
}

/**
 * Word-gram Jaccard similarity, filtering words shorter than 4 characters.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
export function jaccardSimilarity(a, b) {
  const tokenize = (s) =>
    new Set(
      s
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 4),
    );

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Pattern sets (verbatim from heuristic-router.mjs — behavior-preserving) ─

export const FAILURE_PATTERNS = [
  /\bthat didn'?t work\b/i,
  /\bstill (broken|failing|not working|wrong|bugged)\b/i,
  /\btry again\b/i,
  /\bthat'?s wrong\b/i,
  /\bwrong\b/i,
  /\bnope\b/i,
  /\bnot right\b/i,
  /\bstill (getting|seeing|having)\b/i,
  /\bthe (error|issue|problem|bug) (is still|persists|remains)\b/i,
  /\bdoesn'?t (work|compile|build|run|pass)\b/i,
  /\bsame (error|issue|problem|bug)\b/i,
  /\bdidn'?t (fix|solve|help|change)\b/i,
  /\bno,?\s+(that|it)\b/i,
];

const APPROVAL_PATTERNS = [
  /^(yes|ok|okay|yep|yup|sure|do it|go ahead|proceed|perfect|nice|great|good|thanks|thank you|lgtm|looks good|ship it|awesome|exactly|correct)[\s!.]*$/i,
];

const SUCCESS_PATTERNS = [
  /\bthat (works|worked|fixed it|did it)\b/i,
  /\bnice(ly)?\b/i,
  /\bperfect\b/i,
  /\bthanks?\b/i,
  /\bthank you\b/i,
  /\bgreat\b/i,
  /\bawesome\b/i,
  /\blooks? good\b/i,
  /\blgtm\b/i,
  /\bship it\b/i,
  /\bwell done\b/i,
  /\bexactly\b/i,
  /\bcorrect\b/i,
  /\bnow (let'?s|can you|could you|I want)\b/i, // moving on to new topic
];

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect if the incoming message signals that the previous attempt failed.
 * Called BEFORE routing to update escalation state.
 *
 * @param {string} message — the user's current message
 * @param {number|null} lastPromptHash — djb2 hash of the previous user prompt
 * @param {string|null} lastPromptText — text of the previous user prompt
 * @returns {{ isFailure: boolean, type: string|null }}
 */
export function detectFailureSignals(message, lastPromptHash, lastPromptText) {
  const trimmed = message.trim();

  // Never flag approvals/confirmations as failures
  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(trimmed)) return { isFailure: false, type: null };
  }

  // Check explicit failure language
  for (const pat of FAILURE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { isFailure: true, type: "explicit" };
    }
  }

  // Check near-duplicate prompt (user re-sending the same thing)
  if (lastPromptText && trimmed.length > 10) {
    const similarity = jaccardSimilarity(trimmed, lastPromptText);
    if (similarity > 0.75) {
      return { isFailure: true, type: "near-duplicate" };
    }
  }

  return { isFailure: false, type: null };
}

/**
 * Detect if the message indicates previous attempt succeeded.
 * User approves, moves on, says thanks, etc.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function detectSuccessSignals(message) {
  const trimmed = message.trim();

  // Short approval messages
  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }

  // Longer messages with success language
  for (const pat of SUCCESS_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }

  return false;
}
