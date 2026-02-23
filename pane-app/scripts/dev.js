#!/usr/bin/env node
import { spawn } from 'child_process';
import { copyFileSync, mkdirSync, watch } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

function copyCompiled() {
  mkdirSync(`${projectRoot}/out/main`, { recursive: true });
  mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

  console.log('📦 Copying pre-compiled main and preload...');
  copyFileSync(
    `${projectRoot}/src/main/main.mjs`,
    `${projectRoot}/out/main/index.js`
  );
  copyFileSync(
    `${projectRoot}/src/preload/preload.mjs`,
    `${projectRoot}/out/preload/preload.mjs`
  );
  console.log('✓ Compiled scripts copied');
}

// Start electron-vite dev
const vite = spawn('npx', ['electron-vite', 'dev'], {
  cwd: projectRoot,
  stdio: 'pipe',
  shell: true
});

let buildDetected = false;

vite.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);

  // Copy compiled files after electron-vite builds main/preload
  if (output.includes('build the electron main process successfully') ||
      output.includes('build the electron preload files successfully')) {
    if (!buildDetected) {
      buildDetected = true;
      setTimeout(() => {
        copyCompiled();
        buildDetected = false;
      }, 100);
    }
  }
});

vite.stderr.on('data', (data) => {
  process.stderr.write(data);
});

// Watch for changes to compiled source files
watch(`${projectRoot}/src/main/main.mjs`, () => {
  console.log('🔄 main.mjs changed, will re-copy after next build...');
});

watch(`${projectRoot}/src/preload/preload.mjs`, () => {
  console.log('🔄 preload.mjs changed, will re-copy after next build...');
});

vite.on('exit', (code) => {
  process.exit(code);
});

process.on('SIGINT', () => {
  vite.kill('SIGINT');
  process.exit(0);
});
