import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { copyFileSync, readdirSync } from 'fs'

// Copies raw .mjs worker files into out/main/ after each build so that
// utilityProcess.fork() can find them. These run as separate processes and
// cannot be bundled into the main entry.
function copyWorkersPlugin() {
  return {
    name: 'copy-worker-mjs',
    writeBundle() {
      for (const file of readdirSync(resolve(__dirname, 'src/main'))) {
        if (!file.endsWith('.mjs') || file === 'main.mjs') continue
        copyFileSync(
          resolve(__dirname, 'src/main', file),
          resolve(__dirname, 'out/main', file)
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyWorkersPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: {
      port: 10000,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
