import { defineConfig } from 'vitest/config';

// Node, a hand-written fake of the chrome.* APIs and a fake clock (test/fake-chrome.ts), and fake-indexeddb for the
// outbox and the visits: the focus state machine, visits, captures, the outbox and uploads, the update check, the
// manifest, the build, the install script's swap and the uploads against recall.ingest.v1's strict reader. The scripts'
// tests are plain ESM (test/*.test.mjs), like the scripts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
