import { defineConfig } from 'vitest/config';

// Unit tests run in Node: the shared modules (URL normalization, the scrubber, the denylist, the segmenter), query
// building and snippets, ingest's reading rules and the feed's rendering against the contract's fixtures. RecallState,
// R2 and the HTTP surface run in the workerd suite: vitest.runtime.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
