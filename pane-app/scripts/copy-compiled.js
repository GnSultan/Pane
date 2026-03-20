#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

mkdirSync(`${projectRoot}/out/main`, { recursive: true });
mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

console.log("Copying pre-compiled main and preload scripts...");

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

console.log("✓ Compiled scripts copied successfully");
