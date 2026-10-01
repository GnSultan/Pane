// Boost sweep. Threshold alone saturates (fires once at best); the boosting
// score controls beam-search path survival for niche words. Author examples
// use bpe pieces at score 1.0-1.4 for common phrases; a rare name needs a
// harder boost. Also: numTrailingBlanks robustness, and HEY MAYA (more
// acoustic evidence) as the primary keyword.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const DIR = path.resolve("models/kws-zipformer-en");

function makeSpotter(kwPath, thr, boost, blanks) {
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
    numTrailingBlanks: blanks,
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
function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const hits = [
  ["maya_bare", "maya"],
  ["hey_maya", "Hey Maya"],
  ["hey_q", "Hey Maya, what do you think?"],
  ["check", "Maya, can you check the build?"],
  ["mid_sentence", "so I was thinking maybe we should deploy, Maya are you listening?"],
  ["daniel", "Maya, what's the time?", "Daniel"],
];
const audio = {};
for (const [key, phrase, voice] of hits) audio[key] = sayPcm(phrase, `bs_${key}`, voice ?? "Samantha");

const distractors = [
  ["maybe", "maybe we should try again"],
  ["mycar", "my car needs a wash"],
  ["mymom", "I'll call my mom tomorrow"],
  ["matrix", "the matrix movie was great"],
  ["coffee", "I'm making coffee, do you want some?"],
];
const dAudio = {};
for (const [k, p] of distractors) dAudio[k] = sayPcm(p, `bd_${k}`);

for (const kw of ["MAYA", "HEY_MAYA"]) {
  const line = kw === "MAYA" ? "▁MA Y A @MAYA" : "▁HE Y ▁MA Y A @HEY_MAYA";
  for (const boost of [1.4, 2.5, 3.5]) {
    for (const blanks of [1, 2]) {
      fs.writeFileSync("/tmp/kws-e2e/kw-boost.txt", line + "\n");
      const s = makeSpotter("/tmp/kws-e2e/kw-boost.txt", 0.2, boost, blanks);
      const res = Object.entries(audio).map(([k, pcm]) => `${run(s, pcm) ? "✓" : "·"}`).join("");
      console.log(`${kw} boost=${boost} blanks=${blanks}: ${res}  (bare,hey,hey?,check,mid,daniel)`);
    }
  }
}
// false alarms only at the aggressive end
console.log("── false alarms @ HEY_MAYA boost=3.5 blanks=1 thr=0.2:");
fs.writeFileSync("/tmp/kws-e2e/kw-boost.txt", "▁HE Y ▁MA Y A @HEY_MAYA\n");
const sFa = makeSpotter("/tmp/kws-e2e/kw-boost.txt", 0.2, 3.5, 1);
for (const [k, pcm] of Object.entries(dAudio)) {
  console.log(`  ${k}: ${run(sFa, pcm) ? "FALSE ALARM" : "clean"}`);
}
