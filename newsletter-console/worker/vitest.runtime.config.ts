import { defineConfig } from 'vitest/config';

// The workerd suite runs the bundled Worker with synthetic Access keys served by an outbound handler. It never
// connects to Newsletter, the host or a production Cloudflare account. Starting workerd takes a few seconds, so files
// run one at a time with generous timeouts.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
