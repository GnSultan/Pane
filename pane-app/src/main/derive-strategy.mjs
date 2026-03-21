// ============================================================================
// Strategy Engine
// ============================================================================
//
// Three questions, answered in order:
//
//   1. Is this a discussion or question?   → discuss, no discovery
//   2. Is this a surgical, unambiguous change?  → direct, no discovery
//   3. Everything else with action intent   → orchestrate + discovery
//
// Discovery is the DEFAULT gateway for orchestration.
// Skip it only when the task is a clear continuation of established active work
// AND specific enough that alignment adds no value.
//
// Context state (working set, todos, decisions) tells us what Pane knows about.
// It does NOT gate mode selection — a new unrelated request shouldn't inherit
// orchestrate mode just because 10 files are open.
//
// Output:
//   mode         "direct" | "orchestrate" | "discuss"
//   discovery    boolean  — run alignment conversation before planning?
//   reasoning    "shallow" | "deep"
//   verification "none" | "diff" | "test"
//   confidence   0–1
//   reason       human-readable explanation
//   signals      [{ dimension, label, direction }]
//

/**
 * @param {string} prompt
 * @param {object} ctx
 * @param {Array}  ctx.history      — conversation history
 * @param {Array}  ctx.todos        — active todos
 * @param {object} ctx.sessionState — { workingSet, decisions, activeTask }
 */
export function deriveStrategy(prompt, ctx = {}) {
  const { history = [], todos = [], sessionState = {} } = ctx;
  const text = prompt.toLowerCase().trim();
  const words = text.split(/\s+/);
  const signals = [];

  // ── 0. Explicit slash overrides ──────────────────────────────────────────
  if (/^\/direct\b|^\/raw\b/.test(text))
    return make("direct",      false, "shallow", "none", 1.0, "/direct",      signals);
  if (/^\/discuss\b|^\/chat\b/.test(text))
    return make("discuss",     false, "deep",    "none", 1.0, "/discuss",     signals);
  if (/^\/orchestrate\b|^\/steps\b/.test(text))
    return make("orchestrate", true,  "deep",    "diff", 1.0, "/orchestrate", signals);
  if (/^\/plan\b/.test(text))
    return make("orchestrate", false, "deep",    "diff", 1.0, "/plan",        signals);
  if (/^\/exec\b/.test(text))
    return make("direct",      false, "shallow", "none", 1.0, "/exec",        signals);

  // ── 1. Short continuation tokens ─────────────────────────────────────────
  // Single-word confirmations and short commands are always direct.
  if (/^(go|proceed|yes|do it|start|build it|write it|make it|ship it|run it|ok|okay|yep|yeah|continue|next|done|stop|abort)\.?$/.test(text))
    return make("direct", false, "shallow", "none", 0.95, "continuation token", signals);

  // ── 2. Question / discussion ──────────────────────────────────────────────
  const isImperative    = /^(fix|add|create|write|build|update|delete|remove|rename|move|implement|refactor|migrate|make|run|deploy|install|test|check|verify|change|generate|expose|wire|connect|integrate|extract|split|merge|enable|disable)\b/i.test(text);
  const isInterrogative = /^(what|why|how|who|when|where|which|can you|do you|is it|are you|should i|would you|could you|tell me|explain|describe|show me)\b/i.test(text);
  const isQuestion      = text.endsWith("?");
  const hasOpinionLang  = /\b(what do you think|your (view|opinion|take|thoughts)|do you (think|feel|believe)|don't you think|thoughts on|opinion on)\b/.test(text);

  if (hasOpinionLang && !isImperative) {
    sig(signals, "intent", "opinion request", "-");
    return make("discuss", false, "deep", "none", 0.88, "opinion/discussion", signals);
  }

  if (isQuestion && isInterrogative && !isImperative) {
    sig(signals, "intent", "question", "-");
    return make("discuss", false, "deep", "none", 0.85, "question", signals);
  }

  // ── 3. Surgical task — direct, no planning needed ────────────────────────
  // Criteria: unambiguously small, specific, single-file, single-change.
  // ALL conditions must hold — one ambiguous signal sends it to orchestrate.
  if (isSurgical(prompt, text, words)) {
    sig(signals, "scope", "surgical", "+");
    return make("direct", false, "shallow", "none", 0.88, "surgical change", signals);
  }

  // ── 4. Does this message have action intent? ──────────────────────────────
  // If there's no intent to change/build/fix anything, treat as discuss.
  const hasActionVerb = /\b(implement|write|create|build|add|make|generate|fix|update|change|rename|delete|remove|move|edit|patch|debug|refactor|migrate|deploy|install|expose|wire|connect|integrate|extract|enable|disable)\b/.test(text);

  if (!isImperative && !hasActionVerb) {
    sig(signals, "intent", "no action verb", "-");
    return make("discuss", false, "deep", "none", 0.75, "no clear action intent", signals);
  }

  // ── 5. Orchestrate — with discovery by default ────────────────────────────
  //
  // Discovery fires unless the task is a clear continuation of an active,
  // established task that has already been aligned on.
  //
  // We do NOT use history.length or context size to skip discovery —
  // those measure how much work has been done, not whether THIS message is aligned.
  sig(signals, "intent", "action task", "+");

  const skipDiscovery = isClearContinuation(prompt, text, sessionState, history, todos);

  if (skipDiscovery) {
    sig(signals, "context", "aligned continuation", "+");
  } else {
    sig(signals, "context", "discovery needed", "-");
  }

  return make(
    "orchestrate",
    !skipDiscovery,
    "deep",
    "diff",
    0.82,
    skipDiscovery ? "continuation of active task" : "new task — discovery first",
    signals,
  );
}

// ── Surgical task detection ───────────────────────────────────────────────────
//
// A task is surgical when it is ALL of:
//   - Short (under 18 words) — long messages describe complexity
//   - Imperative or has minimizer + action verb
//   - References a specific target (backtick, filename, or function name pattern)
//   - No cross-cutting language (codebase-wide, everywhere, refactor, etc.)
//
function isSurgical(prompt, text, words) {
  if (words.length > 18) return false;

  // Cross-cutting language disqualifies immediately
  if (/\b(entire|everywhere|across|globally|codebase|all files|refactor|migrate|overhaul|redesign|rewrite|system|architecture)\b/.test(text)) return false;

  // Multi-step language disqualifies
  if (/\b(and then|so that|also|as well|followed by|then|additionally)\b/.test(text)) return false;

  // Must reference a specific target
  const hasBacktick     = /`[^`]+`/.test(prompt);
  const hasFilePath     = /[\w/-]+\.[a-z]{2,5}/.test(prompt);
  const hasFunctionRef  = /\b[a-z][a-zA-Z]+(?:Function|Handler|Method|Component|Hook|Store|Action|Reducer|Util|Helper|Service|Controller|Router|Middleware)\b/.test(prompt);
  const hasSpecificRef  = hasBacktick || hasFilePath || hasFunctionRef;

  if (!hasSpecificRef) return false;

  // Must be imperative OR have minimizer + action
  const isImperative = /^(fix|add|remove|rename|move|update|change|delete|create|write|make)\b/i.test(text);
  const hasMinimizer = /\b(just|quick|small|minor|tiny|simple)\b/.test(text);

  return isImperative || hasMinimizer;
}

// ── Continuation detection ────────────────────────────────────────────────────
//
// A task is a "clear continuation" when:
//   1. There is an active task already established (has description)
//   2. There has been meaningful back-and-forth (>= 4 messages)
//   3. The prompt shares enough vocabulary with the active task
//      (user is talking about the same thing)
//   4. No topic-shift language ("actually", "instead", "new thing",
//      "different", "forget that", "actually let's")
//
function isClearContinuation(prompt, text, sessionState, history, todos) {
  // No active task → can't be a continuation
  if (!sessionState?.activeTask?.description) return false;

  // Too little history to have established alignment
  if (history.length < 4) return false;

  // Explicit topic-shift signals → force discovery
  if (/\b(actually|instead|new|different|forget|scrap|start over|let's do|pivot|switch)\b/.test(text)) return false;

  // Must have pending work (otherwise the "active task" is stale)
  const pendingTodos = (todos || []).filter(t => t.status !== "completed");
  if (pendingTodos.length === 0) return false;

  // Vocabulary overlap between prompt and active task description
  const activeWords = sessionState.activeTask.description
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 4);

  const overlapCount = activeWords.filter(w => text.includes(w)).length;

  // Need at least 2 meaningful word overlaps to be confident it's the same topic
  return overlapCount >= 2;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function make(mode, discovery, reasoning, verification, confidence, reason, signals) {
  return { mode, discovery, reasoning, verification, confidence, reason, signals };
}

function sig(signals, dimension, label, direction) {
  signals.push({ dimension, label, direction });
}
