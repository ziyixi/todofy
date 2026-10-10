/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // Served by the Worker "recall" (../wrangler.toml [assets]): the page at / (dist/index.html, also the single-page
  // fallback for /day/…, /search, /pages/… and /settings) and its hashed files at /assets/.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // src/marks.ts imports ../shared/segment.ts, outside this root.
    fs: { allow: ['.', '../shared'] },
    // Local loop: `npm run dev` in ../worker (wrangler dev on http://127.0.0.1:8797 with DEV_AUTH_BYPASS from
    // ../.dev.vars); Vite proxies the API. That script pins every request URL to http://127.0.0.1:8797
    // (--local-upstream), so the proxied Origin is that origin too, or the Worker's same-origin CSRF check refuses
    // mutations.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8797', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8797' } },
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
