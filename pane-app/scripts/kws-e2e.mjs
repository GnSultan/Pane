// End-to-end KWS validation with real audio: macOS `say` renders phrases to
// AIFF, ffmpeg converts to 16 kHz mono f32 WAV, and this script feeds the
// PCM through the wake-word module. Verifies detection AND false-alarm
// behavior on distractor phrases. Run: node scripts/kws-e2e.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configureWakeWord, feedWakeWord } from "../src/main/wake-word.mjs";

const TMP = "/tmp/kws-e2e";
fs.mkdirSync(TMP, { recursive: true });

function phraseToPcm(phrase, name) {
  const aiff = path.join(TMP, `${name}.aiff`);
  const wav = path.join(TMP, `${name}.wav`);
  execSync(`say -v Samantha -o ${aiff} "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i ${aiff} -ar 16000 -ac 1 -f f32le ${wav}`, { stdio: "pipe" });
  const buf = fs.readFileSync(wav);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const cfg = configureWakeWord("maya");
if (!cfg.ok) {
  console.error("configure failed:", cfg.error);
  process.exit(1);
}
console.log("configured ✓  phrase=maya");

const tests = [
  { phrase: "maya", expect: true },
  { phrase: "hey maya", expect: true },
  { phrase: "Maya, can you help me with this?", expect: true },
  { phrase: "the weather is nice today", expect: false },
  { phrase: "my car needs a wash", expect: false }, // near-rhyme distractor
  { phrase: "I'll call my mom tomorrow", expect: false }, // "my" token
];

let pass = 0;
for (const t of tests) {
  const pcm = phraseToPcm(t.phrase, t.phrase.replace(/[^a-z]/gi, "_").slice(0, 30));
  let hit = null;
  // feed in 100ms chunks like the renderer will
  const chunk = 1600;
  for (let i = 0; i < pcm.length; i += chunk) {
    const r = feedWakeWord(pcm.subarray(i, i + chunk));
    if (r) hit = r;
  }
  const ok = (hit !== null) === t.expect;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} "${t.phrase}" → ${hit ?? "—"} (expected ${t.expect ? "HIT" : "no hit"})`);
}
console.log(`${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
