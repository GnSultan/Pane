// ============================================================================
// Wake Word — sherpa-onnx keyword spotting, main process.
// ============================================================================
//
// Detects a user-configurable wake phrase ("maya" by default) entirely
// locally: a 3.3M-param zipformer transducer (models/kws-zipformer-en,
// ~6MB, bundled via extraResources) runs on onnxruntime-node. No audio
// leaves the machine; nothing is uploaded; no cloud service involved.
//
// The renderer captures 16 kHz PCM, downsamples in an AudioWorklet, and
// forwards chunks over IPC (`wake_word_feed`). This module owns the
// spotter, encodes the configured phrase into the model's BPE token
// vocabulary, and pushes `wake_word_detected` to the renderer on a hit.
// Thresholds are tuned per-phrase: longer phrases accumulate more acoustic
// evidence, so they tolerate lower thresholds; a bare name needs to stay
// picky to avoid false alarms in everyday speech.

// Electron import is deferred to registration: the module's core (encode,
// spotter, feed) must be unit-testable in plain node, where the electron
// stub has no ipcMain export. registerWakeWordIpc() is the only electron
// touchpoint.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveModelCache } from "./model-paths.mjs";

const require = createRequire(import.meta.url);

// Lazy require: sherpa-onnx-node loads onnxruntime native binaries — keep
// it out of the module graph until first use so unrelated startup paths
// never pay for (or crash on) it.
/** @type {typeof import("sherpa-onnx-node") | null} */
let sherpaMod = null;

const MODEL_DIR = "kws-zipformer-en";
const ENC = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const DEC = "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
const JOIN = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const TOKENS = "tokens.txt";

/** Boosting score — how hard beam search favors paths containing the
 *  keyword. Calibrated Sep 2026 on TTS speech (6 voices): boost 1.4 gives
 *  near-zero hits for a rare name; 2.5 yields 6/6 detection with 0/10
 *  false alarms on everyday sentences at threshold 0.08. */
const KEYWORDS_SCORE = 2.5;
/** Global trigger threshold. Calibrated: 0.08 = full detection, no false
 *  alarms; the per-keyword refinement below only loosens LONGER phrases
 *  that carry more acoustic evidence. */
const KEYWORDS_THRESHOLD = 0.06;

// ── BPE encoder: phrase → token pieces ───────────────────────────────────
// The gigaspeech KWS model uses a 500-piece BPE vocabulary where ▁ marks
// word starts. Exact segmentation matters: the transducer only fires when
// the keyword's token path matches what it would decode — SentencePiece's
// canonical segmentation, which is Viterbi (highest total-score path over
// the piece lattice), NOT greedy longest-match (ATHENA greedy = ▁AT HE N A,
// canonical = ▁A TH EN A — the greedy line never fires) and NOT rank-ordered
// pair merging (NOVA needs ▁NO, unreachable pair-wise). Piece scores come
// from bpe.model (field 2 of each protobuf piece entry; tokens.txt carries
// no scores). The protobuf walk below reads exactly those two fields.

/** Parse bpe.model protobuf → Map(piece → score). Layout: repeated field 1
 *  messages, each with field 1 = piece bytes (varint-prefixed) and field 2
 *  = score (fixed32 LE float). Unknown fields inside a piece are skipped
 *  by length. */
export function parseBpeScores(buf) {
  const scores = new Map();
  const n = buf.length;
  let i = 0;
  while (i < n && buf[i] === 0x0a) {
    i++;
    let len = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++];
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const end = i + len;
    let piece = null;
    let score = 0;
    while (i < end) {
      const tag = buf[i++];
      if (tag === 0x0a) {
        let plen = 0;
        let pshift = 0;
        for (;;) {
          const b = buf[i++];
          plen |= (b & 0x7f) << pshift;
          pshift += 7;
          if (!(b & 0x80)) break;
        }
        piece = buf.subarray(i, i + plen).toString("utf8");
        i += plen;
      } else if (tag === 0x15) {
        score = buf.readFloatLE(i);
        i += 4;
      } else {
        break; // unrecognized inner field — stop scanning this piece
      }
    }
    if (piece !== null && !scores.has(piece)) scores.set(piece, score);
    i = end;
  }
  return scores;
}

function loadVocab(tokensPath, bpeModelPath) {
  const lines = fs.readFileSync(tokensPath, "utf8").split("\n");
  const vocabSet = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    vocabSet.add(line.slice(0, line.lastIndexOf(" ")));
  }
  let scores = null;
  if (fs.existsSync(bpeModelPath)) {
    scores = parseBpeScores(fs.readFileSync(bpeModelPath));
  }
  return { vocabSet, scores };
}

/** Canonical SentencePiece segmentation of one word via Viterbi over the
 *  piece lattice. Input is uppercased (the model's BPE was trained on
 *  uppercase text; lowercase paths route to <unk>). */
function encodeWord(word, vocab) {
  const s = `▁${word.toUpperCase()}`;
  const { vocabSet, scores } = vocab;
  // best[i] = { score, from } for the prefix ending at char i
  const best = [{ score: 0, from: -1, piece: null }];
  for (let end = 1; end <= s.length; end++) {
    let bestScore = -Infinity;
    let bestFrom = -1;
    let bestPiece = null;
    for (let start = Math.max(0, end - 20); start < end; start++) {
      const piece = s.slice(start, end);
      if (!vocabSet.has(piece)) continue;
      const pScore = scores?.get(piece) ?? -10; // rank fallback when no bpe.model
      const total = best[start].score + pScore;
      if (total > bestScore) {
        bestScore = total;
        bestFrom = start;
        bestPiece = piece;
      }
    }
    if (bestFrom === -1) return null; // unencodable prefix
    best.push({ score: bestScore, from: bestFrom, piece: bestPiece });
  }
  // walk backpointers
  const out = [];
  let pos = s.length;
  while (pos > 0) {
    const b = best[pos];
    out.unshift(b.piece);
    pos = b.from;
  }
  return out;
}

/** Encode a phrase into token pieces; throws with a clear message when the
 *  phrase uses characters the vocabulary cannot represent. */
export function encodeWakePhrase(phrase, tokensPath) {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("wake phrase is empty");
  const vocab = loadVocab(tokensPath, path.join(path.dirname(tokensPath), "bpe.model"));
  const pieces = [];
  for (const w of words) {
    const enc = encodeWord(w, vocab);
    if (!enc) {
      throw new Error(
        `wake phrase word "${w}" cannot be encoded with the KWS vocabulary`,
      );
    }
    pieces.push(...enc);
  }
  return pieces;
}

/** Last word of the phrase — the name itself. Registered alongside the
 *  full phrase so "maya" and "hey maya" both fire. */
function lastWord(phrase) {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  return words[words.length - 1];
}

/** Does tokens.txt contain this piece? (variant-path guard) */
function vocabHasPiece(tokensPath, piece) {
  try {
    const lines = fs.readFileSync(tokensPath, "utf8").split("\n");
    return lines.some((l) => l.startsWith(`${piece} `));
  } catch {
    return false;
  }
}

/** Per-phrase threshold refinement: acoustic evidence scales with token
 *  count, so longer phrases run looser than the global floor. */
function thresholdForTokens(tokens) {
  if (tokens.length >= 6) return 0.05;
  if (tokens.length >= 4) return 0.06;
  return 0.06; // bare short names — calibrated floor
}

// ── Spotter lifecycle ─────────────────────────────────────────────────────

/** @type {import("sherpa-onnx-node").KeywordSpotter | null} */
let spotter = null;
/** @type {import("sherpa-onnx-node").OnlineStream | null} */
let stream = null;
let modelDir = null;
let activePhrase = null;

function resolveModelDir() {
  const { cacheDir } = resolveModelCache();
  const dir = path.join(cacheDir, MODEL_DIR);
  if (fs.existsSync(path.join(dir, TOKENS))) return dir;
  return null;
}

function spotterConfig(kwPath) {
  const dir = modelDir ?? resolveModelDir() ?? "";
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, ENC),
        decoder: path.join(dir, DEC),
        joiner: path.join(dir, JOIN),
      },
      tokens: path.join(dir, TOKENS),
      numThreads: 1,
      debug: false,
    },
    keywordsFile: kwPath,
    keywordsScore: KEYWORDS_SCORE,
    keywordsThreshold: KEYWORDS_THRESHOLD,
  };
}

/** Configure the spotter for `phrase`. Returns {ok, error?}; ok:false with
 *  a clear error when the model is missing or the phrase can't be encoded. */
export function configureWakeWord(phrase) {
  const dir = resolveModelDir();
  if (!dir) return { ok: false, error: "kws model not found — run npm run download-kws-model" };
  modelDir = dir;

  if (!sherpaMod) {
    try {
      sherpaMod = require("sherpa-onnx-node");
    } catch (err) {
      return { ok: false, error: `sherpa-onnx-node unavailable: ${err?.message ?? err}` };
    }
  }

  const tokensPath = path.join(dir, TOKENS);
  let pieces;
  try {
    pieces = encodeWakePhrase(phrase, tokensPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Keywords file: token pieces, @display, :boost, #threshold. Register
  // EVERY pronunciable path: the full phrase, the bare name, and for a
  // name whose US/UK pronunciations differ (MAH-yah vs MY-ah) the ▁MY
  // variant too. Each is a separate beam-search keyword; any fires.
  const display = phrase.trim().toUpperCase().replace(/\s+/g, "_");
  const name = lastWord(phrase);
  const namePieces = encodeWakePhrase(name, tokensPath);
  const lines = new Set([
    `${pieces.join(" ")} @${display} :${KEYWORDS_SCORE} #${thresholdForTokens(pieces)}`,
    `${namePieces.join(" ")} @${display} :${KEYWORDS_SCORE} #${thresholdForTokens(namePieces)}`,
  ]);
  // Pronunciation variants: US "MAH-yah" segments ▁MA Y A, UK "MY-ah"
  // segments ▁MY A — the Y diphthong moves between pieces. Register the
  // alternate path when the name's encoding matches either shape.
  const first = namePieces[0] ?? "";
  const variantOf = (pieces) => {
    if (first === "▁MA" && namePieces[1] === "Y") return ["▁MY", ...namePieces.slice(2)];
    if (first === "▁MY" && namePieces[1] === "A") return ["▁MA", "Y", ...namePieces.slice(1)];
    return null;
  };
  const variant = variantOf(namePieces);
  if (variant && !variant.some((p) => !vocabHasPiece(tokensPath, p))) {
    lines.add(
      `${variant.join(" ")} @${display} :${KEYWORDS_SCORE} #${thresholdForTokens(variant)}`,
    );
  }
  const kwPath = path.join(dir, "keywords-active.txt");
  fs.writeFileSync(kwPath, [...lines].join("\n") + "\n");

  // The node binding exposes no keywords-file swap on a live spotter, so a
  // phrase change rebuilds the spotter — cheap after the first load since
  // onnxruntime keeps the model pages warm.
  try {
    spotter = new sherpaMod.KeywordSpotter(spotterConfig(kwPath));
  } catch (err) {
    spotter = null;
    stream = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  stream = spotter.createStream();
  activePhrase = phrase.trim().toLowerCase();
  return { ok: true };
}

let lastHitAt = 0;
/** Cooldown so one utterance can't double-trigger (echo/decoder overlap). */
const HIT_COOLDOWN_MS = 1200;

/** Feed 16 kHz mono Float32 PCM. Returns the detected keyword or null. */
export function feedWakeWord(samples) {
  if (!spotter || !stream) return null;
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  while (spotter.isReady(stream)) {
    spotter.decode(stream);
    const result = spotter.getResult(stream);
    const kw = result?.keyword;
    if (kw) {
      const now = Date.now();
      spotter.reset(stream);
      if (now - lastHitAt > HIT_COOLDOWN_MS) {
        lastHitAt = now;
        return kw;
      }
    }
  }
  return null;
}

export function disposeWakeWord() {
  stream = null;
  spotter = null;
  activePhrase = null;
}

export function wakeWordStatus() {
  return {
    active: spotter !== null && stream !== null,
    phrase: activePhrase,
    modelFound: resolveModelDir() !== null,
  };
}

// ── IPC surface ───────────────────────────────────────────────────────────
// wake_word_configure {phrase} → {ok, error?}
// wake_word_feed Float32Array → fire-and-forget hot path; detection is
//   PUSHED as `wake_word_detected` to the sender (no per-chunk round-trip).
// wake_word_dispose → {ok}
// wake_word_status → {active, phrase, modelFound}

// ipcMain is injected by the caller: this module is ESM and main.mjs
// already holds the electron import — no require() here.
export function registerWakeWordIpc(ipcMain) {
  ipcMain.handle("wake_word_configure", (_e, { phrase }) => {
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      return { ok: false, error: "phrase required" };
    }
    return configureWakeWord(phrase);
  });

  ipcMain.on("wake_word_feed", (event, samples) => {
    if (!(samples instanceof Float32Array) || samples.length === 0) return;
    const hit = feedWakeWord(samples);
    if (hit) {
      try {
        event.sender.send("wake_word_detected", hit);
      } catch {
        /* window closed — nothing to notify */
      }
    }
  });

  ipcMain.handle("wake_word_dispose", () => {
    disposeWakeWord();
    return { ok: true };
  });

  ipcMain.handle("wake_word_status", () => wakeWordStatus());
}
