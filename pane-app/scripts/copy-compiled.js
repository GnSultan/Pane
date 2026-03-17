#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Ensure output directories exist
mkdirSync(`${projectRoot}/out/main`, { recursive: true });
mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

// Copy compiled main and preload scripts
console.log("Copying pre-compiled main and preload scripts...");
copyFileSync(
  `${projectRoot}/src/main/main.mjs`,
  `${projectRoot}/out/main/index.js`,
);
copyFileSync(
  `${projectRoot}/src/preload/preload.mjs`,
  `${projectRoot}/out/preload/preload.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/cli-worker.mjs`,
  `${projectRoot}/out/main/cli-worker.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/pty-worker.mjs`,
  `${projectRoot}/out/main/pty-worker.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/brain-engine.mjs`,
  `${projectRoot}/out/main/brain-engine.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/punk-engine.mjs`,
  `${projectRoot}/out/main/punk-engine.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/http-backend.mjs`,
  `${projectRoot}/out/main/http-backend.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/context-manager.mjs`,
  `${projectRoot}/out/main/context-manager.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/model-manager.mjs`,
  `${projectRoot}/out/main/model-manager.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/classify-intent.mjs`,
  `${projectRoot}/out/main/classify-intent.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/punk-backend.mjs`,
  `${projectRoot}/out/main/punk-backend.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/session-context.mjs`,
  `${projectRoot}/out/main/session-context.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/pane-mcp-server.mjs`,
  `${projectRoot}/out/main/pane-mcp-server.mjs`,
);
copyFileSync(
  `${projectRoot}/src/main/tool-executor.mjs`,
  `${projectRoot}/out/main/tool-executor.mjs`,
);
console.log("✓ Compiled scripts copied successfully");
