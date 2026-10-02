// Run by test/cpu/isolate-teardown.test.mjs in a child `node --test`, never by `npm run test:cpu` itself (the glob
// test/cpu/*.test.mjs does not reach this directory). Every test here fails, each in another step that holds a running
// isolate; the file's process must still exit promptly and leave nothing of workerd behind.
import test from 'node:test'
import { measureInIsolates } from '../../../../../tools/workerd-cpu/workerd-cpu.mts'
import { startIsolate } from '../isolate.mjs'

/** The smallest Worker that starts an isolate. */
const WORKER = { name: 'teardown', modules: true, compatibilityDate: '2026-09-07', script: 'export default { fetch() { return new Response("ok") } }' }

// As in CI run 36969376937: the isolate is up, then connecting its meter throws (here: no Worker of that name).
test('a meter that cannot connect after the isolate started', async () => {
  await startIsolate({ workers: [WORKER] }, ['not-a-worker'])
})

test('a start whose setup throws after the isolate started', async () => {
  await startIsolate({ workers: [WORKER] }, ['teardown'], async () => {
    throw new Error('synthetic setup failure')
  })
})

test('a session that throws inside measureInIsolates', async () => {
  await measureInIsolates(1, () => startIsolate({ workers: [WORKER] }, ['teardown']), async () => {
    throw new Error('synthetic session failure')
  })
})

// The test times out while its isolate is still running: only the module's guard can dispose of it.
test('a test that times out while it holds a running isolate', { timeout: 3_000 }, async () => {
  await startIsolate({ workers: [WORKER] }, ['teardown'])
  await new Promise(() => {})
})
