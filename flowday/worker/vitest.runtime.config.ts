import { defineConfig } from 'vitest/config';

// workerd suite (../docs/design.md "Tests"): each file bundles src/index.ts with esbuild and runs it in Miniflare
// with a real D1 database (../migrations applied), a fake ASSETS binding and an outbound handler that plays the
// Todoist Sync API. No network. Starting workerd takes a few seconds, so files run one at a time.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
