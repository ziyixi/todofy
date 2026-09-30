import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../uiassets/dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // `npm --prefix ../cloudflare run dev` pins every request URL to http://127.0.0.1:8787
      // (--local-upstream: ../wrangler.toml's production route would otherwise become the URL), so the
      // proxied Origin is that origin too, or the Worker's same-origin CSRF check refuses mutations.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8787' } },
    },
  },
})
