// Prove/disprove the interleaved-audio failure mode: two independent
// capture streams from the same phrase, chunked alternately as two armed
// listeners would interleave them into ONE spotter stream.
// Result: PASS = interleaving kills detection (the bug is renderer-side
// duplicate listeners). FAIL = interleaving is harmless (look elsewhere).
import { execSync } from "node:child_process";
import fs from "node:fs";
import { configureWakeWord, feedWakeWord } from "../src/main/wake-word.mjs";

function sayPcm(phrase, name, voice = "Samantha") {
  execSync(`mkdir -p /tmp/kws-e2e`, { stdio: "pipe" });
  execSync(`say -v ${voice} -o /tmp/kws-e2e/${name}.aiff "${phrase}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i /tmp/kws-e2e/${name}.aiff -ar 16000 -ac 1 -c:a pcm_f32le -f f32le /tmp/kws-e2e/${name}.raw`, { stdio: "pipe" });
  const buf = fs.readFileSync(`/tmp/kws-e2e/${name}.raw`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

const cfg = configureWakeWord("maya");
if (!cfg.ok) { console.error("configure failed:", cfg.error); process.exit(2); }

const phrases = [
  ["Samantha", "Maya, are you there?"],
  ["Daniel", "hey maya can you hear me"],
  ["Moira", "Maya what's the time"],
];

let interHits = 0, seqHits = 0;
for (const [v, p] of phrases) {
  // Two captures of the SAME phrase at slightly different speaking rates —
  // the real scenario: same speaker, two mics, different capture paths.
  const a = sayPcm(p, `il_a_${v}`, v);
  const b = sayPcm(p, `il_b_${v}`, v);
  const len = Math.max(a.length, b.length);
  const CH = 1600; // 100ms — the worklet's batch size

  // Control: single sequential stream (what ONE listener produces)
  configureWakeWord("maya"); // fresh spotter/stream
  let seq = null;
  for (let i = 0; i < len; i += CH) {
    const r = feedWakeWord(a.subarray(i, i + CH));
    if (r) seq = r;
  }
  if (seq) seqHits++;
  console.log(`control (one stream)  [${v}]: ${seq ? "✓ detected" : "✗ missed"}`);

  // Experimental: two streams interleaved (what two listeners produce when
  // both feed one spotter via the same IPC channel)
  configureWakeWord("maya"); // fresh spotter/stream
  let inter = null;
  for (let i = 0; i < len; i += CH) {
    const rA = feedWakeWord(a.subarray(i, i + CH));
    const rB = feedWakeWord(b.subarray(i, i + CH));
    if (rA) inter = rA;
    if (rB) inter = rB;
  }
  if (inter) interHits++;
  console.log(`interleaved (two mics) [${v}]: ${inter ? "✓ detected" : "✗ MISSED"}`);
  console.log("");
}

console.log(`sequential: ${seqHits}/${phrases.length}   interleaved: ${interHits}/${phrases.length}`);
if (interHits === 0 && seqHits === phrases.length) {
  console.log("\nCONFIRMED: interleaved duplicate audio defeats the spotter.");
  process.exit(1);
}
if (seqHits === phrases.length) {
  console.log("\nInterleaving is harmless — the failure lies elsewhere.");
  process.exit(0);
}
process.exit(3); // control itself flaky — harness unusable
