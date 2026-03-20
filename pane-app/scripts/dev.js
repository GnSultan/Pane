#!/usr/bin/env node
import { spawn } from "child_process";
import { copyFileSync, mkdirSync, readdirSync, watch } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

function copyCompiled() {
  mkdirSync(`${projectRoot}/out/main`, { recursive: true });
  mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

  console.log("📦 Copying pre-compiled main and preload...");

  // main.mjs → index.js (entry point rename)
  copyFileSync(
    `${projectRoot}/src/main/main.mjs`,
    `${projectRoot}/out/main/index.js`,
  );

  // preload
  copyFileSync(
    `${projectRoot}/src/preload/preload.mjs`,
    `${projectRoot}/out/preload/preload.mjs`,
  );

  // all .mjs files in src/main/ (except main.mjs which is handled above as index.js)
  for (const file of readdirSync(`${projectRoot}/src/main/`)) {
    if (!file.endsWith(".mjs") || file === "main.mjs") continue;
    copyFileSync(
      `${projectRoot}/src/main/${file}`,
      `${projectRoot}/out/main/${file}`,
    );
  }

  console.log("✓ Compiled scripts copied");
}

// Start electron-vite dev
const vite = spawn("npx", ["electron-vite", "dev"], {
  cwd: projectRoot,
  stdio: "pipe",
  shell: true,
  env: { ...process.env, ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || "http://localhost:5173" },
});

let buildDetected = false;

vite.stdout.on("data", (data) => {
  const output = data.toString();
  process.stdout.write(output);

  // Copy compiled files after electron-vite builds main/preload
  if (
    output.includes("build the electron main process successfully") ||
    output.includes("build the electron preload files successfully")
  ) {
    if (!buildDetected) {
      buildDetected = true;
      setTimeout(() => {
        copyCompiled();
        buildDetected = false;
      }, 100);
    }
  }
});

vite.stderr.on("data", (data) => {
  process.stderr.write(data);
});

// Watch src/main/ directory — any .mjs change is copied immediately
watch(`${projectRoot}/src/main/`, (eventType, filename) => {
  if (!filename?.endsWith(".mjs")) return;
  const dest = filename === "main.mjs" ? "index.js" : filename;
  try {
    copyFileSync(
      `${projectRoot}/src/main/${filename}`,
      `${projectRoot}/out/main/${dest}`,
    );
    console.log(`✓ ${filename} copied`);
  } catch (err) {
    console.error(`Copy failed (${filename}):`, err.message);
  }
});

// preload watch
watch(`${projectRoot}/src/preload/preload.mjs`, () => {
  try {
    copyFileSync(
      `${projectRoot}/src/preload/preload.mjs`,
      `${projectRoot}/out/preload/preload.mjs`,
    );
    console.log("✓ preload.mjs copied");
  } catch (err) {
    console.error("Copy failed (preload.mjs):", err.message);
  }
});

vite.on("exit", (code) => {
  process.exit(code);
});

process.on("SIGINT", () => {
  vite.kill("SIGINT");
  process.exit(0);
});
