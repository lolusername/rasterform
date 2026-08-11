import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const electronRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = resolve(electronRoot, '..')

export default defineConfig({
  root: resolve(electronRoot, 'render'),
  base: './',
  publicDir: resolve(repositoryRoot, 'public'),
  cacheDir: resolve(electronRoot, '.vite-render'),
  build: {
    outDir: resolve(electronRoot, '.build/render'),
    emptyOutDir: true,
    target: 'chrome150',
    sourcemap: true,
    rollupOptions: {
      input: resolve(electronRoot, 'render/index.html'),
    },
  },
  optimizeDeps: {
    exclude: [
      'three-mesh-bvh',
      'three-gpu-pathtracer',
    ],
  },
  worker: {
    format: 'es',
  },
})
