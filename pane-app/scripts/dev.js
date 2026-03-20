#!/usr/bin/env node
import { spawn } from "child_process";
import { copyFileSync, mkdirSync, watch } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

function copyCompiled() {
  mkdirSync(`${projectRoot}/out/main`, { recursive: true });
  mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

  console.log("📦 Copying pre-compiled main and preload...");
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
  copyFileSync(
    `${projectRoot}/src/main/task-runner.mjs`,
    `${projectRoot}/out/main/task-runner.mjs`,
  );
  copyFileSync(
    `${projectRoot}/src/main/plan-store.mjs`,
    `${projectRoot}/out/main/plan-store.mjs`,
  );
  copyFileSync(
    `${projectRoot}/src/main/symbol-index.mjs`,
    `${projectRoot}/out/main/symbol-index.mjs`,
  );
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

// Watch for changes to compiled source files
watch(`${projectRoot}/src/main/main.mjs`, () => {
  console.log("🔄 main.mjs changed, will re-copy after next build...");
});

watch(`${projectRoot}/src/preload/preload.mjs`, () => {
  console.log("🔄 preload.mjs changed, will re-copy after next build...");
});

watch(`${projectRoot}/src/main/cli-worker.mjs`, () => {
  console.log("🔄 cli-worker.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/cli-worker.mjs`,
      `${projectRoot}/out/main/cli-worker.mjs`,
    );
    console.log("✓ cli-worker.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/pty-worker.mjs`, () => {
  console.log("🔄 pty-worker.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/pty-worker.mjs`,
      `${projectRoot}/out/main/pty-worker.mjs`,
    );
    console.log("✓ pty-worker.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/brain-engine.mjs`, () => {
  console.log("🔄 brain-engine.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/brain-engine.mjs`,
      `${projectRoot}/out/main/brain-engine.mjs`,
    );
    console.log("✓ brain-engine.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/punk-engine.mjs`, () => {
  console.log("🔄 punk-engine.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/punk-engine.mjs`,
      `${projectRoot}/out/main/punk-engine.mjs`,
    );
    console.log("✓ punk-engine.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/http-backend.mjs`, () => {
  console.log("🔄 http-backend.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/http-backend.mjs`,
      `${projectRoot}/out/main/http-backend.mjs`,
    );
    console.log("✓ http-backend.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/model-manager.mjs`, () => {
  console.log("🔄 model-manager.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/model-manager.mjs`,
      `${projectRoot}/out/main/model-manager.mjs`,
    );
    console.log("✓ model-manager.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/classify-intent.mjs`, () => {
  console.log("🔄 classify-intent.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/classify-intent.mjs`,
      `${projectRoot}/out/main/classify-intent.mjs`,
    );
    console.log("✓ classify-intent.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/punk-backend.mjs`, () => {
  console.log("🔄 punk-backend.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/punk-backend.mjs`,
      `${projectRoot}/out/main/punk-backend.mjs`,
    );
    console.log("✓ punk-backend.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/session-context.mjs`, () => {
  console.log("🔄 session-context.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/session-context.mjs`,
      `${projectRoot}/out/main/session-context.mjs`,
    );
    console.log("✓ session-context.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/pane-mcp-server.mjs`, () => {
  console.log("🔄 pane-mcp-server.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/pane-mcp-server.mjs`,
      `${projectRoot}/out/main/pane-mcp-server.mjs`,
    );
    console.log("✓ pane-mcp-server.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/tool-executor.mjs`, () => {
  console.log("🔄 tool-executor.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/tool-executor.mjs`,
      `${projectRoot}/out/main/tool-executor.mjs`,
    );
    console.log("✓ tool-executor.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/task-runner.mjs`, () => {
  console.log("🔄 task-runner.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/task-runner.mjs`,
      `${projectRoot}/out/main/task-runner.mjs`,
    );
    console.log("✓ task-runner.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/plan-store.mjs`, () => {
  console.log("🔄 plan-store.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/plan-store.mjs`,
      `${projectRoot}/out/main/plan-store.mjs`,
    );
    console.log("✓ plan-store.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

watch(`${projectRoot}/src/main/symbol-index.mjs`, () => {
  console.log("🔄 symbol-index.mjs changed, copying...");
  try {
    copyFileSync(
      `${projectRoot}/src/main/symbol-index.mjs`,
      `${projectRoot}/out/main/symbol-index.mjs`,
    );
    console.log("✓ symbol-index.mjs copied");
  } catch (err) {
    console.error("Copy failed:", err.message);
  }
});

vite.on("exit", (code) => {
  process.exit(code);
});

process.on("SIGINT", () => {
  vite.kill("SIGINT");
  process.exit(0);
});
