/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8798', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8798' } },
    },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false, restoreMocks: true },
})
