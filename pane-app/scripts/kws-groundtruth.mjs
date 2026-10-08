// Ground-truth test: the model's own test_wavs + its own test_keywords.txt
// through our exact feeding loop. Then the same loop with our MAYA phrase
// (raw headerless PCM this time).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const ORIG = "/tmp/kws-e2e/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const DIR = path.resolve("models/kws-zipformer-en");

function makeSpotter(kwPath) {
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(DIR, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        decoder: path.join(DIR, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        joiner: path.join(DIR, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
      },
      tokens: path.join(DIR, "tokens.txt"),
      numThreads: 1,
      debug: false,
    },
    keywordsFile: kwPath,
    keywordsScore: 1.4,
    keywordsThreshold: 0.25,
  });
}

function run(spotter, pcm) {
  const stream = spotter.createStream();
  let hit = null;
  for (let i = 0; i < pcm.length; i += 1600) {
    stream.acceptWaveform({ samples: pcm.subarray(i, i + 1600), sampleRate: 16000 });
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      const r = spotter.getResult(stream);
      if (r?.keyword) { hit = r.keyword; spotter.reset(stream); }
    }
  }
  return hit;
}

// WAV (16-bit PCM from the tarball) → Float32
function wavToPcm(wavPath) {
  const buf = fs.readFileSync(wavPath);
  // naive: find "data" chunk
  const di = buf.indexOf("data");
  const samples16 = buf.subarray(di + 8);
  const n = Math.floor(samples16.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples16.readInt16LE(i * 2) / 32768;
  return out;
}

// ── 1. ground truth: model's own wavs + own keywords ─────────────────────
const gtSpotter = makeSpotter(path.join(ORIG, "test_wavs", "test_keywords.txt"));
const wavs = fs.readdirSync(path.join(ORIG, "test_wavs")).filter((f) => f.endsWith(".wav"));
for (const w of wavs) {
  const pcm = wavToPcm(path.join(ORIG, "test_wavs", w));
  console.log(`${w}: ${run(gtSpotter, pcm) ?? "—"}`);
}

// ── 2. MAYA, raw PCM via ffmpeg pipe (header stripped) ──────────────────
function sayPcm(phrase, name) {
  const raw = `/tmp/kws-e2e/${name}.raw`;
  execSync(`say -v Samantha -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le ${raw}`, { stdio: "pipe" });
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const variants = [
  ["plain pieces, no suffix", "▁MA Y A"],
  ["with @display", "▁MA Y A @MAYA"],
  ["with score+threshold", "▁MA Y A @MAYA :1.4 #0.25"],
  ["lowercase maya", "▁ma y a"],
];
const mayaPcm = sayPcm("maya", "maya_clean");
for (const [label, line] of variants) {
  const kw = `/tmp/kws-e2e/kw-maya.txt`;
  fs.writeFileSync(kw, line + "\n");
  const s = makeSpotter(kw);
  console.log(`MAYA [${label}]: ${run(s, mayaPcm) ?? "—"}`);
}
