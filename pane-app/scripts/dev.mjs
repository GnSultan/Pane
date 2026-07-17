#!/usr/bin/env node
import { spawn, execFileSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Re-sign native binaries that build:mac / build:all strip in place.
// Those scripts run `codesign --remove-signature` on onnxruntime-node,
// node-pty, and better-sqlite3 for packaging, but leave node_modules
// stripped afterward. On Apple Silicon the kernel refuses to dlopen an
// unsigned mach-o, so the next `npm run dev` crashes the brain worker
// (onnxruntime) and would fail node-pty / better-sqlite3 loads too.
// Ad-hoc re-sign only the binaries that are actually unsigned — verifying
// first keeps this a no-op on every run after the first.
function resignNativeBinaries() {
  if (process.platform !== "darwin") return;
  // Mirror the exact find patterns from build:mac (inverted to sign).
  const findGroups = [
    ["-path", "*/onnxruntime-node/*", "-path", "*/darwin/*", "(", "-name", "*.node", "-o", "-name", "*.dylib", ")"],
    ["-path", "*/node-pty/*", "-path", "*/darwin/*", "-name", "*.node"],
    ["-path", "*/better-sqlite3/*", "-name", "*.node"],
  ];
  let signed = 0;
  for (const pattern of findGroups) {
    let out = "";
    try {
      out = execFileSync("find", ["node_modules", ...pattern], {
        cwd: projectRoot,
        encoding: "utf8",
      });
    } catch {
      continue; // node_modules or the module isn't present — nothing to sign
    }
    for (const file of out.split("\n").filter(Boolean)) {
      try {
        execFileSync("codesign", ["-v", file], { cwd: projectRoot, stdio: "ignore" });
        continue; // already validly signed (ad-hoc counts) — leave it alone
      } catch {
        // Unsigned or broken signature — ad-hoc sign it.
      }
      try {
        execFileSync("codesign", ["--force", "--sign", "-", file], { cwd: projectRoot, stdio: "ignore" });
        signed++;
      } catch (err) {
        console.warn(`[dev] could not re-sign ${file}: ${err.message}`);
      }
    }
  }
  if (signed > 0) {
    console.log(`[dev] ad-hoc re-signed ${signed} native binari${signed === 1 ? "y" : "es"} stripped by a prior build`);
  }
}

resignNativeBinaries();

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
