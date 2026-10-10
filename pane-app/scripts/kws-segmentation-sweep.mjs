// Segmentation sweep: enumerate ALL valid token segmentations of MAYA and
// HEY MAYA through the spotter to find which one the model responds to.
// (BPE greedy longest-match is not how this vocab was trained to segment —
// character-level pieces are legal and often what the transducer expects.)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sherpa = (await import("sherpa-onnx-node")).default ?? (await import("sherpa-onnx-node"));
const DIR = path.resolve("models/kws-zipformer-en");
const TMP = "/tmp/kws-e2e";

const lines = fs.readFileSync(path.join(DIR, "tokens.txt"), "utf8").split("\n");
const startSet = new Set(lines.filter((l) => l.includes("▁")).map((l) => l.slice(0, l.lastIndexOf(" "))));
const contSet = new Set(
  lines.filter((l) => l.trim() && !l.includes("▁") && !l.slice(0, l.lastIndexOf(" ")).startsWith("<")).map((l) => l.slice(0, l.lastIndexOf(" "))),
);

// words → every segmentation (word-start pieces start with ▁)
function allSegmentations(word) {
  const up = word.toUpperCase();
  const results = [];
  function walk(pos, atStart, acc) {
    if (pos === up.length) { results.push([...acc]); return; }
    const table = atStart ? startSet : contSet;
    // try longest first, but ALSO try all shorter
    for (const piece of table) {
      const body = atStart ? piece.slice(1) : piece;
      if (body.length > 0 && up.startsWith(body, pos)) {
        acc.push(piece);
        walk(pos + body.length, false, acc);
        acc.pop();
      }
    }
  }
  walk(0, true, []);
  return results;
}

function phraseToPcm(phrase, name) {
  const aiff = path.join(TMP, `${name}.aiff`);
  const wav = path.join(TMP, `${name}.wav`);
  execSync(`say -v Samantha -o ${aiff} "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i ${aiff} -ar 16000 -ac 1 -f f32le ${wav}`, { stdio: "pipe" });
  const buf = fs.readFileSync(wav);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

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

const maya = phraseToPcm("maya", "maya");
const segsM = allSegmentations("MAYA");
console.log(`MAYA segmentations: ${segsM.length}`);

for (const thr of [0.25, 0.1]) {
  let anyHit = false;
  for (const seg of segsM) {
    const kwPath = path.join(TMP, "kw-seg.txt");
    fs.writeFileSync(kwPath, `${seg.join(" ")} @MAYA :1.4 #${thr}\n`);
    const s = makeSpotter(kwPath, thr);
    const hit = run(s, maya);
    if (hit) {
      anyHit = true;
      console.log(`  thr=${thr} HIT with: ${seg.join(" ")}`);
    }
  }
  if (!anyHit) console.log(`  thr=${thr}: no segmentation fired`);
}
