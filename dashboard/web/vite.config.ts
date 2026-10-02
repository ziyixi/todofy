/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by the Worker "home" as static assets (../wrangler.toml [assets]).
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
    // One chunk of about 510 KiB since the typed client (dashboard.ui.v1); its gzip size is held by
    // scripts/js-budget.mjs, so Vite's generic 500 kB warning would only repeat that gate in every log.
    chunkSizeWarningLimit: 640,
  },
  server: {
    // Local loop: `npm run dev` in ../worker (wrangler dev on http://127.0.0.1:8787 with DEV_AUTH_BYPASS
    // from ../.dev.vars); Vite proxies the API. That script pins every request URL to http://127.0.0.1:8787
    // (--local-upstream: ../wrangler.toml's production route would otherwise become the URL), so the
    // proxied Origin is that origin too, or the Worker's same-origin CSRF check refuses mutations.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8787' } },
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
