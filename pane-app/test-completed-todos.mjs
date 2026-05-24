// Quick test to verify completed_from_history fix
// This tests that completed todos from previous sessions are NOT re-added as new work

import { readState, generateHandoff, writeState } from "./src/main/session-context.mjs";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_PROJECT = "pane-test-completed-todos";

// Helper function to extract completed_from_history
function extractCompletedFromHistory(handoff) {
  const items = handoff?.completed_from_history || [];
  if (!Array.isArray(items)) return [];

  return items
    .map(item => typeof item === "string" ? item.trim() : String(item).trim())
    .filter(item => item.length > 0);
}

// Clean up from previous test
try {
  const testDir = path.join(SESSION_DIR, TEST_PROJECT);
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
} catch {}

console.log("Testing completed_from_history fix...\n");

// Test 1: Current session work - 'Fix login bug' in recentActions
console.log("Test 1: Current session work should go to accomplishment\n");
const state1 = {
  activeTask: null,
  todos: [
    { content: "Fix login bug", status: "completed" },
  ],
  workingSet: [],
  decisions: [],
  recentActions: [
    { type: "file_edit", content: "Fixed authentication logic" },
  ],
  methodNotes: [],
  gitStatus: null,
  turnCount: 0,
  lastProvider: null,
  lastIntent: null,
  startedAt: Date.now(),
  phase: "idle",
};

writeState(TEST_PROJECT, state1);
const handoff1 = generateHandoff(TEST_PROJECT);

console.log("  State todos (completed):", state1.todos.filter(t => t.status === "completed").map(t => t.content));
console.log("  Recent actions:", state1.recentActions.map(a => a.content));
console.log("  Handoff accomplishment:", handoff1.accomplishment?.map(i => i.text));
console.log("  Handoff completed_from_history:", handoff1.completed_from_history);

// The completed todo content should appear in accomplishment
const inAccomplishment = handoff1.accomplishment?.some(i => i.text === "Fix login bug");

console.log(`  Expected: 'Fix login bug' (the completed todo) should appear in accomplishment`);
console.log(`  Handoff accomplishment contains 'Fix login bug': ${inAccomplishment ? "✓ PASS" : "❌ FAIL"}`);
console.log("");

// Clean up and run Test 2
try {
  const testDir = path.join(SESSION_DIR, TEST_PROJECT);
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
} catch {}

// Test 2: Previous session work - 'Fix login bug' was completed, but no recent actions in THIS session
console.log("Test 2: Previous session work should go to completed_from_history\n");
const state2 = {
  activeTask: null,
  todos: [
    { content: "Fix login bug", status: "completed" },
  ],
  workingSet: [],
  decisions: [],
  recentActions: [],
  methodNotes: [],
  gitStatus: null,
  turnCount: 1,
  lastProvider: null,
  lastIntent: null,
  startedAt: Date.now(),
  phase: "idle",
};

writeState(TEST_PROJECT, state2);
const handoff2 = generateHandoff(TEST_PROJECT);

console.log("  State todos (completed):", state2.todos.filter(t => t.status === "completed").map(t => t.content));
console.log("  Recent actions:", state2.recentActions);
console.log("  Handoff accomplishment:", handoff2.accomplishment);
console.log("  Handoff completed_from_history:", handoff2.completed_from_history);

const inCompletedHistory2 = handoff2.completed_from_history?.includes("Fix login bug");

console.log(`  Expected: 'Fix login bug' should be in completed_from_history (it was done before this session)`);
console.log(`  Handoff completed_from_history contains 'Fix login bug': ${inCompletedHistory2 ? "✓ PASS" : "❌ FAIL"}`);
console.log("");

// Clean up
try {
  const testDir = path.join(SESSION_DIR, TEST_PROJECT);
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
} catch {}

console.log("✓ All tests complete.\n");
console.log("Summary:");
console.log("- Current session work (completed AND in recentActions) → accomplishment");
console.log("- Previous session work (completed but NOT in recentActions) → completed_from_history");
console.log("");
console.log("Why this fixes the bug:");
console.log("- Model sees: Previous session outcome: ✓ fix login bug");
console.log("- Model sees: Already completed from previous sessions: ...");
console.log("- Model sees: Task list (active work only): [→] Set up database, [ ] Write tests");
console.log("- Model does NOT see: [x] fix login bug in task list");
console.log("- Model understands: 'fix login bug' is already done, don't re-add it");