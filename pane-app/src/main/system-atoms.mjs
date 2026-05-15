// ============================================================================
// System Atoms — retired. The atom-based system prompt assembly has been
// removed. All behavioral guidance is now provided by:
//   - Identity section (Pane Intelligence Guide, closed loop, working in Pane)
//   - Profile rules (from rules.md via pane_set_rule)
//   - Project brief (about.md, decisions, memory)
//
// FACET_WEIGHTS is retained for profile atom scoring in brain-engine.mjs.
// ALL_SYSTEM_ATOMS is kept as an empty array for backward compat with
// indexSystemAtoms() which will be removed in a future cleanup pass.
// ============================================================================

export const ALL_SYSTEM_ATOMS = [];

// ── Facet weight table ───────────────────────────────────────────────────────
// Maps taskType → facet → multiplier. Applied to (cosine × priority) in scoring.
// Used by brain-engine.mjs searchAtomPool() to score profile atoms.

export const FACET_WEIGHTS = {
  debug:          { method: 1.0, rule: 1.3, guideline: 0.5, anti_pattern: 1.5, philosophy: 0.4, identity: 0.6, preference: 0.4, style: 0.3, learned: 1.2 },
  implement:      { method: 1.2, rule: 1.3, guideline: 0.8, anti_pattern: 1.0, philosophy: 0.5, identity: 0.6, preference: 0.6, style: 0.4, learned: 0.8 },
  explain:        { method: 0.3, rule: 0.5, guideline: 1.0, anti_pattern: 0.6, philosophy: 1.4, identity: 1.2, preference: 0.8, style: 1.2, learned: 0.6 },
  architect:      { method: 0.8, rule: 0.9, guideline: 0.7, anti_pattern: 0.7, philosophy: 1.5, identity: 1.2, preference: 0.6, style: 0.5, learned: 1.0 },
  refactor:       { method: 1.1, rule: 1.3, guideline: 0.6, anti_pattern: 1.4, philosophy: 0.4, identity: 0.5, preference: 0.5, style: 0.3, learned: 1.0 },
  review:         { method: 0.8, rule: 1.3, guideline: 0.7, anti_pattern: 1.5, philosophy: 0.4, identity: 0.5, preference: 0.5, style: 0.3, learned: 1.0 },
  conversation:   { method: 0.2, rule: 0.4, guideline: 0.8, anti_pattern: 0.4, philosophy: 1.4, identity: 1.3, preference: 0.8, style: 1.2, learned: 0.5 },
  "quick-answer": { method: 0.2, rule: 0.4, guideline: 0.5, anti_pattern: 0.6, philosophy: 0.5, identity: 0.5, preference: 0.5, style: 0.5, learned: 0.4 },
  other:          { method: 1.0, rule: 1.0, guideline: 1.0, anti_pattern: 1.0, philosophy: 1.0, identity: 1.0, preference: 1.0, style: 1.0, learned: 1.0 },
  _default:       { method: 1.0, rule: 1.0, guideline: 1.0, anti_pattern: 1.0, philosophy: 1.0, identity: 1.0, preference: 1.0, style: 1.0, learned: 1.0 },
};
