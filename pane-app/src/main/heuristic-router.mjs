/**
 * Heuristic Router — zero-latency routing for ~80-85% of requests.
 *
 * Drop-in replacement for intent-classifier.mjs's classify() output shape.
 * Uses regex patterns, keyword matching, and scoring heuristics instead of
 * an LLM call. The decision object is structurally identical to what the
 * classifier returns, so punk-engine can consume it without changes.
 *
 * The heuristic doesn't pick specific models — it sets modelTier and lets
 * punk-engine resolve that to a concrete model from the user's catalog.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Regex pattern sets ──────────────────────────────────────────────────────

const FAILURE_PATTERNS = [
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

// Task type keyword patterns — ordered by priority
const QUESTION_STARTERS =
  /^(what|why|how|when|where|who|which|is|are|can|could|would|should|does|do|will|have|has)\b/i;
const HAS_CODE_BLOCK = /```[\s\S]*?```/;
const HAS_ERROR_TRACE =
  /\b(error|exception|traceback|stack trace|TypeError|ReferenceError|SyntaxError|cannot read|undefined is not|ENOENT|EACCES|segfault|panic|fatal)\b/i;
const HAS_CODE_FENCE = /```/;

const DEBUG_KEYWORDS =
  /\b(debug|fix|bug|error|broken|crash|issue|problem|failing|doesn'?t work|not working|wrong output|unexpected|regression)\b/i;
const ARCHITECT_KEYWORDS =
  /\b(architect|design|system design|plan|structure|schema|data model|high[- ]level|approach|strategy|proposal|rfc|spec)\b/i;
const REFACTOR_KEYWORDS =
  /\b(refactor|migrate|reorganize|restructure|rename|extract|simplify|clean ?up|consolidate|decouple|modularize)\b/i;
const IMPLEMENT_KEYWORDS =
  /\b(implement|build|create|add|make|write|set ?up|scaffold|generate|develop|integrate|connect|wire ?up|hook ?up|new feature)\b/i;
const REVIEW_KEYWORDS =
  /\b(review|check|audit|inspect|look at|examine|evaluate|assess|verify|validate)\b/i;

// Technology complexity tiers
const TECH_SECURITY =
  /\b(security|auth|authentication|authorization|oauth|jwt|csrf|xss|injection|encrypt|decrypt|crypto|certificate|ssl|tls|rbac|acl)\b/i;
const TECH_DISTRIBUTED =
  /\b(distributed|realtime|real[- ]time|websocket|grpc|microservice|event[- ]driven|message queue|kafka|redis pub|raft|consensus)\b/i;
const TECH_STATE =
  /\b(concurrency|race condition|deadlock|mutex|semaphore|atomic|state machine|finite automata|thread[- ]safe|lock[- ]free)\b/i;
const TECH_DB =
  /\b(migration|schema change|database|sql|query optimization|index|foreign key|transaction|rollback|orm|prisma migrate|knex)\b/i;
const TECH_TYPES =
  /\b(generics|type inference|conditional type|mapped type|template literal type|variance|covariant|contravariant|phantom type)\b/i;
const TECH_CSS =
  /\b(css|styling|tailwind|flexbox|grid layout|animation|transition|responsive|media query|dark mode)\b/i;

// Multiple file detection
const MULTI_FILE_PATTERNS =
  /\b(all files|every file|across the|multiple files|each component|both files|all components|everywhere)\b/i;
const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}|[\w.-]+\.(ts|tsx|js|jsx|mjs|css|json|py|rs|go)\b/g;

// ── Core functions ──────────────────────────────────────────────────────────

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

/**
 * Score the complexity of a request on a 0-100 scale.
 *
 * @param {string} message
 * @param {number} workingSetSize
 * @param {number} turnCount
 * @param {number} pendingTodos
 * @param {number} consecutiveFailures
 * @returns {number} 0-100
 */
export function scoreComplexity(
  message,
  workingSetSize = 0,
  turnCount = 0,
  pendingTodos = 0,
  consecutiveFailures = 0,
) {
  let score = 0;

  // Message length (0-22)
  const len = message.length;
  if (len <= 50) score += 2;
  else if (len <= 200) score += 8;
  else if (len <= 500) score += 15;
  else score += 22;

  // Code/error presence (0-8, not additive — take the max)
  const hasError = HAS_ERROR_TRACE.test(message);
  const hasCode = HAS_CODE_BLOCK.test(message);
  if (hasError) score += 8;
  else if (hasCode) score += 5;

  // Task type keywords (0-20)
  if (ARCHITECT_KEYWORDS.test(message)) score += 20;
  else if (REFACTOR_KEYWORDS.test(message)) score += 18;
  else if (IMPLEMENT_KEYWORDS.test(message)) score += 15;
  else if (DEBUG_KEYWORDS.test(message)) score += 12;
  else if (REVIEW_KEYWORDS.test(message)) score += 8;
  else if (QUESTION_STARTERS.test(message)) score += 5;

  // Working set size (0-20)
  if (workingSetSize <= 1) score += 2;
  else if (workingSetSize <= 3) score += 8;
  else if (workingSetSize <= 6) score += 14;
  else score += 20;

  // Technology complexity (0-15) — take highest match
  if (TECH_SECURITY.test(message)) score += 15;
  else if (TECH_DISTRIBUTED.test(message)) score += 13;
  else if (TECH_STATE.test(message)) score += 12;
  else if (TECH_DB.test(message)) score += 10;
  else if (TECH_TYPES.test(message)) score += 6;
  else if (TECH_CSS.test(message)) score += 3;

  // Conversation depth (0-10)
  if (turnCount <= 3) score += 1;
  else if (turnCount <= 8) score += 4;
  else if (turnCount <= 15) score += 7;
  else score += 10;

  // Escalation bonus
  if (consecutiveFailures >= 3) score += 15;
  else if (consecutiveFailures === 2) score += 10;
  else if (consecutiveFailures === 1) score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Classify the task type from the message text using regex patterns.
 * Priority order: first match wins.
 *
 * @param {string} message
 * @returns {"debug"|"implement"|"explain"|"architect"|"refactor"|"review"|"conversation"|"quick-answer"|"other"}
 */
export function classifyTaskType(message) {
  const trimmed = message.trim();
  const endsWithQuestion = trimmed.endsWith("?");
  const startsWithQuestion = QUESTION_STARTERS.test(trimmed);
  const hasCode = HAS_CODE_FENCE.test(trimmed);

  // Questions without code blocks → explain or quick-answer
  if (endsWithQuestion && startsWithQuestion && !hasCode) {
    // Short questions are quick-answers, longer ones are explanations
    return trimmed.length < 80 ? "quick-answer" : "explain";
  }

  // Error/debug signals take priority for action-oriented messages
  if (DEBUG_KEYWORDS.test(trimmed)) return "debug";

  // Architecture/design
  if (ARCHITECT_KEYWORDS.test(trimmed)) return "architect";

  // Refactor/migrate
  if (REFACTOR_KEYWORDS.test(trimmed)) return "refactor";

  // Implementation
  if (IMPLEMENT_KEYWORDS.test(trimmed)) return "implement";

  // Review/check
  if (REVIEW_KEYWORDS.test(trimmed)) return "review";

  // Short conversational messages (under 40 chars, no code)
  if (trimmed.length < 40 && !hasCode) return "conversation";

  return "other";
}

/**
 * Classify the execution mode based on message content and contextual signals.
 *
 * @param {string} message
 * @param {{ workingSetSize: number, pendingTodos: number, taskType: string }} signals
 * @returns {"direct"|"orchestrate"|"discuss"}
 */
export function classifyMode(message, signals) {
  const { workingSetSize = 0, pendingTodos = 0, taskType } = signals;
  const trimmed = message.trim();

  // Discuss: explanation + no code + question
  if (
    (taskType === "explain" || taskType === "quick-answer" || taskType === "conversation") &&
    !HAS_CODE_FENCE.test(trimmed) &&
    trimmed.endsWith("?")
  ) {
    return "discuss";
  }

  // Orchestrate: multiple files mentioned
  const fileMatches = trimmed.match(FILE_PATH_PATTERN);
  if (fileMatches && new Set(fileMatches).size >= 3) return "orchestrate";
  if (MULTI_FILE_PATTERNS.test(trimmed)) return "orchestrate";

  // Orchestrate: new feature + long message
  if (taskType === "implement" && trimmed.length > 200) return "orchestrate";

  // Orchestrate: refactor or architect tasks
  if (taskType === "refactor" || taskType === "architect") return "orchestrate";

  // Orchestrate: multiple pending todos
  if (pendingTodos >= 2) return "orchestrate";

  // Orchestrate: large working set implies multi-file context
  if (workingSetSize >= 4 && taskType === "implement") return "orchestrate";

  // Direct for everything else
  return "direct";
}

/**
 * Map a complexity score to a model tier.
 *
 * @param {number} score — 0-100
 * @returns {"cheap"|"mid"|"capable"|"frontier"}
 */
export function tierFromScore(score) {
  if (score <= 25) return "cheap";
  if (score <= 55) return "mid";
  if (score <= 80) return "capable";
  return "frontier";
}

/**
 * Build an escalation hint for the system prompt based on failure stage.
 *
 * @param {number} stage — 0-4
 * @param {string} taskType
 * @returns {string|null}
 */
export function buildEscalationHint(stage, taskType) {
  switch (stage) {
    case 0:
      return null;

    case 1:
      return "State what went wrong, state what you'll do differently, then proceed.";

    case 2:
      return "You MUST explore the codebase first. Read relevant files. Find patterns. Only then implement.";

    case 3:
      return "Search the web for docs/errors/similar issues. State what you found. Then explore codebase. Then implement.";

    case 4:
      return "Audit all previous assumptions. Explore codebase fresh. Search web. Decompose into sub-problems. Solve only the failing sub-problem.";

    default:
      return null;
  }
}

/**
 * Extract a core query from the user's message for exploration actions.
 * Takes the first sentence or line, strips filler words.
 *
 * @param {string} message
 * @returns {string}
 */
function extractCoreQuery(message) {
  // Take first meaningful line or sentence
  const firstLine = message
    .split(/[.\n]/)
    .map((s) => s.trim())
    .find((s) => s.length > 5);

  if (!firstLine) return message.slice(0, 120);

  // Strip common filler
  return firstLine
    .replace(
      /^(please|can you|could you|I need you to|I want you to|try to|let's)\s+/i,
      "",
    )
    .slice(0, 120);
}

/**
 * Extract error text and technology terms from a message for web search queries.
 *
 * @param {string} message
 * @returns {string[]} — search queries
 */
function extractSearchQueries(message) {
  const queries = [];

  // Extract text inside code blocks that looks like an error
  const codeBlocks = message.match(/```[\s\S]*?```/g) || [];
  for (const block of codeBlocks) {
    const inner = block.replace(/```\w*\n?/g, "").trim();
    if (HAS_ERROR_TRACE.test(inner)) {
      // Take first 2 lines of the error as a search query
      const errorLines = inner.split("\n").slice(0, 2).join(" ").slice(0, 100);
      queries.push(`${errorLines} fix`);
      break;
    }
  }

  // Extract tech terms for documentation search
  const techTerms = message.match(
    /\b(react|vue|angular|svelte|electron|tauri|node|deno|bun|typescript|python|rust|go|swift|kotlin|prisma|drizzle|sequelize|webpack|vite|esbuild|docker|kubernetes|postgres|mysql|redis|mongo|supabase|firebase|aws|gcp|azure)\b/gi,
  );
  if (techTerms && techTerms.length > 0) {
    const uniqueTech = [...new Set(techTerms.map((t) => t.toLowerCase()))];
    queries.push(`${uniqueTech.join(" ")} documentation`);
  }

  // Fallback: use the core query
  if (queries.length === 0) {
    queries.push(extractCoreQuery(message));
  }

  return queries;
}

/**
 * Build pre-actions for escalation stages 2+.
 *
 * @param {number} stage — 0-4
 * @param {string} message
 * @returns {Array<{ type: string, [key: string]: any }>}
 */
export function buildPreActions(stage, message) {
  if (stage <= 1) return [];

  const query = extractCoreQuery(message);
  const searchQueries = extractSearchQueries(message);

  if (stage === 2) {
    return [{ type: "explore_codebase", query }];
  }

  if (stage === 3) {
    return [
      { type: "explore_codebase", query },
      { type: "web_search", queries: searchQueries },
    ];
  }

  // Stage 4: full reset
  return [
    { type: "explore_codebase", query, deep: true },
    { type: "web_search", queries: searchQueries },
    { type: "clean_slate" },
  ];
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Route a request using zero-latency heuristics.
 * Returns the exact same decision shape as intent-classifier.mjs's classify().
 *
 * @param {{
 *   message: string,
 *   turnCount: number,
 *   workingSetSize: number,
 *   pendingTodos: number,
 *   phase: string,
 *   threadState: {
 *     consecutiveFailures: number,
 *     lastFailureType: string|null,
 *     approachesTried: number,
 *     lastResponseSummary: string|null,
 *     lastUserPromptHash: number|null
 *   },
 *   backend: string,
 * }} input
 * @returns {{
 *   mode: "direct"|"orchestrate"|"discuss",
 *   reason: string,
 *   discovery: boolean,
 *   reasoning: "shallow"|"deep",
 *   verification: "none"|"diff"|"test",
 *   taskType: string,
 *   complexity: "low"|"medium"|"high",
 *   preferFrontier: boolean,
 *   atomHints: string[],
 *   historyDepth: number,
 *   includeBrief: boolean,
 *   fileDepth: "none"|"names"|"shallow"|"deep",
 *   planningModel: null,
 *   executionModel: null,
 *   escalationStage: number,
 *   escalationHint: string|null,
 *   preActions: Array,
 *   complexityScore: number,
 *   confidence: number,
 *   routedBy: "fast-path"|"heuristic"|"llm-fallback",
 *   modelTier: "cheap"|"mid"|"capable"|"frontier",
 *   resetFailures?: boolean,
 * }}
 */
export function routeHeuristic(input) {
  const {
    message = "",
    turnCount = 0,
    workingSetSize = 0,
    pendingTodos = 0,
    phase = "idle",
    threadState = {},
    backend = "claude-code",
  } = input;

  const {
    consecutiveFailures = 0,
    lastFailureType = null,
    approachesTried = 0,
    lastResponseSummary = null,
    lastUserPromptHash = null,
  } = threadState;

  const trimmed = message.trim();

  // ── Check for success signals (resets failure counter) ──────────────────
  const isSuccess = detectSuccessSignals(trimmed);

  // ── Score complexity ────────────────────────────────────────────────────
  const complexityScore = scoreComplexity(
    trimmed,
    workingSetSize,
    turnCount,
    pendingTodos,
    consecutiveFailures,
  );

  // ── Classify task type ──────────────────────────────────────────────────
  const taskType = classifyTaskType(trimmed);

  // ── Determine escalation stage ──────────────────────────────────────────
  // Escalation stage is capped at 4. Success resets to 0.
  let escalationStage = isSuccess ? 0 : Math.min(consecutiveFailures, 4);

  // ── Classify mode ──────────────────────────────────────────────────────
  let mode = classifyMode(trimmed, { workingSetSize, pendingTodos, taskType });

  // ── Determine base properties from task type and complexity ─────────────
  let discovery = false;
  let reasoning = /** @type {"shallow"|"deep"} */ ("shallow");
  let verification = /** @type {"none"|"diff"|"test"} */ ("none");
  let preferFrontier = false;
  let historyDepth = 5;
  let includeBrief = true;
  let fileDepth = /** @type {"none"|"names"|"shallow"|"deep"} */ ("shallow");

  // Complexity bucket
  const complexity =
    complexityScore <= 25 ? "low" : complexityScore <= 55 ? "medium" : complexityScore <= 80 ? "high" : "high";

  // Discovery: unclear scope needs exploration
  if (taskType === "implement" && workingSetSize === 0) discovery = true;
  if (taskType === "architect") discovery = true;
  if (taskType === "debug" && workingSetSize === 0) discovery = true;
  if (taskType === "refactor" && workingSetSize <= 1) discovery = true;

  // Reasoning depth
  if (complexity === "high" || taskType === "architect" || taskType === "debug") {
    reasoning = "deep";
  }

  // Verification strategy
  if (mode === "discuss" || taskType === "conversation" || taskType === "quick-answer" || taskType === "explain") {
    verification = "none";
  } else if (complexity === "high" || taskType === "refactor") {
    verification = "test";
  } else if (mode === "direct" || mode === "orchestrate") {
    verification = "diff";
  }

  // File depth
  if (mode === "discuss") {
    fileDepth = "none";
  } else if (discovery) {
    fileDepth = "deep";
  } else if (mode === "orchestrate") {
    fileDepth = "shallow";
  } else if (taskType === "quick-answer" || taskType === "conversation") {
    fileDepth = "none";
  } else {
    fileDepth = "names";
  }

  // History depth: more for ongoing conversations, less for fresh starts
  if (turnCount <= 2) historyDepth = 3;
  else if (turnCount <= 6) historyDepth = 5;
  else if (turnCount <= 12) historyDepth = 10;
  else historyDepth = 15;

  // Include brief for non-trivial tasks
  includeBrief = mode !== "discuss" && taskType !== "conversation" && taskType !== "quick-answer";

  // Atom hints: extract keywords for the engine
  const atomHints = [];
  const fileRefs = trimmed.match(FILE_PATH_PATTERN);
  if (fileRefs) {
    for (const ref of new Set(fileRefs)) {
      if (atomHints.length < 5) atomHints.push(ref);
    }
  }

  // ── Apply escalation overrides ──────────────────────────────────────────

  // Stage 2+ forces orchestrate, discovery, deep reasoning
  if (escalationStage >= 2) {
    mode = "orchestrate";
    discovery = true;
    reasoning = "deep";
    fileDepth = "deep";
  }

  // Stage 3+ forces frontier preference
  if (escalationStage >= 3) {
    preferFrontier = true;
  }

  // Stage 4: clean slate — minimal history
  if (escalationStage >= 4) {
    historyDepth = 4;
  }

  // ── Determine model tier ────────────────────────────────────────────────
  let modelTier = tierFromScore(complexityScore);

  // Override tier for specific task types that are always cheap
  if (taskType === "quick-answer" || taskType === "conversation") {
    modelTier = "cheap";
  }

  // Escalation pushes tier up
  if (escalationStage >= 3) {
    modelTier = "frontier";
  } else if (escalationStage >= 2 && (modelTier === "cheap" || modelTier === "mid")) {
    modelTier = "capable";
  } else if (escalationStage >= 1 && modelTier === "cheap") {
    modelTier = "mid";
  }

  // Prefer frontier override
  if (preferFrontier && modelTier !== "frontier") {
    modelTier = "frontier";
  }

  // ── Cross-validation (mirrors intent-classifier constraints) ────────────

  // discuss / conversational never need discovery or deep reasoning
  if (mode === "discuss") {
    discovery = false;
    reasoning = "shallow";
    verification = "none";
  }

  // quick-answer and conversation are always cheap
  if (taskType === "quick-answer" || taskType === "conversation") {
    discovery = false;
    reasoning = "shallow";
    verification = "none";
    preferFrontier = false;
    // But don't override modelTier if escalation pushed it up
    if (escalationStage === 0) modelTier = "cheap";
  }

  // low complexity → never deep reasoning, never frontier (unless escalating)
  if (complexity === "low" && escalationStage === 0) {
    reasoning = "shallow";
    preferFrontier = false;
  }

  // direct + not high complexity → no frontier (unless escalating)
  if (mode === "direct" && complexity !== "high" && escalationStage === 0) {
    preferFrontier = false;
  }

  // ── Build escalation artifacts ──────────────────────────────────────────
  const escalationHint = buildEscalationHint(escalationStage, taskType);
  const preActions = buildPreActions(escalationStage, trimmed);

  // ── Build reason string ─────────────────────────────────────────────────
  const reason = buildReason(mode, taskType, complexity, escalationStage);

  // ── Confidence: heuristic routes are high-confidence for clear patterns ─
  let confidence = 0.8;
  if (taskType === "quick-answer" || taskType === "conversation") confidence = 0.95;
  if (taskType === "explain" && mode === "discuss") confidence = 0.9;
  if (trimmed.length > 400 && taskType === "other") confidence = 0.5; // long ambiguous → low confidence
  if (complexityScore > 70 && taskType === "other") confidence = 0.45; // complex + ambiguous

  return {
    mode,
    reason,
    discovery,
    reasoning,
    verification,
    taskType,
    complexity,
    preferFrontier,
    atomHints,
    historyDepth,
    includeBrief,
    fileDepth,
    planningModel: null,
    executionModel: null,
    escalationStage,
    escalationHint,
    preActions,
    complexityScore,
    confidence,
    routedBy: "heuristic",
    modelTier,
    ...(isSuccess ? { resetFailures: true } : {}),
  };
}

// ── Reason builder ──────────────────────────────────────────────────────────

/**
 * Build a user-facing one-line reason for the routing decision.
 *
 * @param {string} mode
 * @param {string} taskType
 * @param {string} complexity
 * @param {number} escalationStage
 * @returns {string}
 */
function buildReason(mode, taskType, complexity, escalationStage) {
  if (escalationStage >= 3) {
    return "Previous approaches haven't worked — taking a fresh look with deeper analysis.";
  }
  if (escalationStage >= 1) {
    return "Adjusting approach based on what didn't work last time.";
  }

  const typeReasons = {
    "quick-answer": "Quick answer — going directly.",
    conversation: "Conversational — keeping it light.",
    explain: "Explanation request — gathering context to answer clearly.",
    debug:
      complexity === "high"
        ? "Complex debugging problem — applying deep reasoning to trace this carefully."
        : "Debugging — tracing the issue.",
    architect: "Architecture question — exploring the codebase to reason about design.",
    refactor:
      complexity === "high"
        ? "Significant refactor — planning the approach before touching code."
        : "Refactor — restructuring carefully.",
    implement:
      mode === "orchestrate"
        ? "Multi-step implementation — planning the approach first."
        : "Straightforward implementation — going directly.",
    review: "Code review — examining the changes.",
    other:
      mode === "orchestrate"
        ? "Complex task — breaking it down into steps."
        : "Going directly.",
  };

  return typeReasons[taskType] || "Processing request.";
}
