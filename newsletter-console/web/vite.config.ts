/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { navigationFromConfig } from '../deploy/public-navigation.mjs'

const navigation = navigationFromConfig()

export default defineConfig({
  plugins: [react()],
  // Public navigation (Home, Fleet, Model Router), declared in ../wrangler.toml, never written in UI source.
  define: {
    'import.meta.env.VITE_HOME_URL': JSON.stringify(navigation.HOME_URL),
    'import.meta.env.VITE_FLEET_URL': JSON.stringify(navigation.FLEET_URL),
    'import.meta.env.VITE_MODEL_ROUTER_URL': JSON.stringify(navigation.MODEL_ROUTER_URL),
  },
  build: {
    // Served by the Worker "newsletter-console" as static assets (../wrangler.toml [assets]).
    outDir: 'dist',
    emptyOutDir: true,
    // The Worker's CSP allows only same-origin scripts, so nothing may be inlined as a data: module.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // Local owner API stays on a loopback origin; production JWT cannot be bypassed remotely.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8796', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8796' } },
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
