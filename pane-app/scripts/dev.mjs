#!/usr/bin/env node
import { spawn } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Prepend the current node binary's directory to PATH so npx is always found,
// even when the script is launched without loading .zshrc / nvm init.
const nodeBinDir = process.execPath.replace(/\/node$/, "");
const augmentedPath = `${nodeBinDir}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;

const vite = spawn("npx", ["electron-vite", "dev"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    PATH: augmentedPath,
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || "http://localhost:10000",
  },
});

vite.on("exit", (code) => {
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  vite.kill("SIGINT");
  process.exit(0);
});
