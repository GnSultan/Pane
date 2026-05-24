// Downloads both bundled models into ./models/ for pre-bundling with the app.
//
// Uses fetch() to download from HuggingFace — does NOT load models into
// ONNX runtime, which SIGABRTs outside Electron due to WASM threading.
//
// Usage: node scripts/download-models.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "..", "models");

const MODELS = [
  {
    name: "Xenova/all-MiniLM-L6-v2",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model.onnx",
    ],
  },
  {
    name: "onnx-community/Qwen2.5-0.5B-Instruct",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "generation_config.json",
      "onnx/model_quantized.onnx",
    ],
  },
];

async function download(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Skip if file already exists and has content
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    const sizeMb = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${path.basename(destPath)} (cached, ${sizeMb}MB)`);
    return;
  }

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const file = fs.createWriteStream(destPath);

  let downloaded = 0;
  let lastPct = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    file.write(Buffer.from(value));
    downloaded += value.length;

    if (totalBytes > 0) {
      const pct = Math.round((downloaded / totalBytes) * 100);
      if (pct !== lastPct) {
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
        process.stdout.write(`\r  ${path.basename(destPath)}: ${mb}MB / ${totalMb}MB (${pct}%)`);
        lastPct = pct;
      }
    }
  }

  await new Promise((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
    file.end();
  });

  if (totalBytes > 0) process.stdout.write("\n");
  else console.log(`  ✓ ${path.basename(destPath)}`);
}

console.log(`Downloading models to: ${MODELS_DIR}\n`);

for (const model of MODELS) {
  console.log(`=== ${model.name} ===`);
  const modelDir = path.join(MODELS_DIR, model.name);

  for (const file of model.files) {
    const url = `https://huggingface.co/${model.name}/resolve/main/${file}`;
    const destPath = path.join(modelDir, file);
    await download(url, destPath);
  }
  console.log();
}

// Verify
console.log("=== Verification ===");
let totalSize = 0;
for (const model of MODELS) {
  const modelDir = path.join(MODELS_DIR, model.name);
  for (const f of model.files) {
    const p = path.join(modelDir, f);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : 0;
    totalSize += size;
    const status = exists ? `✓ ${(size / 1024 / 1024).toFixed(1)}MB` : "✗ MISSING";
    console.log(`  ${model.name}/${f}: ${status}`);
  }
}
console.log(`\nTotal: ${(totalSize / 1024 / 1024).toFixed(0)}MB`);
console.log("Done.");
