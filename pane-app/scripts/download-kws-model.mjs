// Downloads the sherpa-onnx keyword-spotting model (English zipformer
// transducer, 3.3M params) into ./models/ for pre-bundling with the app.
//
// Source: pkufool/keyword-spotting-models GitHub release v0.1 — the exact
// model the sherpa-onnx KWS docs reference. Uses fetch(), never loads the
// model into ONNX runtime (which SIGABRTs outside Electron).
//
// Usage: node scripts/download-kws-model.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(__dirname, "..", "models", "kws-zipformer-en");

// release asset = tar.bz2 of the model dir; we fetch individual files from
// the official sherpa-onnx kws docs' reference release (pkufool/
// keyword-spotting-models v0.1) via jsDelivr's GitHub-CDN mirror — same
// weights the docs reference, resumable, no tar/bz2 tooling needed.
const BASE =
  "https://cdn.jsdelivr.net/gh/pkufool/keyword-spotting-models@v0.1/kws-zipformer-en";

const FILES = [
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", // int8 encoder — smallest live footprint
  "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", // decoder stays fp32 (quantization hurts it)
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
];

async function download(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    const mb = (fs.statSync(destPath).size / 1048576).toFixed(1);
    console.log(`  ✓ ${path.basename(destPath)} (cached, ${mb}MB)`);
    return;
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const file = fs.createWriteStream(destPath);
  let done = 0;
  let pct = -1;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    file.write(Buffer.from(value));
    done += value.length;
    if (total > 0) {
      const p = Math.round((done / total) * 100);
      if (p !== pct) {
        process.stdout.write(
          `\r  ${path.basename(destPath)}: ${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB (${p}%)`,
        );
        pct = p;
      }
    }
  }
  await new Promise((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
    file.end();
  });
  console.log(`\r  ✓ ${path.basename(destPath)} (${(done / 1048576).toFixed(1)}MB)          `);
}

console.log("Downloading keyword-spotting model (English, ~17MB)…");
for (const f of FILES) {
  await download(`${BASE}/${f}`, path.join(DEST, f));
}
console.log(`Done → ${DEST}`);
