/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // Served by the Worker "links" under /_/ (../wrangler.toml [assets]): the page at /_/ (dist/_/index.html) and its
  // hashed files at /_/assets/, the one path that reaches the asset layer without the Worker.
  base: '/_/',
  build: {
    outDir: 'dist/_',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local loop: `npm run dev` in ../worker (wrangler dev on http://127.0.0.1:8790 with DEV_AUTH_BYPASS from
    // ../.dev.vars); Vite proxies the API. That script pins every request URL to http://127.0.0.1:8790
    // (--local-upstream), so the proxied Origin is that origin too, or the Worker's same-origin CSRF check refuses
    // mutations.
    proxy: {
      '/_/api': { target: 'http://127.0.0.1:8790', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8790' } },
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
