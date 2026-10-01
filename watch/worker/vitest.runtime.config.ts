import { defineConfig } from 'vitest/config';

// workerd suite (../docs/design.md §10): each file bundles src/index.ts with esbuild and runs it in Miniflare with a
// real SQLite WatchState, a fake ASSETS binding and an outbound service that answers from synthetic sites
// (test/fake-sites.ts) and a synthetic Access issuer's keys. No network. Starting workerd takes a moment, so files
// run one at a time.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
