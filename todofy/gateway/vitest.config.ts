import { defineConfig } from 'vitest/config';

// Unit tests run in Node with fake ASSETS/COORDINATOR bindings; the runtime scenarios in
// ../tests/runtime run the real gateway and core together in workerd.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
