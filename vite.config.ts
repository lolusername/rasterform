import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],

  optimizeDeps: {
    exclude: [
      'three-mesh-bvh',
      'three-gpu-pathtracer',
    ],
  },

  test: {
    environment: 'node',
  },
})