/**
 * Completion Propagator — unified "task finished" signal through all subsystems.
 *
 * When a task completes, stale context about it leaks through:
 *   - Brain memory nodes (high confidence, persist 30-90 days)
 *   - Session pins (no completion filter)
 *   - Mind entries (never expire)
 *   - Handoff (carries completed counts that prime the model)
 *
 * This module propagates a single completion signal that decays brain nodes,
 * clears matching pins, marks mind entries, and invalidates the ContextStore.
 *
 * Architecture: brain-engine runs as a utilityProcess worker. We communicate
 * with it via brainRequest() passed in at call time, and handle file-based
 * state (pins, handoff) directly.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { contextStore } from "./context-store.mjs";

const PANE_DIR = path.join(os.homedir(), ".pane");

/**
 * Propagate a task completion signal through all context subsystems.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} options.taskDescription - Description of the completed task/objective
 * @param {string[]} options.completedTodos - Content strings of completed todo items
 * @param {(type: string, data: object) => Promise<any>} options.brainRequest - Function to send messages to brain worker
 * @returns {Promise<{ nodesDecayed: number, pinsCleared: number, mindMarked: number }>}
 */
export async function propagateCompletion(projectId, { taskDescription, completedTodos = [], brainRequest }) {
  const result = { nodesDecayed: 0, pinsCleared: 0, mindMarked: 0 };

  // ── 1. Decay brain nodes related to completed task ──────────────────
  // Send to brain worker — it has the DB and embeddings.
  // The worker decays matching nodes' confidence by 0.3 (fast, not deletion).
  if (brainRequest && taskDescription) {
    try {
      const brainResult = await Promise.race([
        brainRequest("decay_completed_task", {
          projectId,
          taskDescription,
          completedTodos,
          decayAmount: 0.3,
          similarityThreshold: 0.7,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      result.nodesDecayed = brainResult?.nodesDecayed || 0;
      result.mindMarked = brainResult?.mindMarked || 0;
    } catch (err) {
      console.warn("[completion-propagator] brain decay failed (non-fatal):", err.message);
    }
  }

  // ── 2. Clear session pins matching completed work ────────────────────
  // Pins are JSON files — we handle them directly.
  try {
    const pinsPath = path.join(PANE_DIR, "memory", projectId, "session-pins.json");
    const raw = fs.readFileSync(pinsPath, "utf-8");
    const pins = JSON.parse(raw);

    if (Array.isArray(pins) && pins.length > 0 && completedTodos.length > 0) {
      const completedWords = new Set(
        completedTodos.join(" ").toLowerCase().split(/\s+/).filter(w => w.length >= 4)
      );

      const surviving = pins.filter(pin => {
        const pinWords = (pin.content || "").toLowerCase().split(/\s+/).filter(w => w.length >= 4);
        if (pinWords.length === 0) return true; // keep pins with no meaningful content

        const overlap = pinWords.filter(w => completedWords.has(w)).length;
        const overlapRatio = overlap / pinWords.length;
        return overlapRatio < 0.6; // keep if less than 60% overlap
      });

      const cleared = pins.length - surviving.length;
      if (cleared > 0) {
        fs.writeFileSync(pinsPath, JSON.stringify(surviving, null, 2));
        result.pinsCleared = cleared;
      }
    }
  } catch {
    // No pins file or parse error — nothing to clear
  }

  // ── 3. Strip completed task references from handoff ──────────────────
  try {
    const handoffPath = path.join(PANE_DIR, "session", projectId, "handoff.json");
    const raw = fs.readFileSync(handoffPath, "utf-8");
    const handoff = JSON.parse(raw);

    let changed = false;

    // Remove progress field that carries "3/5 tasks completed" counts
    if (handoff.progress) {
      delete handoff.progress;
      changed = true;
    }

    // Remove accomplished items that match completed todos
    if (handoff.accomplished && completedTodos.length > 0) {
      const completedLower = new Set(completedTodos.map(t => t.toLowerCase().trim()));
      const before = handoff.accomplished.length;
      handoff.accomplished = handoff.accomplished.filter(item => {
        const itemText = (typeof item === "string" ? item : item.text || "").toLowerCase().trim();
        return !completedLower.has(itemText);
      });
      if (handoff.accomplished.length < before) changed = true;
    }

    if (changed) {
      fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
    }
  } catch {
    // No handoff file — nothing to strip
  }

  // ── 4. Invalidate ContextStore to force fresh assembly ───────────────
  contextStore.invalidateProject(projectId);

  if (result.nodesDecayed > 0 || result.pinsCleared > 0 || result.mindMarked > 0) {
    console.log(
      `[completion-propagator] ${projectId}: ` +
      `${result.nodesDecayed} nodes decayed, ` +
      `${result.pinsCleared} pins cleared, ` +
      `${result.mindMarked} mind entries marked`,
    );
  }

  return result;
}
