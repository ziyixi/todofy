import { defineConfig } from 'vitest/config';

// workerd suite (../docs/design.md §9): each file bundles src/index.ts with esbuild and runs it in Miniflare with a
// real D1 database (../migrations applied), a fake ASSETS binding and an outbound handler that serves a synthetic
// Access issuer's keys. No network. Starting workerd takes a few seconds, so files run one at a time.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
