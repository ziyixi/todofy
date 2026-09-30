import { defineConfig } from 'vitest/config';

// Unit tests run in Node with fake bindings (docs/design.md §9). `cloudflare:workers` exists only in
// workerd, so Node gets a stand-in (a leading "/" is the project root). The workerd suite has its own
// config: vitest.runtime.config.ts.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': '/test/cloudflare-workers.ts' } },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
