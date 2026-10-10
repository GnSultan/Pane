// Module-level E2E: the real wake-word.mjs configureWakeWord + feedWakeWord
// against spoken phrases. Verifies the shipped constants end to end.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { configureWakeWord, feedWakeWord } from "../src/main/wake-word.mjs";

function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const cfg = configureWakeWord("maya");
if (!cfg.ok) { console.error("configure failed:", cfg.error); process.exit(1); }
console.log("configured ✓ (maya)");

const hits = [
  ["Samantha", "Hey Maya, what do you think?"],
  ["Daniel", "Maya, can you check the build?"],
  ["Moira", "hey maya are you listening"],
  ["Karen", "Maya what's the time"],
];
const distractors = [
  ["Samantha", "maybe we should try again tomorrow"],
  ["Daniel", "my car needs a wash"],
  ["Moira", "I'll call my mom tomorrow"],
  ["Karen", "the matrix movie was great"],
];

let h = 0;
for (const [v, p] of hits) {
  const pcm = sayPcm(p, `me_${v}_${p.length}`, v);
  let hit = null;
  for (let i = 0; i < pcm.length; i += 1600) {
    const r = feedWakeWord(pcm.subarray(i, i + 1600));
    if (r) hit = r;
  }
  if (hit) h++;
  console.log(`${hit ? "✓" : "✗"} [${v}] "${p}"`);
}
let fa = 0;
for (const [v, p] of distractors) {
  const pcm = sayPcm(p, `md_${v}_${p.length}`, v);
  let hit = null;
  for (let i = 0; i < pcm.length; i += 1600) {
    const r = feedWakeWord(pcm.subarray(i, i + 1600));
    if (r) hit = r;
  }
  if (hit) fa++;
  console.log(`${hit ? "✗FA" : "·"} [${v}] "${p}"`);
}
console.log(`\nhits ${h}/${hits.length}, false alarms ${fa}/${distractors.length}`);
process.exit(h >= 3 && fa === 0 ? 0 : 1);
