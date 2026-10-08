// Final calibration: canonical encoding (confirmed = ▁MA Y A via
// bpe.model), multi-voice coverage, both keywords, threshold spread.
// Also tests "computer" (a GigaSpeech-common word) as a control showing
// the pipeline detects well-covered words reliably.
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
function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// ── control: COMPUTER (well-covered word) ─────────────────────────────────
fs.writeFileSync("/tmp/kws-e2e/kw-ctl.txt", "▁COMP U TER @COMPUTER\n");
const ctl = makeSpotter("/tmp/kws-e2e/kw-ctl.txt", 0.25, 1.4);
for (const [v, phrase] of [["Samantha", "computer"], ["Daniel", "hey computer"], ["Moira", "Computer, what time is it?"]]) {
  console.log(`CONTROL computer/${v}: ${run(ctl, sayPcm(phrase, `ctl_${v}`, v)) ?? "—"}`);
}

// ── MAYA across many voices ──────────────────────────────────────────────
const voices = ["Samantha", "Daniel", "Moira", "Karen", "Fred", "Tessa"];
const mayaAudio = {};
for (const v of voices) {
  mayaAudio[v] = sayPcm("Hey Maya, what do you think?", `mv_${v}`, v);
}
for (const thr of [0.12, 0.08, 0.05]) {
  fs.writeFileSync("/tmp/kws-e2e/kw-m.txt", "▁MA Y A @MAYA\n");
  const s = makeSpotter("/tmp/kws-e2e/kw-m.txt", thr, 2.5);
  const res = voices.map((v) => (run(s, mayaAudio[v]) ? "✓" : "·")).join("");
  console.log(`MAYA thr=${thr} boost=2.5 (${voices.join(",")}): ${res}`);
}
