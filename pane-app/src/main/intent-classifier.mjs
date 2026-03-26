/**
 * Unified Intent Classifier + Model Router
 *
 * Single API call through the user's active backend that:
 *   1. Classifies the task (mode, type, complexity, discovery, etc.)
 *   2. Routes to optimal models for each phase (planning, execution)
 *
 * The model sees the full catalog of available models with benchmark scores,
 * costs, arena ranks, and real performance data from the routing store.
 * It reasons about which model is best for this specific task.
 *
 * Replaces: local Qwen classifier + routing-oracle.consult() + regex classifyDomain()
 */

// ── Validation sets ─────────────────────────────────────────────────────────

const VALID_MODES       = new Set(["direct", "orchestrate", "discuss"]);
const VALID_REASONING   = new Set(["shallow", "deep"]);
const VALID_VERIFY      = new Set(["none", "diff", "test"]);
const VALID_TASK_TYPES  = new Set(["debug", "implement", "explain", "architect", "refactor", "review", "conversation", "quick-answer", "other"]);
const VALID_COMPLEXITY  = new Set(["low", "medium", "high"]);
const VALID_FILE_DEPTH  = new Set(["none", "names", "shallow", "deep"]);

// ── Model catalog builder ───────────────────────────────────────────────────

/**
 * Build a compact text description of all models available to the user.
 * Includes benchmark scores, costs, arena rank, and real outcome data.
 *
 * @param {object} options
 * @param {string} options.backend — "http" | "claude-cli" | "gemini-cli"
 * @param {object} options.apiKeys — { deepseek: "sk-...", anthropic: "sk-...", ... }
 * @param {Array}  options.priors  — from routingStore.getAllPriors()
 * @param {Array}  options.profiles — from routingStore.getAllProfiles()
 * @returns {string} — human-readable model catalog for the prompt
 */
function buildModelCatalog({ backend, apiKeys, priors, profiles }) {
  // Determine which providers are available
  const availableProviders = new Set();

  if (backend === "claude-cli") {
    availableProviders.add("anthropic");
  } else if (backend === "gemini-cli") {
    availableProviders.add("gemini");
    availableProviders.add("google");
  } else {
    // HTTP — check all configured API keys
    for (const [provider, key] of Object.entries(apiKeys || {})) {
      if (key) availableProviders.add(provider);
    }
  }

  if (availableProviders.size === 0) return "";

  // Index real performance data by model+provider
  const perfIndex = new Map();
  for (const p of (profiles || [])) {
    const key = `${p.model}|${p.provider}`;
    if (!perfIndex.has(key)) perfIndex.set(key, []);
    perfIndex.get(key).push(p);
  }

  // Filter priors to available providers, skip CLI alias duplicates
  const cliAliases = new Set(["opus", "sonnet", "haiku", "auto-gemini-3"]);
  const availableModels = (priors || []).filter(p => {
    if (!availableProviders.has(p.provider)) return false;
    if (cliAliases.has(p.model)) return false;
    return true;
  });

  if (availableModels.length === 0) return "";

  const lines = ["Available models:"];

  for (const m of availableModels) {
    const scores = [];
    if (m.coding_score)    scores.push(`coding:${m.coding_score.toFixed(2)}`);
    if (m.reasoning_score) scores.push(`reasoning:${m.reasoning_score.toFixed(2)}`);
    if (m.general_score)   scores.push(`general:${m.general_score.toFixed(2)}`);

    const meta = [];
    if (m.cost_input_mtok || m.cost_output_mtok) {
      meta.push(`$${m.cost_input_mtok ?? "?"}/$${m.cost_output_mtok ?? "?"}/Mtok`);
    }
    if (m.arena_rank) meta.push(`arena #${m.arena_rank}`);

    let line = `- ${m.model} (${m.provider})`;
    if (scores.length) line += ` — ${scores.join(", ")}`;
    if (meta.length)   line += ` [${meta.join(", ")}]`;

    // Append real performance data if available
    const perf = perfIndex.get(`${m.model}|${m.provider}`);
    if (perf && perf.length > 0) {
      const best = perf.sort((a, b) => b.sample_count - a.sample_count).slice(0, 3);
      const perfParts = best.map(p =>
        `${p.domain}/${p.task_type}: ${p.avg_score.toFixed(2)} (${p.sample_count} samples)`
      );
      line += `\n  real: ${perfParts.join(", ")}`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(input, catalog) {
  const message = (input.message || "").slice(0, 600);
  const turns   = input.turnCount      || 0;
  const pending = input.pendingTodos   || 0;

  const system = `You are the routing brain for Pane, a code editor. Given a developer's message, full session context, and available models, you make two decisions:
1. Execution strategy — how should this task be handled?
2. Model routing — which specific model is best for each phase?

Strategy modes:
- "direct": single-file edits, quick fixes, one-step changes, confirmations. One model.
- "orchestrate": multi-file features, refactors, migrations, new systems, anything that touches 3+ files or needs a plan. Different models for planning vs execution.
- "discuss": questions, explanations, opinions, conceptual conversations — no code changes expected.

Key signals for "orchestrate":
- Message implies multiple files or components
- Working set has 3+ active files
- Task description mentions "build", "implement", "migrate", "refactor", "add feature"
- Recent conversation established a multi-step scope
- Project DNA or decisions suggest architectural work
- User says "let's do this", "let's build it", "let's get it done" after discussing a plan

Key signals for "direct":
- Single file mentioned or implied
- Quick fix, rename, small edit
- "fix this", "update that", "change X to Y"
- Working set has 1-2 files

Routing guidelines:
- For "orchestrate": pick the best reasoning model for planning, and a cost-efficient capable model for execution. They can be different.
- For "direct": pick one model that balances capability and cost for the task complexity.
- For "discuss": pick the cheapest model that can explain well.
- Prefer models with strong real performance data over benchmark-only models.
- If only one provider is available, pick models from that provider. Don't hallucinate models.
- When struggle_count >= 2: the current model is failing — escalate to the highest-capability available model.
- When struggle_count >= 3: require reasoning="deep" and pick the frontier model unconditionally.

Discovery: true if the task scope is unclear and needs codebase exploration before planning. false if recent conversation already established the scope or there are pending todos to continue.
Reasoning: "deep" for architecture/debugging/complex tasks, "shallow" for simple changes/quick answers.
Verification: "none" for discussion/trivial, "diff" for code changes, "test" for complex implementations.

${catalog || "No model catalog available — omit routing fields."}

The "reason" field is one sentence written for the end user — identify what kind of problem this is and state what Pane is doing about it. Confident and direct. No developer jargon, no file counts, no routing terminology. Example tone: "Complex debugging problem — applying deep reasoning to trace this carefully." or "Straightforward fix — going directly."

Output valid JSON only. No explanation outside the JSON.`;

  // Build rich context block
  const ctx = [];

  // Active task
  if (input.activeTask) {
    ctx.push(`Active task: ${input.activeTask}`);
  }

  // Session phase
  if (input.phase && input.phase !== "idle") {
    ctx.push(`Session phase: ${input.phase}`);
  }

  // Working set
  if (input.workingSet && input.workingSet.length > 0) {
    ctx.push(`Working set (${input.workingSetSize} files): ${input.workingSet.join(", ")}`);
  } else {
    ctx.push(`Working set: ${input.workingSetSize || 0} files`);
  }

  // Pending todos
  if (input.todoSummary && input.todoSummary.length > 0) {
    ctx.push(`Pending todos (${pending}): ${input.todoSummary.join("; ")}`);
  } else if (pending > 0) {
    ctx.push(`Pending todos: ${pending}`);
  }

  // Recent conversation
  if (input.recentTurns && input.recentTurns.length > 0) {
    ctx.push(`Recent conversation:\n${input.recentTurns.join("\n")}`);
  }

  // Recent actions
  if (input.recentActions && input.recentActions.length > 0) {
    ctx.push(`Recent actions: ${input.recentActions.join("; ")}`);
  }

  // Locked decisions
  if (input.decisions && input.decisions.length > 0) {
    ctx.push(`Decisions this session: ${input.decisions.join("; ")}`);
  }

  // Git
  if (input.gitBranch) {
    ctx.push(`Git: ${input.gitBranch}${input.gitSummary ? ` — ${input.gitSummary}` : ""}`);
  }

  // Codebase scope
  if (input.codebaseSize > 0) {
    ctx.push(`Codebase: ${input.codebaseSize} indexed files`);
  }

  // Relevant files from brain
  if (input.relevantFiles && input.relevantFiles.length > 0) {
    ctx.push(`Files likely involved: ${input.relevantFiles.join(", ")}`);
  }

  // Project DNA
  if (input.projectDNA) {
    ctx.push(`Project DNA: ${input.projectDNA}`);
  }

  // Struggle signal — consecutive failing turns
  if (input.struggleCount && input.struggleCount > 0) {
    ctx.push(
      `struggle_count: ${input.struggleCount} consecutive failures — ` +
      (input.struggleCount >= 3
        ? "critical: must escalate to frontier model with deep reasoning"
        : "escalate model capability and apply deeper analysis"),
    );
  }

  const contextBlock = ctx.length > 0 ? ctx.join("\n") : `turns=${turns}, files=${input.workingSetSize || 0}`;

  const user = `Message: "${message}"
${contextBlock}

{"mode":"<direct|orchestrate|discuss>","reason":"<one sentence, written for the user, not the developer — name what kind of problem this is and what Pane is doing about it, confidently and directly, no routing jargon>","discovery":<true|false>,"reasoning":"<shallow|deep>","verification":"<none|diff|test>","taskType":"<debug|implement|explain|architect|refactor|review|conversation|quick-answer|other>","complexity":"<low|medium|high>","preferFrontier":<true|false>,"atomHints":["<keyword>"],"historyDepth":<1-20>,"includeBrief":<true|false>,"fileDepth":"<none|names|shallow|deep>","planningModel":{"model":"<model-id>","provider":"<provider>"},"executionModel":{"model":"<model-id>","provider":"<provider>"}}`;

  return { system, user };
}

// ── Parse + validate ────────────────────────────────────────────────────────

function parseModelRef(ref, availableProviders) {
  if (!ref || typeof ref !== "object") return null;
  if (!ref.model || !ref.provider) return null;
  if (availableProviders && !availableProviders.has(ref.provider)) return null;
  return { model: String(ref.model), provider: String(ref.provider) };
}

function parseDecision(raw, availableProviders) {
  if (!raw) return null;

  let jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const match = jsonStr.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }

  const clamp = (v, lo, hi, def) =>
    (typeof v === "number" && !isNaN(v)) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;

  const decision = {
    // ── Classification fields ──
    mode:           VALID_MODES.has(parsed.mode)          ? parsed.mode         : null,
    reason:         typeof parsed.reason === "string"      ? parsed.reason.trim().slice(0, 300) : null,
    discovery:      typeof parsed.discovery === "boolean"  ? parsed.discovery    : true,
    reasoning:      VALID_REASONING.has(parsed.reasoning)  ? parsed.reasoning    : "deep",
    verification:   VALID_VERIFY.has(parsed.verification)  ? parsed.verification : "none",
    taskType:       VALID_TASK_TYPES.has(parsed.taskType)  ? parsed.taskType     : "other",
    complexity:     VALID_COMPLEXITY.has(parsed.complexity) ? parsed.complexity   : "medium",
    preferFrontier: typeof parsed.preferFrontier === "boolean" ? parsed.preferFrontier : false,
    atomHints:      (Array.isArray(parsed.atomHints) ? parsed.atomHints : [])
                      .filter(h => typeof h === "string" && h.length > 0 && h.length < 50).slice(0, 5),
    historyDepth:   clamp(parsed.historyDepth, 1, 20, 5),
    includeBrief:   typeof parsed.includeBrief === "boolean" ? parsed.includeBrief : true,
    fileDepth:      VALID_FILE_DEPTH.has(parsed.fileDepth) ? parsed.fileDepth    : "shallow",

    // ── Routing fields ──
    planningModel:  parseModelRef(parsed.planningModel, availableProviders),
    executionModel: parseModelRef(parsed.executionModel, availableProviders),
  };

  return decision.mode ? decision : null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify intent and route to optimal models in a single call.
 *
 * @param {object} input — { message, turnCount, hasActiveTask, workingSetSize, pendingTodos }
 * @param {(system: string, user: string) => Promise<string>} quickCall — punkEngine.quickCall
 * @param {object} catalog — { backend, apiKeys, priors, profiles }
 * @returns {Promise<object|null>}
 */
export async function classify(input, quickCall, catalog) {
  if (!quickCall) {
    console.warn("[classifier] no quickCall provided — skipping classification");
    return null;
  }

  const catalogText = catalog ? buildModelCatalog(catalog) : "";

  // Track which providers are available for validation
  const availableProviders = new Set();
  if (catalog?.backend === "claude-cli") {
    availableProviders.add("anthropic");
  } else if (catalog?.backend === "gemini-cli") {
    availableProviders.add("gemini");
    availableProviders.add("google");
  } else if (catalog?.apiKeys) {
    for (const [provider, key] of Object.entries(catalog.apiKeys)) {
      if (key) availableProviders.add(provider);
    }
  }

  const { system, user } = buildPrompt(input, catalogText);

  try {
    const raw = await quickCall(system, user);
    const decision = parseDecision(raw, availableProviders.size > 0 ? availableProviders : null);

    if (decision) {
      const planLabel = decision.planningModel
        ? `${decision.planningModel.provider}/${decision.planningModel.model}`
        : "default";
      const execLabel = decision.executionModel
        ? `${decision.executionModel.provider}/${decision.executionModel.model}`
        : "default";

      console.log(
        `[classifier] mode=${decision.mode} type=${decision.taskType} ` +
        `complexity=${decision.complexity} discovery=${decision.discovery} ` +
        `plan→${planLabel} exec→${execLabel}`
      );
    } else {
      console.warn("[classifier] unparseable response:", (raw || "").slice(0, 200));
    }

    return decision;
  } catch (err) {
    console.warn(`[classifier] failed:`, err.message);
    return null;
  }
}
