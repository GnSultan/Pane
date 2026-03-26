/**
 * plan-store.mjs — Durable plan storage
 *
 * Plans are first-class artifacts. They live on disk, survive restarts,
 * and are the source of truth for what Pane decided to do and why.
 *
 * ~/.pane/plans/{projectId}/{planId}.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PLANS_DIR = path.join(os.homedir(), ".pane", "plans");

function planPath(projectId, planId) {
  return path.join(PLANS_DIR, projectId, `${planId}.json`);
}

function planDir(projectId) {
  return path.join(PLANS_DIR, projectId);
}

/**
 * Create a new plan and write it to disk.
 * Returns the planId.
 */
export function createPlan(projectId, task, steps, models = {}) {
  const planId = `plan-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const plan = {
    id: planId,
    projectId,
    created: Date.now(),
    task,
    status: "executing", // planning | executing | completed | failed | aborted
    models: {
      planning: models.planning || null,
      execution: models.execution || null,
    },
    steps: steps.map((s) => ({
      ...s,
      status: "pending", // pending | running | completed | failed
      startedAt: null,
      completedAt: null,
      paneVerdict: null, // "passed" | "failed"
      verdictReason: null,
      changedFiles: [],
      changeIds: [],
      handoff: null, // synthesized by Pane from change history, not model output
    })),
  };

  fs.mkdirSync(planDir(projectId), { recursive: true });
  fs.writeFileSync(planPath(projectId, planId), JSON.stringify(plan, null, 2));
  return { planId, plan };
}

/**
 * Update a step's status and verdict. Called by TaskRunner after each step.
 */
export function updatePlanStep(projectId, planId, stepIndex, update) {
  try {
    const fp = planPath(projectId, planId);
    const plan = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const step = plan.steps.find((s) => s.index === stepIndex);
    if (!step) return;
    Object.assign(step, update);
    fs.writeFileSync(fp, JSON.stringify(plan, null, 2));
  } catch (err) {
    console.warn(`[plan-store] updatePlanStep failed: ${err.message}`);
  }
}

/**
 * Mark the plan as completed or failed.
 */
export function completePlan(projectId, planId, status) {
  try {
    const fp = planPath(projectId, planId);
    const plan = JSON.parse(fs.readFileSync(fp, "utf-8"));
    plan.status = status;
    plan.completedAt = Date.now();
    fs.writeFileSync(fp, JSON.stringify(plan, null, 2));
  } catch (err) {
    console.warn(`[plan-store] completePlan failed: ${err.message}`);
  }
}

/**
 * Read a plan from disk.
 */
export function readPlan(projectId, planId) {
  try {
    return JSON.parse(fs.readFileSync(planPath(projectId, planId), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Return the most recent "executing" plan for this project created within
 * the last `maxAgeMs` milliseconds. Used to resume rather than re-plan when
 * the user sends "continue" after a planning failure.
 *
 * Returns the plan object or null.
 */
export function getLatestExecutingPlan(projectId, maxAgeMs = 30 * 60 * 1000) {
  try {
    const dir = planDir(projectId);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first (filenames start with plan-{timestamp})
    const cutoff = Date.now() - maxAgeMs;
    for (const file of files) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (plan.status === "executing" && plan.created >= cutoff) return plan;
      } catch { /* skip corrupt files */ }
    }
    return null;
  } catch {
    return null;
  }
}
