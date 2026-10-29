/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { navigationFromConfig } from '../deploy/public-navigation.mjs'

const navigation = navigationFromConfig()

export default defineConfig({
  plugins: [react()],
  // Public navigation (Home, the Newsletter console), declared in ../wrangler.toml, never written in UI source.
  define: {
    'import.meta.env.VITE_HOME_URL': JSON.stringify(navigation.HOME_URL),
    'import.meta.env.VITE_NEWSLETTER_URL': JSON.stringify(navigation.NEWSLETTER_URL),
  },
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
