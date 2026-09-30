import { defineConfig } from 'vitest/config';

// workerd suite: each file bundles src/index.ts with esbuild and runs it in Miniflare next to stub
// "mail-hero" and "todofy" Workers that export an `Ops` entrypoint (docs/design.md §9). Starting
// workerd takes a few seconds, so files run one at a time with generous timeouts.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
