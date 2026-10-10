// Threshold sweep: where does "maya" start firing? Feeds the same PCM at
// several per-keyword thresholds to find the operating point.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequireImport();
function createRequireImport() {
  try { return import.meta.url ? null : null; } catch { return null; }
}

const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const DIR = path.resolve("models/kws-zipformer-en");
const TMP = "/tmp/kws-e2e";

function phraseToPcm(phrase, name) {
  const aiff = path.join(TMP, `${name}.aiff`);
  const wav = path.join(TMP, `${name}.wav`);
  execSync(`say -v Samantha -o ${aiff} "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i ${aiff} -ar 16000 -ac 1 -f f32le ${wav}`, { stdio: "pipe" });
  const buf = fs.readFileSync(wav);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const maya = phraseToPcm("maya", "maya");

for (const thr of [0.25, 0.15, 0.1, 0.05, 0.02]) {
  const kwPath = path.join(TMP, `kw-${thr}.txt`);
  fs.writeFileSync(kwPath, `▁MA Y A @MAYA :1.4 #${thr}\n`);
  const s = new sherpa.KeywordSpotter({
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
  const stream = s.createStream();
  let hit = null;
  const chunk = 1600;
  for (let i = 0; i < maya.length; i += chunk) {
    stream.acceptWaveform({ samples: maya.subarray(i, i + chunk), sampleRate: 16000 });
    while (s.isReady(stream)) {
      s.decode(stream);
      const r = s.getResult(stream);
      if (r?.keyword) { hit = r.keyword; s.reset(stream); }
    }
  }
  console.log(`thr=${thr} → ${hit ?? "—"}`);
}
