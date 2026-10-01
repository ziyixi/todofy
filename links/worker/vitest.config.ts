import { defineConfig } from 'vitest/config';

// Unit tests run in Node: the pure modules (keys, targets and their passthrough, the wire form of a link, the
// preview page) and the redirect path against a recording D1 stand-in. The workerd suite has its own config:
// vitest.runtime.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
