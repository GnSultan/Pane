#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Ensure output directories exist
mkdirSync(`${projectRoot}/out/main`, { recursive: true });
mkdirSync(`${projectRoot}/out/preload`, { recursive: true });

// Copy compiled main and preload scripts
console.log('Copying pre-compiled main and preload scripts...');
copyFileSync(
  `${projectRoot}/src/main/main.mjs`,
  `${projectRoot}/out/main/index.js`
);
copyFileSync(
  `${projectRoot}/src/preload/preload.mjs`,
  `${projectRoot}/out/preload/preload.mjs`
);
console.log('✓ Compiled scripts copied successfully');
