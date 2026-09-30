import { defineConfig } from 'vitest/config';

// workerd suite (docs/design.md §10): each file bundles src/index.ts with esbuild and runs it in Miniflare
// with real D1 and LabState storage, a fake AI binding and an outbound handler that plays arXiv. No network.
// Starting workerd takes a few seconds, so files run one at a time with generous timeouts.
// passWithNoTests only until the harness lands (scaffold); remove it with the first runtime test.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
});
