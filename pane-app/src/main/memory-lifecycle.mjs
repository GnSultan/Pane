/**
 * Memory Lifecycle — decay, reinforce, consolidate, graduate.
 *
 * Pane's memory should work like human memory:
 *   - Unused knowledge fades (decay)
 *   - Knowledge that proves useful strengthens (reinforcement)
 *   - Repeated observations crystallize into principles (consolidation)
 *   - Strong principles become behavioral wiring (graduation)
 *
 * This module runs periodically (session start, after N turns, daily).
 * It transforms raw memory nodes from "things you can look up" into
 * "things that shape behavior."
 *
 * Pipeline:
 *   Events → Active Knowledge → Principles → Behavioral Wiring
 *            (scored, decaying)  (consolidated)  (profile digest)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const PROFILE_DIR = path.join(PANE_DIR, "profile");

// ============================================================================
// Constants
// ============================================================================

const DECAY_RATE_PER_WEEK = 0.01;        // Confidence drop per week of no access
const REINFORCE_BOOST = 0.05;            // Confidence boost on useful recall
const CONSOLIDATION_THRESHOLD = 3;        // Min similar observations to consolidate
const GRADUATION_THRESHOLD = 0.90;        // Confidence to auto-promote to behavioral wiring
const STALE_THRESHOLD_DAYS = 3;           // Days without access before memory is prunable
const SIMILARITY_THRESHOLD = 0.75;        // Cosine similarity to consider memories "similar"
const MAX_DIGEST_LINES = 20;             // Max behavioral rules in profile digest

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

  // Get nodes not updated in the last week
  const staleNodes = db._stmts.getStaleNodes.all(projectId, "-7 days");

  for (const node of staleNodes) {
    // Calculate weeks since last access
    const updatedAt = new Date(node.updated_at).getTime();
    const weeksSinceAccess = Math.max(0, (Date.now() - updatedAt) / (7 * 24 * 60 * 60 * 1000));
    const decay = DECAY_RATE_PER_WEEK * weeksSinceAccess;

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
// 3. CONSOLIDATION — cluster similar observations into principles
// ============================================================================

/**
 * Find clusters of similar memories and consolidate them into principles.
 * Uses embedding cosine similarity to find clusters.
 *
 * This is the "5 corrections about TypeScript → 1 principle" pipeline.
 *
 * @param {object} db - brain database instance
 * @param {string} projectId
 * @param {Function} quickCall - LLM function for synthesis (optional)
 * @returns {Promise<{ consolidated: number, principlesCreated: number }>}
 */
export async function consolidateMemories(db, projectId, quickCall = null) {
  let consolidated = 0;
  let principlesCreated = 0;

  // Get all memory nodes with embeddings
  const nodes = db._stmts.getAllProjectNodes.all(projectId);
  if (nodes.length < CONSOLIDATION_THRESHOLD) return { consolidated, principlesCreated };

  // Parse embeddings
  const withEmbeddings = nodes
    .filter(n => n.embedding && ["decision", "lesson", "pattern", "error_fix"].includes(n.entity_type))
    .map(n => {
      try {
        const emb = n.embedding instanceof Buffer
          ? new Float32Array(n.embedding.buffer, n.embedding.byteOffset, n.embedding.byteLength / 4)
          : null;
        const content = JSON.parse(n.content || "{}");
        return { ...n, emb, text: content.text || content.content || "" };
      } catch {
        return null;
      }
    })
    .filter(n => n && n.emb);

  if (withEmbeddings.length < CONSOLIDATION_THRESHOLD) return { consolidated, principlesCreated };

  // Find clusters: for each node, find its similar neighbors
  const used = new Set();
  const clusters = [];

  for (let i = 0; i < withEmbeddings.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    used.add(i);

    for (let j = i + 1; j < withEmbeddings.length; j++) {
      if (used.has(j)) continue;
      const sim = cosine(withEmbeddings[i].emb, withEmbeddings[j].emb);
      if (sim >= SIMILARITY_THRESHOLD) {
        cluster.push(j);
        used.add(j);
      }
    }

    if (cluster.length >= CONSOLIDATION_THRESHOLD) {
      clusters.push(cluster.map(idx => withEmbeddings[idx]));
    }
  }

  if (clusters.length === 0) return { consolidated, principlesCreated };

  // Consolidate each cluster
  for (const cluster of clusters) {
    const texts = cluster.map(n => `- ${n.text}`).join("\n");
    let principleText;

    if (quickCall) {
      // Use LLM to synthesize the cluster into a principle
      try {
        principleText = await quickCall(
          "You are a pattern extractor. Given a set of related observations from a software project, synthesize them into ONE concise behavioral principle (1-2 sentences). The principle should be actionable — it should tell a developer how to behave, not just describe a pattern. Output only the principle, nothing else.",
          `Observations:\n${texts}`
        );
        principleText = principleText?.trim();
      } catch {
        // LLM failed — fall back to picking the highest-confidence observation
        principleText = null;
      }
    }

    if (!principleText) {
      // No LLM — pick the highest-confidence node as the principle
      const best = cluster.sort((a, b) => b.confidence - a.confidence)[0];
      principleText = best.text;
    }

    // Create the principle node (or update if similar exists)
    const principleId = `principle-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const avgConfidence = Math.min(0.92, cluster.reduce((s, n) => s + n.confidence, 0) / cluster.length + 0.1);

    try {
      db._stmts.insertNode.run(
        principleId,
        principleText.slice(0, 80),
        "principle",
        projectId,
        JSON.stringify({ text: principleText, source: "consolidation", sourceCount: cluster.length }),
        cluster[0].embedding, // Use first node's embedding as proxy
        avgConfidence
      );
      principlesCreated++;
    } catch {}

    // Boost source nodes slightly (they contributed to a principle)
    for (const node of cluster) {
      try {
        db._stmts.boostConfidence.run(0.02, node.id);
      } catch {}
    }
    consolidated += cluster.length;
  }

  return { consolidated, principlesCreated };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Embeddings are already normalized
}

// ============================================================================
// 4. GRADUATION — strong principles become behavioral wiring
// ============================================================================

/**
 * Check for principles that have graduated above the confidence threshold
 * and auto-promote them to the profile digest.
 *
 * This is where memory becomes behavior. A principle at 0.92 confidence
 * that's been reinforced through use gets added to the profile digest,
 * which lives in the frozen system prompt tier. The model follows it
 * WITHOUT needing to recall anything.
 *
 * @param {object} db - brain database instance
 * @param {string} projectId
 * @returns {{ graduated: number }}
 */
export function graduateToDigest(db, projectId) {
  let graduated = 0;

  // Find principles above graduation threshold
  const candidates = db.prepare(`
    SELECT id, content, confidence, access_count FROM nodes
    WHERE project_id = ? AND confidence >= ?
    AND entity_type IN ('principle', 'lesson', 'pattern')
    AND access_count >= 2
    ORDER BY confidence DESC
  `).all(projectId, GRADUATION_THRESHOLD);

  if (candidates.length === 0) return { graduated };

  // Read current digest
  const digestPath = path.join(PROFILE_DIR, "digest.txt");
  let currentDigest = "";
  try {
    currentDigest = fs.readFileSync(digestPath, "utf-8").trim();
  } catch {}

  const currentLines = currentDigest ? currentDigest.split("\n").filter(l => l.trim()) : [];

  // Check which candidates are already in the digest (fuzzy match)
  const newRules = [];
  for (const candidate of candidates) {
    const parsed = JSON.parse(candidate.content || "{}");
    const text = parsed.text || parsed.content || "";
    if (!text || text.length < 10) continue;

    // Check if already in digest (fuzzy: first 40 chars match)
    const prefix = text.slice(0, 40).toLowerCase();
    const alreadyPresent = currentLines.some(line =>
      line.toLowerCase().includes(prefix) || prefix.includes(line.slice(0, 40).toLowerCase())
    );

    if (!alreadyPresent && currentLines.length + newRules.length < MAX_DIGEST_LINES) {
      newRules.push(text);
      graduated++;
    }
  }

  if (newRules.length > 0) {
    const updatedDigest = [...currentLines, ...newRules].join("\n");
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.writeFileSync(digestPath, updatedDigest, "utf-8");
      console.log(`[memory] Graduated ${newRules.length} principles to profile digest`);
    } catch (err) {
      console.warn(`[memory] Failed to update profile digest: ${err.message}`);
    }
  }

  return { graduated };
}

// ============================================================================
// 5. FULL LIFECYCLE RUN — call all operations in sequence
// ============================================================================

/**
 * Run the full memory lifecycle for a project.
 * Call on session start, after significant work, or periodically.
 *
 * @param {object} db - brain database instance
 * @param {string} projectId
 * @param {Function} [quickCall] - optional LLM function for consolidation
 * @returns {Promise<object>} - lifecycle results
 */
export async function runMemoryLifecycle(db, projectId, quickCall = null) {
  const start = Date.now();

  // 1. Decay unused memories
  const decayResult = applyDecay(db, projectId);

  // 2. Consolidate similar observations into principles
  const consolidateResult = await consolidateMemories(db, projectId, quickCall);

  // 3. Graduate strong principles to behavioral wiring
  const graduateResult = graduateToDigest(db, projectId);

  const duration = Date.now() - start;

  const result = {
    decay: decayResult,
    consolidation: consolidateResult,
    graduation: graduateResult,
    duration,
  };

  const hasActivity = decayResult.decayed > 0 || decayResult.pruned > 0
    || consolidateResult.principlesCreated > 0 || graduateResult.graduated > 0;

  if (hasActivity) {
    console.log(
      `[memory] Lifecycle for ${projectId}: ` +
      `decayed=${decayResult.decayed} pruned=${decayResult.pruned} ` +
      `consolidated=${consolidateResult.consolidated}→${consolidateResult.principlesCreated} principles ` +
      `graduated=${graduateResult.graduated} (${duration}ms)`
    );
  }

  return result;
}
