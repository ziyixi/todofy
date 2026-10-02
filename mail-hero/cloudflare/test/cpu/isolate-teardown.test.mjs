// A CPU test that fails must fail, not hang: in CI run 36969376937 a test whose meter could not connect left its
// Miniflare running, and `node --test` waited for the file's process until the job's 15-minute timeout. This test runs
// fixtures/failing-isolates.mjs, whose every test fails in another step that holds a running isolate (startIsolate's
// connect and setup, a session inside measureInIsolates, a test timeout), in a child `node --test`, and holds the child
// to exiting within seconds with nothing of its process group (workerd included) left behind. It measures nothing, so
// it may run beside the measuring tests' files; `npm run test:cpu` runs them one after another anyway.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(new URL('fixtures/failing-isolates.mjs', import.meta.url))
/** How long the child may take: about 4 s (its timed-out test waits 3 s), far less than this on a busy machine too. */
const EXIT_WITHIN_MS = 60_000
/** How long the child's process group may outlive it: Miniflare stops workerd as Node exits. */
const GROUP_GONE_WITHIN_MS = 5_000

/** Whether any process of the group `pgid` is still running. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

test('CPU tests that fail while they hold isolates exit promptly and leave no workerd running', { timeout: 2 * EXIT_WITHIN_MS }, async () => {
  // A process group of its own, so that whatever the child starts can be found, and stopped, after it exits. Without
  // NODE_TEST_CONTEXT, which tells a `node --test` inside a test file to run nothing.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', FIXTURE], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  let timer
  try {
    const code = await Promise.race([
      new Promise(resolve => child.on('close', resolve)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the failing CPU tests did not exit within ${EXIT_WITHIN_MS} ms:\n${output}`)), EXIT_WITHIN_MS)
      }),
    ])
    assert.equal(code, 1, output)
    // Three failures and the timed-out test, which the runner counts as cancelled; the guard disposed of its isolate.
    assert.match(output, /^# pass 0$/m)
    assert.match(output, /^# fail 3$/m)
    assert.match(output, /^# cancelled 1$/m)
    assert.match(output, /cpu teardown: 1 isolate\(s\) still running after the last test, disposed of/)
    const deadline = Date.now() + GROUP_GONE_WITHIN_MS
    while (groupAlive(child.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!groupAlive(child.pid), 'a process the failing CPU tests started (workerd) outlived them')
  } finally {
    clearTimeout(timer)
    if (groupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL')
  }
})
