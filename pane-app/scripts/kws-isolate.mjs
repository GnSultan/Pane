// Isolate: (a) does a SPELLED "maya" via say produce detectable audio for
// the LIGHT UP keyword? (b) does the ground-truth keyword encoding style
// work for MAYA — i.e., is the problem my audio or my token line?
// The ground truth uses spell-OUT tokens: ▁L IGHT (single letters + rare
// pieces). MAYA forced segmentation ▁MA Y A might be the wrong BPE path —
// sentencepiece might produce ▁M AYA? No ▁M? Let's check what pieces even
// exist and try MANY spellings/pronunciations of maya via say.
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
function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// sanity: same spotter, our say-rendered "light up forever"
const kwPath = "/tmp/kws-e2e/kw-gt.txt";
fs.writeFileSync(kwPath, fs.readFileSync("/tmp/kws-e2e/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/test_keywords.txt"));
const gt = makeSpotter(kwPath);
const lightPcm = sayPcm("light up forever", "lightup");
console.log("say 'light up forever' →", run(gt, lightPcm) ?? "—");

// MAYA with single-letter spelling: ▁M A Y A
for (const [label, line] of [
  ["single letters ▁M A Y A", "▁M A Y A"],
  ["▁MA Y A", "▁MA Y A"],
]) {
  fs.writeFileSync("/tmp/kws-e2e/kw-one.txt", line + "\n");
  const s = makeSpotter("/tmp/kws-e2e/kw-one.txt");
  const r1 = run(s, sayPcm("maya", "maya_a"));
  const r2 = run(s, sayPcm("Maya", "maya_b"));
  console.log(`${label}: maya→${r1 ?? "—"} Maya→${r2 ?? "—"}`);
}
