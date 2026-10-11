import { defineConfig } from 'vitest/config';

// Unit tests run in Node: the registry, the schedule, keys and the parsers, the gate's and the pick's rules, the
// grounding check, the model calls over a fake Claude API (the real SDK with an injected fetch: no key), the ledger,
// the feedback token and the render. BriefState, HTMLRewriter and the HTTP surface run in the workerd suite:
// vitest.runtime.config.ts. The content-config texts are imported as strings, as wrangler bundles them.
export default defineConfig({
  plugins: [
    {
      name: 'brief-text',
      transform(code, id) {
        return /\.(md|yaml)$/.test(id) ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/runtime/**', 'node_modules/**'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
