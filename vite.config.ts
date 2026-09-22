import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

function stubNodeSqlite() {
  return {
    name: 'stub-node-sqlite',
    transform(code: string, id: string) {
      if (id.includes('node_modules')) {
        return code.replace(/require\(["']node:sqlite["']\)/g, 'undefined')
      }
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          plugins: [stubNodeSqlite()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3']
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3', 'node:sqlite']
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    watch: {
      ignored: ['**/dist-electron/**', '**/node_modules/**', '**/.git/**']
    }
  }
})
