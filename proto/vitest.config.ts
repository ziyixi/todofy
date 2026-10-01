import { defineConfig } from 'vitest/config';

// The codec and IDL tests of proto/ (README.md, Tests). The Python twin runs from npm run test:python.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
