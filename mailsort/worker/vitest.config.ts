import { defineConfig } from 'vitest/config';

// Unit tests run in Node: the pure modules (normalization and masks, the diff, triggers, robots.txt, scheduling, the
// URL policy, JSONPath, feeds, structured data, markdown, numbers, charsets, the health gate, snapshots, settings and
// the fetch with a stub). HTMLRewriter, WatchState and the API run in the workerd suite: vitest.runtime.config.ts.
export default defineConfig({
  plugins: [{
    name: 'mailsort-prompt',
    transform(code, id) {
      return id.endsWith('/priority-classification.txt') ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined;
    },
  }],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
