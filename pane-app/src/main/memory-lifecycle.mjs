/**
 * Memory Lifecycle — decay, reinforce, reflect.
 *
 * Pane's memory should work like human memory:
 *   - Unused knowledge fades (decay)
 *   - Knowledge that proves useful strengthens (reinforcement)
 *   - Observations distill into a small tested playbook (reflection)
 *
 * This module runs periodically (session start, after N turns, daily).
 * It transforms raw memory nodes from "things you can look up" into
 * "things that shape behavior."
 *
 * The old consolidate/graduate pipeline (embedding clustering → principle
 * nodes → digest.txt) is gone. It produced 126K+ never-accessed principle
 * nodes and a digest full of raw session dumps that nothing injected.
 * Its replacement lives in playbook-engine.mjs: an LLM reflection pass
 * that REVISES a bounded per-project playbook, plus a validation loop
 * where arbiter verdicts hold principles accountable.
 *
 * Pipeline:
 *   Events → Active Knowledge → Playbook → System prompt
 *            (scored, decaying)  (reflected)  (injected every session)
 */

import {
  runReflection,
  runGlobalReflection,
  runStorageHygiene,
} from "./playbook-engine.mjs";

// ============================================================================
// Constants
// ============================================================================

const DECAY_RATE_PER_WEEK = 0.01;        // Confidence drop per week of no access
const REINFORCE_BOOST = 0.05;            // Confidence boost on useful recall
const STALE_THRESHOLD_DAYS = 3;          // Days without access before memory is prunable

// A source observation that has already been distilled into a principle AND has
// never been recalled has handed its value to the playbook. It doesn't need to
// linger for a year at the normal decay rate — retire it faster. The principle
// carries the knowledge forward; the raw node is just an unread receipt.
const DISTILLED_UNREAD_DECAY_MULT = 6;   // ~1yr normal retirement → ~2 months
const PROTECTED_DECAY_TYPES = new Set(["file", "project"]); // code map — never fast-decay

// ============================================================================
// 1. DECAY — unused memories fade
// ============================================================================

/**
 * Apply time-based decay to all memories in a project.
 * Confidence drops ~0.01 per week of no access.
 * Memories below 0.15 confidence are candidates for pruning.
 *
 * @param {object} db - brain database instance (with _stmts)
 * @param {string} projectId
 * @returns {{ decayed: number, pruned: number }}
 */
export function applyDecay(db, projectId) {
  let decayed = 0;
  let pruned = 0;

  // Build the set of source nodes that have already been distilled into an
  // active principle. Their value now lives in the playbook, so if they've also
  // never been recalled we let them decay faster (see below). Safe if the
  // principles table isn't ready yet — treat as empty.
  const distilledSources = new Set();
  try {
    const rows = db.prepare(
      `SELECT born_from FROM principles WHERE project_id = ? AND status = 'active'`,
    ).all(projectId);
    for (const r of rows) {
      try {
        for (const id of JSON.parse(r.born_from || "[]")) distilledSources.add(id);
      } catch {}
    }
  } catch {}

  // Get nodes not updated in the last week
  const staleNodes = db._stmts.getStaleNodes.all(projectId, "-7 days");

  for (const node of staleNodes) {
    // Calculate weeks since last access
    const updatedAt = new Date(node.updated_at).getTime();
    const weeksSinceAccess = Math.max(0, (Date.now() - updatedAt) / (7 * 24 * 60 * 60 * 1000));

    // Accelerate decay for nodes whose knowledge is already captured in a
    // principle and that have never been recalled — the raw node is redundant.
    // The code map (file/project) is exempt: it's rebuildable intelligence, not
    // a distilled-away observation.
    const distilledUnread =
      (node.access_count ?? 0) === 0 &&
      distilledSources.has(node.id) &&
      !PROTECTED_DECAY_TYPES.has(node.entity_type);
    const rate = distilledUnread
      ? DECAY_RATE_PER_WEEK * DISTILLED_UNREAD_DECAY_MULT
      : DECAY_RATE_PER_WEEK;
    const decay = rate * weeksSinceAccess;

    if (node.confidence - decay < 0.15) {
      // Too faded — prune if old enough
      const daysSinceAccess = weeksSinceAccess * 7;
      if (daysSinceAccess > STALE_THRESHOLD_DAYS) {
        try {
          db.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
          pruned++;
        } catch {}
      }
    } else if (decay > 0.005) {
      // Apply decay
      db._stmts.lowerConfidence.run(decay, node.id);
      decayed++;
    }
  }

  return { decayed, pruned };
}

// ============================================================================
// 2. REINFORCE — useful memories get stronger
// ============================================================================

/**
 * Boost a memory's confidence when it was recalled and acted upon.
 * Called from recall handlers when the model uses a memory.
 *
 * @param {object} db - brain database instance
 * @param {string} nodeId - the memory node ID
 */
export function reinforceMemory(db, nodeId) {
  try {
    db._stmts.boostConfidence.run(REINFORCE_BOOST, nodeId);
    db._stmts.bumpAccess.run(nodeId);
  } catch {}
}

/**
 * Record that a memory was accessed (even if not directly acted upon).
 * Prevents decay by updating the access timestamp.
 *
 * @param {object} db - brain database instance
 * @param {string} nodeId
 */
export function touchMemory(db, nodeId) {
  try {
    db._stmts.bumpAccess.run(nodeId);
  } catch {}
}

// ============================================================================
// 3. FULL LIFECYCLE RUN — decay, then reflect
// ============================================================================

/**
 * Run the full memory lifecycle for a project.
 * Call on session start, after significant work, or periodically.
 * All expensive steps are internally throttled — safe to fire every turn.
 *
 * @param {object} db - brain database instance
 * @param {string} projectId
 * @param {Function} [quickCall] - optional LLM function for reflection
 * @returns {Promise<object>} - lifecycle results
 */
export async function runMemoryLifecycle(db, projectId, quickCall = null) {
  const start = Date.now();

  // 0. Ongoing storage maintenance: trim node version history
  const hygiene = runStorageHygiene(db);

  // 1. Decay unused memories
  const decayResult = applyDecay(db, projectId);

  // 2. Reflect: revise the project playbook from recent observations
  //    (throttled internally: 6h interval + corpus-change check)
  const reflection = await runReflection(db, projectId, quickCall);

  // 3. Cross-project craft profile (throttled: 24h + change check)
  const global = await runGlobalReflection(db, quickCall);

  const duration = Date.now() - start;

  const result = {
    hygiene,
    decay: decayResult,
    reflection,
    global,
    duration,
  };

  const hasActivity = decayResult.decayed > 0 || decayResult.pruned > 0
    || reflection.added > 0 || reflection.retired > 0
    || hygiene.versionsDeleted > 0;

  if (hasActivity) {
    console.log(
      `[memory] Lifecycle for ${projectId}: ` +
      `decayed=${decayResult.decayed} pruned=${decayResult.pruned} ` +
      `reflection=${JSON.stringify(reflection)} ` +
      `(${duration}ms)`
    );
  }

  return result;
}
