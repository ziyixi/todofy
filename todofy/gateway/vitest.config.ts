import { defineConfig } from 'vitest/config';

// Unit tests run in Node with fake ASSETS/COORDINATOR bindings; the runtime scenarios in
// ../tests/runtime run the real gateway and core together in workerd. `cloudflare:workers` exists
// only in workerd, so Node gets a stand-in (a leading "/" is the project root).
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': '/test/cloudflare-workers.ts' } },
  test: {
    include: ['test/**/*.test.ts'],
    // The workerd suite has its own config: vitest.runtime.config.ts.
    exclude: ['test/runtime/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
