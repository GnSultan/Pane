// ============================================================================
// Routing Oracle
// ============================================================================
//
// Consults routing-store to rank available models for a task.
// Returns null when there's insufficient data — strategy engine falls back
// to the static routing table.
//
// Two data sources, in priority order:
//   1. Real outcomes from Pane usage   — grows with every interaction
//   2. Benchmark priors                — seeded at startup, overridden by experience
//
// Exploration: epsilon-greedy. Occasionally tries a non-top model to gather
// data and discover underrated models. Epsilon decays as sample count grows.
//

import { routingStore } from "./routing-store.mjs";

// ── Domain classification ──────────────────────────────────────────────────
//
// Derived from prompt text. Used as one axis in the capability profile key
// so the store can learn that model X is great at debugging but weak at
// architecture, independently.

export function classifyDomain(prompt) {
  const t = prompt.toLowerCase();
  if (/\b(architect|design|system design|pattern|scalab|restructur|rearchitect|high.level)\b/.test(t)) return "architecture";
  if (/\b(bug|error|crash|fail|broken|exception|undefined|null pointer|stack trace|traceback|not working)\b/.test(t)) return "debugging";
  if (/\b(deploy|docker|compose|kubernetes|nginx|ci\b|cd\b|pipeline|infra|server|container|devops)\b/.test(t)) return "devops";
  if (/\b(refactor|migrate|overhaul|rewrite|cleanup|clean up|restructure)\b/.test(t)) return "refactoring";
  if (/^(what|why|how|explain|tell me|can you|do you|could you)\b/.test(t)) return "explanation";
  if (/\b(implement|add feature|create|build|write|generate|integrate)\b/.test(t)) return "implementation";
  if (/\b(security|auth|authentication|authorization|oauth|jwt|csrf|xss|injection|vulnerability|exploit|penetration|encrypt|decrypt|hash|certificate|ssl|tls)\b/.test(t)) return "security";
  return "general";
}

// ── Exploration rate ───────────────────────────────────────────────────────
//
// Epsilon-greedy: start at 15%, decay to 5% as we accumulate samples.
// Exploration lets the system discover that a cheaper model is better for
// certain task types, or that a new model outperforms the current leader.

function explorationRate(totalSamples) {
  return Math.max(0.05, 0.15 * Math.exp(-totalSamples / 60));
}

// ── Oracle ────────────────────────────────────────────────────────────────
//
// Main entry point. Returns null when the oracle doesn't have enough
// confidence to override the heuristic — callers should fall back to their
// static routing table in that case.
//
// @param {string}  taskType   "direct" | "orchestrate" | "discuss"
// @param {string}  domain     from classifyDomain()
// @param {Array}   candidates [{ model, provider }] — user-configured options
// @returns {{ top: {model,provider}, score, confidence, exploring } | null}

export function consult(taskType, domain, candidates, projectId = '') {
  if (!candidates || candidates.length <= 1) return null;

  const scored = candidates.map(({ model, provider }) => {
    const profile = routingStore.getProfile(model, provider, domain, taskType, projectId);
    const prior   = routingStore.getPrior(model, provider);

    let score      = null;
    let confidence = 0;
    let samples    = profile?.sample_count ?? 0;

    if (profile && samples >= 3) {
      // Real experience — confidence grows with sample count, caps at 0.92
      score      = profile.avg_score;
      confidence = Math.min(0.92, 0.50 + samples * 0.025);
    } else if (prior) {
      // Benchmark prior — conservative confidence, slight bump per real sample
      score      = _priorScore(prior, domain, taskType);
      confidence = Math.min(0.45, 0.30 + samples * 0.05);
    }

    // Cost-efficiency adjustment — blend quality score with cost factor.
    // A model that's 10x cheaper for the same quality wins on routine tasks.
    // Weight shifts: cost matters most for direct tasks, least for orchestrate.
    if (score !== null && prior) {
      const costFactor = _costFactor(prior, taskType);
      score = score * costFactor;
    }

    return { model, provider, score, confidence, samples };
  });

  const withData = scored.filter(s => s.score !== null);
  if (withData.length === 0) return null;

  // Sort by score descending
  withData.sort((a, b) => b.score - a.score);

  // Epsilon-greedy exploration: occasionally surface a non-top model
  const totalSamples = withData.reduce((n, s) => n + s.samples, 0);
  const ε = explorationRate(totalSamples);
  let exploring = false;

  if (Math.random() < ε && withData.length > 1) {
    const idx  = 1 + Math.floor(Math.random() * (withData.length - 1));
    const pick = withData.splice(idx, 1)[0];
    withData.unshift(pick);
    exploring = true;
    console.log(`[oracle] 🔬 exploring ${pick.model} (ε=${ε.toFixed(2)}, samples=${totalSamples})`);
  }

  const best = withData[0];

  // Don't override the heuristic if we're not confident
  if (best.confidence < 0.30) return null;

  return {
    top:        { model: best.model, provider: best.provider },
    score:      best.score,
    confidence: best.confidence,
    exploring,
    sampleCount: best.samples,
  };
}

// ── Prior score derivation ─────────────────────────────────────────────────

function _priorScore(prior, domain) {
  let score;

  switch (domain) {
    case "architecture":
    case "refactoring":
      score = prior.reasoning_score ?? prior.coding_score ?? prior.general_score ?? 0.5;
      break;
    case "debugging":
    case "implementation":
      score = prior.coding_score ?? prior.reasoning_score ?? prior.general_score ?? 0.5;
      break;
    case "devops":
      score = (prior.coding_score ?? 0.5) * 0.6 + (prior.reasoning_score ?? 0.5) * 0.4;
      break;
    case "security":
      score = ((prior.coding_score ?? 0.5) + (prior.reasoning_score ?? 0.5)) / 2;
      break;
    default:
      score = prior.general_score ?? prior.reasoning_score ?? prior.coding_score ?? 0.5;
  }

  // Arena rank signal: top models get a modest boost, very low ranks a penalty
  if (prior.arena_rank != null) {
    if (prior.arena_rank <= 5)  score = Math.min(1.0, score * 1.10);
    else if (prior.arena_rank <= 15) score = Math.min(1.0, score * 1.05);
    else if (prior.arena_rank > 40)  score = score * 0.90;
  }

  return Math.max(0, Math.min(1, score));
}

// ── Cost-efficiency factor ─────────────────────────────────────────────────
//
// Returns a multiplier (0.85–1.15) that nudges scores based on token cost.
// A model at 1/10th the cost of a reference gets a bonus; 10x costs get a
// penalty. The weight of this factor scales by task type — cost matters more
// for routine direct tasks than for complex architectural work where quality
// is paramount.
//
// Reference point: claude-sonnet-4 at $3 input / $15 output per Mtok.
// A typical task: ~800 input tokens, ~1200 output tokens.

const REF_COST_PER_CALL = (3 * 0.0008) + (15 * 0.0012); // ~$0.0204

function _costFactor(prior, taskType) {
  const inputMtok  = prior.cost_input_mtok;
  const outputMtok = prior.cost_output_mtok;
  if (!inputMtok && !outputMtok) return 1.0; // no cost data, neutral

  const costPerCall = (inputMtok * 0.0008) + (outputMtok * 0.0012);
  if (costPerCall <= 0) return 1.0;

  // Efficiency ratio: how much cheaper than reference (log-scaled to avoid extremes)
  const ratio = REF_COST_PER_CALL / costPerCall;
  const logRatio = Math.log2(ratio); // 0 = same cost, +1 = 2x cheaper, -1 = 2x more expensive

  // Weight by task type: cost matters most for direct, least for orchestrate
  const weight = taskType === "orchestrate" ? 0.06
               : taskType === "discuss"     ? 0.04
               :                             0.10; // direct

  // Cap adjustment at ±15%
  const adjustment = Math.max(-0.15, Math.min(0.15, logRatio * weight));
  return 1.0 + adjustment;
}
