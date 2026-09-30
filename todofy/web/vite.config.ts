/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../uiassets/dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local loop: `uv run pywrangler dev ... --local-upstream todofy.localhost:8787` with DEV_AUTH_BYPASS
    // (docs/dev-notes.md §1); Vite proxies the API to it. wrangler dev pins every request URL to that owner
    // origin, so the proxied Origin is that origin too, or the gateway's CSRF Origin check refuses mutations.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, headers: { origin: 'http://todofy.localhost:8787' } },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
})
