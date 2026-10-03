import { defineConfig } from 'vitest/config';

// The workerd suite runs real SQLite FleetState storage with synthetic metadata and authentication.
// It never connects to the host, models, personal mail or a production Cloudflare account.
// Starting workerd takes a few seconds, so files run one at a time with generous timeouts.
export default defineConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
