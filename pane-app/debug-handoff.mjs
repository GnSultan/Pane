// Debug script to understand handoff logic
import { readState, generateHandoff, writeState } from "./src/main/session-context.mjs";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_PROJECT = "pane-test-completed-todos";

// Clean up from previous test
try {
  const testDir = path.join(SESSION_DIR, TEST_PROJECT);
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
} catch {}

console.log("Debugging handoff logic...\n");

// Test 1: Current session work - 'Fix login bug' in recentActions
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

console.log("Test 1 State:");
console.log("  State todos (completed):", state1.todos.filter(t => t.status === "completed").map(t => t.content));
console.log("  Recent actions:", state1.recentActions.map(a => a.content));

// Debug logic
const actionContents = new Set(
  state1.recentActions
    .filter(a => a.type === "file_edit" || a.type === "command" || a.type === "decision")
    .map(a => a.content)
);
console.log("  actionContents (Set):", Array.from(actionContents));

const todoContent = state1.todos[0].content.toLowerCase();
console.log("  todoContent (lowercase):", todoContent);

const isInActions = Array.from(actionContents).some(action => action.toLowerCase().includes(todoContent));
console.log("  isInActions:", isInActions);
console.log("  Should go to completed_from_history:", !isInActions);

console.log("  Handoff accomplishment:", handoff1.accomplishment?.map(i => i.text));
console.log("  Handoff completed_from_history:", handoff1.completed_from_history);