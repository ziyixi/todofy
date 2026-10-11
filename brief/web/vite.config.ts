/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // Served by the Worker "brief" (../wrangler.toml [assets]): the page at / (dist/index.html, also the single-page
  // fallback for /issues/…, /sources, /profile and /settings) and its hashed files at /assets/.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local loop: `npm run dev` in ../worker (wrangler dev on http://127.0.0.1:8799 with ../wrangler.test.toml and
    // brief/.dev.vars); Vite proxies the API. That script pins every request URL to http://127.0.0.1:8799
    // (--local-upstream), so the proxied Origin is that origin too, or the Worker's same-origin CSRF check refuses
    // mutations.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8799', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8799' } },
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
