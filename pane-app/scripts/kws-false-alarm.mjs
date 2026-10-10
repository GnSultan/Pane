// False-alarm check at the chosen operating point (thr=0.08, boost=2.5).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
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
    keywordsScore: 2.5,
    keywordsThreshold: 0.08,
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

fs.writeFileSync("/tmp/kws-e2e/kw-fa.txt", "▁MA Y A @MAYA\n");
const s = makeSpotter("/tmp/kws-e2e/kw-fa.txt");
// long continuous speech — the worst case for false alarms
const sentences = [
  "maybe we should try again tomorrow",
  "my car needs a wash this weekend",
  "I'll call my mom tomorrow morning",
  "the matrix movie was great last night",
  "I'm making coffee, do you want some",
  "let me think about this for a moment",
  "can you check the mail on your way home",
  "I might be late to the meeting today",
  "the data shows a clear upward trend",
  "we could also consider a third option",
];
let fa = 0;
for (const [i, sent] of sentences.entries()) {
  const v = ["Samantha", "Daniel"][i % 2];
  const r = run(s, sayPcm(sent, `fa_${i}`, v));
  if (r) fa++;
  console.log(`${r ? "✗ FALSE ALARM" : "·"} "${sent}" (${v})`);
}
console.log(`${fa}/${sentences.length} false alarms @ thr=0.08 boost=2.5`);
