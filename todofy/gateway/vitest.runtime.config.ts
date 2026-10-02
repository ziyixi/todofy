import { defineConfig } from 'vitest/config';

// The gateway's workerd suite (test/runtime): each file bundles src/index.ts with esbuild and runs it in Miniflare next
// to a stand-in todofy-core (harness.ts). Starting workerd takes a few seconds, so files run one at a time.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
