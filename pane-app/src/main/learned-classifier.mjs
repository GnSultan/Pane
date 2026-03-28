// Learned Semantic Classifier for Pane Routing
// Naive Bayes over tokenized prompts with outcome-weighted training
// Zero external dependencies — runs locally in ~0.1ms

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const MODEL_PATH = path.join(PANE_DIR, "classifier-model.json");

// Smoothing constant (Laplace)
const ALPHA = 1.0;

// --- Tokenization ---------------------------------------------------------

/**
 * Tokenize a prompt into normalized tokens.
 * - lowercase
 * - split on non-word chars
 * - filter empties, drop pure numbers
 * - keep meaningful length range
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/_/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 32 && !/^\d+$/.test(t));
}

/**
 * Generate bigrams from token array: [a,b,c] -> ["a b", "b c"]
 */
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(tokens[i] + " " + tokens[i+1]);
  }
  return out;
}

// --- Classifier Core -------------------------------------------------------

/**
 * LearnedClassifier implements amultinomial Naive Bayes for routing classes.
 *
 * Routing classes are composite: we model mode, taskType, modelTier, escalationStage
 * as a joint distribution P(tokens | mode, taskType, tier, stage) × P(mode,taskType,tier,stage)
 *
 * We store:
 *   classPriors[compositeClass] = log P(compositeClass)
 *   tokenCounts[token][compositeClass] = weighted count of token in that class
 *   classTokenTotal[compositeClass] = total weighted token count for class
 *   vocab = set of seen tokens
 *
 * Composite class format: `${mode}/${taskType}/${tier}/${stage}`
 *   stage = numeric (0-5) or "0" for direct/discuss/cheap cases
 */
export class LearnedClassifier {
  constructor() {
    this.classPriors = {};
    this.tokenCounts = new Map();
    this.classTokenTotal = {};
    this.vocab = new Set();
    this.sampleCount = 0;
    this.lastTrained = 0;
    this.accuracy = null;
  }

  toJSON() {
    const tokenCountsObj = {};
    for (const [token, classMap] of this.tokenCounts.entries()) {
      tokenCountsObj[token] = Object.fromEntries(classMap);
    }
    return {
      classPriors: this.classPriors,
      tokenCounts: tokenCountsObj,
      classTokenTotal: this.classTokenTotal,
      vocab: Array.from(this.vocab),
      sampleCount: this.sampleCount,
      lastTrained: this.lastTrained,
      accuracy: this.accuracy,
      version: 1
    };
  }

  static fromJSON(data) {
    const clf = new LearnedClassifier();
    clf.classPriors = data.classPriors || {};
    clf.classTokenTotal = data.classTokenTotal || {};
    clf.vocab = new Set(data.vocab || []);
    clf.sampleCount = data.sampleCount || 0;
    clf.lastTrained = data.lastTrained || 0;
    clf.accuracy = data.accuracy ?? null;
    clf.tokenCounts = new Map();
    for (const [token, classMap] of Object.entries(data.tokenCounts || {})) {
      clf.tokenCounts.set(token, new Map(Object.entries(classMap)));
    }
    return clf;
  }

  async save() {
    await fs.mkdir(PANE_DIR, { recursive: true });
    const json = JSON.stringify(this.toJSON(), null, 0);
    await fs.writeFile(MODEL_PATH, json, "utf8");
  }

  static async load() {
    try {
      const raw = await fs.readFile(MODEL_PATH, "utf8");
      const data = JSON.parse(raw);
      return this.fromJSON(data);
    } catch (e) {
      if (e.code !== "ENOENT") console.error("[classifier] load failed:", e);
      return null;
    }
  }

  trainOne({ prompt, mode, taskType, modelTier, escalationStage, outcomeScore }) {
    const tokens = tokenize(prompt);
    if (tokens.length === 0) return;

    const stage = (escalationStage || 0).toString();
    const composite = `${mode}/${taskType}/${modelTier}/${stage}`;

    if (!(composite in this.classPriors)) {
      this.classPriors[composite] = 0;
      this.classTokenTotal[composite] = 0;
    }

    const weight = Math.max(0.01, outcomeScore);
    this.classPriors[composite] += weight;
    this.sampleCount += weight;

    const uniqTokens = new Set(tokens);
    for (const token of uniqTokens) {
      this.vocab.add(token);
      let classMap = this.tokenCounts.get(token);
      if (!classMap) {
        classMap = new Map();
        this.tokenCounts.set(token, classMap);
      }
      classMap.set(composite, (classMap.get(composite) || 0) + weight);
      this.classTokenTotal[composite] += weight;
    }
  }

  finishTraining() {
    if (this.sampleCount === 0) return;
    for (const cls in this.classPriors) {
      const count = this.classPriors[cls];
      this.classPriors[cls] = Math.log(count / this.sampleCount);
    }
    this.vocabSize = this.vocab.size;
  }

  predict(prompt) {
    const tokens = tokenize(prompt);
    if (tokens.length === 0) {
      return { mode: "direct", taskType: "conversation", modelTier: "cheap", confidence: 0 };
    }

    const features = [...tokens, ...bigrams(tokens)];
    const uniqFeats = new Set(features);

    let bestScore = -Infinity;
    let bestClass = null;
    const scores = {};

    const denomCache = {};
    for (const cls in this.classPriors) {
      const total = this.classTokenTotal[cls] || 0;
      denomCache[cls] = total + ALPHA * this.vocabSize;
    }

    for (const cls in this.classPriors) {
      let logProb = this.classPriors[cls];
      for (const feat of uniqFeats) {
        let count = 0;
        const classMap = this.tokenCounts.get(feat);
        if (classMap) count = classMap.get(cls) || 0;
        const prob = (count + ALPHA) / denomCache[cls];
        logProb += Math.log(prob);
      }
      scores[cls] = logProb;
      if (logProb > bestScore) {
        bestScore = logProb;
        bestClass = cls;
      }
    }

    const [mode, taskType, modelTier, stage] = bestClass.split("/");

    const maxScore = bestScore;
    let sumExp = 0;
    for (const s of Object.values(scores)) {
      sumExp += Math.exp(s - maxScore);
    }
    const confidence = Math.exp(maxScore - maxScore) / sumExp;

    return {
      mode,
      taskType: taskType === "plan" ? "plan" : taskType,
      modelTier,
      confidence: Math.min(1, Math.max(0, confidence))
    };
  }
}