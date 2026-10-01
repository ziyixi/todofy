import { defineConfig } from 'vitest/config';

// Unit tests run in Node: pure modules (the Todoist answer parser, the sync plan, the CSP hashing) without
// bindings. The workerd suite has its own config: vitest.runtime.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
