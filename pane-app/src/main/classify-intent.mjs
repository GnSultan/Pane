// ============================================================================
// Intent Classifier
// ============================================================================

/**
 * Classify the intent of a prompt as 'plan' or 'execute'.
 * Zero latency — pure heuristic, no LLM call.
 *
 * plan   → architectural/reasoning requests routed to deep-thinking model (DeepSeek V3.2 Speciale)
 * execute → implementation/generation requests routed to fast model (DeepSeek V3.2)
 *
 * @param {string} prompt
 * @returns {{ intent: 'plan' | 'execute', confidence: number, reason: string }}
 */
export function classifyIntent(prompt) {
  const text = prompt.toLowerCase().trim();
  const words = text.split(/\s+/);
  const wordCount = words.length;

  // Hard-coded pass-through signals (user explicitly overrides routing)
  if (/^\/plan\b/.test(text))
    return { intent: "plan", confidence: 1.0, reason: "explicit /plan flag" };
  if (/^\/exec\b/.test(text))
    return {
      intent: "execute",
      confidence: 1.0,
      reason: "explicit /exec flag",
    };

  // Short command-like prompts → always execute
  const shortCommands =
    /^(go|proceed|yes|do it|start|build it|write it|make it|ship it|run it|ok|okay|yep|yeah|continue|next)\.?$/;
  if (shortCommands.test(text)) {
    return { intent: "execute", confidence: 0.95, reason: "short command" };
  }

  // Score plan signals
  const planPatterns = [
    [/\b(architect|architecture)\b/, "architecture keyword"],
    [/\b(design|redesign|rethink|rearchitect)\b/, "design keyword"],
    [
      /\b(should (i|we)|how should (i|we)|what('s| is) the (best|right))\b/,
      "deliberative phrasing",
    ],
    [
      /\b(approach|strategy|structure|pattern|principle|philosophy)\b/,
      "strategy keyword",
    ],
    [
      /\b(tradeoff|trade-off|compare|versus|\bvs\.?\b|pros and cons)\b/,
      "comparison phrasing",
    ],
    [
      /\b(think (through|about)|plan|decide|evaluate|assess|consider)\b/,
      "planning verb",
    ],
    [
      /\b(why (do|should|would|is|are)|what if|how (do|would|should) (you|i|we))\b/,
      "reasoning question",
    ],
    [
      /\b(best practice|anti-pattern|refactor|overhaul|migrate)\b/,
      "refactor keyword",
    ],
    [
      /\b(explain|understand|clarify|walk me through|breakdown|break down)\b/,
      "explain keyword",
    ],
    [/\?([\s]|$)/, "ends with question"],
  ];

  // Score execute signals
  const executePatterns = [
    [/\b(implement|write|create|build|add|make|generate)\b/, "creation verb"],
    [
      /\b(fix|update|change|rename|delete|remove|move|edit|patch|debug)\b/,
      "mutation verb",
    ],
    [
      /\b(just|quickly|fast|now|go ahead|ahead and|please (write|add|fix))\b/,
      "urgency/directive",
    ],
    [
      /\b(file|function|component|class|module|endpoint|route|hook|type)\b/,
      "code artifact noun",
    ],
    [
      /\b(install|import|export|deploy|run|test|lint|format)\b/,
      "dev operation",
    ],
    [/```|`[^`]+`/, "contains code"],
  ];

  let planScore = 0;
  let executeScore = 0;
  const reasons = [];

  for (const [re, label] of planPatterns) {
    if (re.test(text)) {
      planScore++;
      reasons.push(`plan:${label}`);
    }
  }
  for (const [re, label] of executePatterns) {
    if (re.test(text)) {
      executeScore++;
      reasons.push(`exec:${label}`);
    }
  }

  // Length bias: very long prompts skewing toward plan are likely discussions
  if (wordCount > 60 && planScore >= executeScore) {
    planScore += 1;
    reasons.push("plan:long-form prompt");
  }

  // Bias toward execute for short prompts with no strong plan signal
  if (wordCount < 12 && planScore === 0) {
    executeScore += 1;
    reasons.push("exec:short prompt fallback");
  }

  if (planScore > executeScore) {
    return {
      intent: "plan",
      confidence: Math.min(0.95, 0.6 + planScore * 0.07),
      reason: reasons.join(", "),
    };
  }
  if (executeScore > planScore) {
    return {
      intent: "execute",
      confidence: Math.min(0.95, 0.6 + executeScore * 0.07),
      reason: reasons.join(", "),
    };
  }

  // Tie → default to execute (bias toward action in a sprint)
  return {
    intent: "execute",
    confidence: 0.5,
    reason: "tie → execute default",
  };
}
