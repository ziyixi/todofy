/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by the Worker "fleet" as static assets (../wrangler.toml [assets]).
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local owner API stays on a loopback origin; production JWT cannot be bypassed remotely.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8791', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8791' } },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setup.ts'],
    css: false,
    restoreMocks: true,
  },
})
