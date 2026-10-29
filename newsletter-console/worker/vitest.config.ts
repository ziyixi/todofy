import { defineConfig } from 'vitest/config';

// Unit tests run in Node with fake bindings and a synthetic Access issuer. The workerd suite has its own config:
// vitest.runtime.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
