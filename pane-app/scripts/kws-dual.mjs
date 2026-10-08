// UK-pronunciation variant: register BOTH token paths for the name —
// ▁MA Y A (US "MAH-yah") and ▁MY A (UK "MY-ah"). Daniel/Moira say MY-ah;
// Samantha/Karen say MAH-yah-ish. Test dual-path detection.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const DIR = path.resolve("models/kws-zipformer-en");
function makeSpotter(kwPath, thr, boost) {
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
    keywordsScore: boost,
    keywordsThreshold: thr,
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
function sayPcm(phrase, name, voice) {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// dual-path keywords
const LINES = [
  "▁MA Y A @MAYA :2.5 #0.06",
  "▁MY A @MAYA :2.5 #0.06",
  "▁HE Y ▁MA Y A @HEY_MAYA :2.5 #0.05",
  "▁HE Y ▁MY A @HEY_MAYA :2.5 #0.05",
];
fs.writeFileSync("/tmp/kws-e2e/kw-dual.txt", LINES.join("\n") + "\n");

const tests = [
  ["Samantha", "Hey Maya, what do you think?"],
  ["Daniel", "Maya, can you check the build?"],
  ["Moira", "hey maya are you listening"],
  ["Karen", "Maya what's the time"],
  ["Daniel", "Maya, what's the time"],
  ["Moira", "Maya, check this out"],
];
const dAudio = [
  ["Samantha", "maybe we should try again tomorrow"],
  ["Daniel", "my car needs a wash"],
  ["Moira", "I'll call my mom tomorrow"],
  ["Karen", "the matrix movie was great"],
];

for (const thr of [0.06, 0.05, 0.04]) {
  const s = makeSpotter("/tmp/kws-e2e/kw-dual.txt", thr, 2.5);
  let hits = 0;
  const results = [];
  for (const [v, p] of tests) {
    const r = run(s, sayPcm(p, `dp_${v}_${p.length}`, v));
    if (r) hits++;
    results.push(r ? "✓" : "✗");
  }
  let fa = 0;
  for (const [v, p] of dAudio) {
    if (run(s, sayPcm(p, `df_${v}_${p.length}`, v))) fa++;
  }
  console.log(`thr=${thr}: ${hits}/${tests.length} ${results.join("")} | FA ${fa}/${dAudio.length}`);
}
