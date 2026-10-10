// Operating-point calibration. Confirmed: ▁MA Y A fires at thr=0.15 on
// "Hey Maya, are you there?". Now: (1) does adding HEY MAYA as a second
// keyword line help bare "maya"? (2) false alarms on everyday sentences?
// (3) final threshold choice balancing both.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const DIR = path.resolve("models/kws-zipformer-en");

function makeSpotter(kwPath, thr) {
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
function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// keyword lines: both MAYA and HEY MAYA (author-style decomposition)
const KEYWORDS = `▁MA Y A @MAYA
▁HE Y ▁MA Y A @HEY_MAYA`;

const hits = [
  ["maya", "Samantha"], ["Hey Maya", "Samantha"],
  ["Hey Maya, what do you think?", "Samantha"],
  ["Maya, can you check the build?", "Daniel"],
  ["so I was thinking maybe we should deploy, Maya are you listening?", "Samantha"],
];
const distractors = [
  ["my car needs a wash", "Samantha"],
  ["I'll call my mom tomorrow", "Daniel"],
  ["the matrix movie was great", "Samantha"],
  ["maybe we should try again", "Samantha"],
  ["my youngest sister is visiting", "Daniel"],
  ["let me think about this for a moment", "Samantha"],
  ["I'm making coffee, do you want some?", "Daniel"],
];

for (const thr of [0.15, 0.12, 0.1]) {
  fs.writeFileSync("/tmp/kws-e2e/kw-cal.txt", KEYWORDS.split("\n").map((l) => `${l} :1.4 #${thr}`).join("\n") + "\n");
  const s = makeSpotter("/tmp/kws-e2e/kw-cal.txt", thr);
  let hitCount = 0, faCount = 0;
  const hitResults = [];
  for (const [p, v] of hits) {
    const r = run(s, sayPcm(p, `cal_h_${p.length}_${v}`, v));
    if (r) hitCount++;
    hitResults.push(`${r ? "✓" : "✗"}${r ? "" : ` "${p}"`}`);
  }
  const faResults = [];
  for (const [p, v] of distractors) {
    const r = run(s, sayPcm(p, `cal_d_${p.length}_${v}`, v));
    if (r) faCount++;
    faResults.push(`${r ? "✗FA" : "·"}`);
  }
  console.log(`thr=${thr}: hits ${hitCount}/${hits.length} ${hitResults.join(" ")} | false alarms ${faCount}/${distractors.length} ${faResults.join(" ")}`);
}
