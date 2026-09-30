/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by the Worker "lab" as static assets (../wrangler.toml [assets]).
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local loop: `npm run dev` in ../worker (wrangler dev on http://127.0.0.1:8788 with DEV_AUTH_BYPASS
    // from ../.dev.vars); Vite proxies the API. That script pins every request URL to http://127.0.0.1:8788
    // (--local-upstream), so the proxied Origin is that origin too, or the Worker's same-origin CSRF check
    // refuses mutations.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8788' } },
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
