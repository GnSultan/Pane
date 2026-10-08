// Phonetic decomposition test. The author's working keywords decompose
// phonetically into sub-word pieces (▁HE Y ▁S I RI for HEY SIRI), not
// greedy whole-word matches. Find the decomposition of MAYA (and HEY MAYA)
// that fires on spoken audio, across multiple voices/casings.
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

// candidate token decompositions (each piece must exist in tokens.txt)
const decompositions = [
  "▁M A Y A",        // ▁M doesn't exist — will error, skip via try
  "▁MA Y A",         // greedy (already failed, control)
  "▁M A YA",         // ▁M missing too
  "▁MA YA",          // MA + YA
  "▁MAY A",          // ▁MAY? check
  "▁MA YAH",         // YAH?
];
// filter to pieces that exist
const vocab = new Set(
  fs.readFileSync(path.join(DIR, "tokens.txt"), "utf8").split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(0, l.lastIndexOf(" "))),
);
const legal = decompositions.filter((d) => d.split(" ").every((p) => vocab.has(p)));
console.log("legal decompositions:", legal);

// test voices: Samantha (US), Daniel (UK) — different prosody
const audio = {
  samantha: sayPcm("maya", "maya_sam", "Samantha"),
  daniel: sayPcm("maya", "maya_dan", "Daniel"),
  inSentence: sayPcm("Hey Maya, are you there?", "maya_sent", "Samantha"),
};

for (const dec of legal) {
  for (const thr of [0.25, 0.15]) {
    fs.writeFileSync("/tmp/kws-e2e/kw-dec.txt", `${dec} @MAYA :1.4 #${thr}\n`);
    let s;
    try { s = makeSpotter("/tmp/kws-e2e/kw-dec.txt", thr); } catch (e) { console.log(`${dec} [thr=${thr}] CONSTRUCTOR ERROR`); continue; }
    const r1 = run(s, audio.samantha);
    const r2 = run(s, audio.daniel);
    const r3 = run(s, audio.inSentence);
    if (r1 || r2 || r3) console.log(`★ ${dec} [thr=${thr}]: sam=${r1 ?? "—"} dan=${r2 ?? "—"} sent=${r3 ?? "—"}`);
    else console.log(`  ${dec} [thr=${thr}]: no hit`);
  }
}
