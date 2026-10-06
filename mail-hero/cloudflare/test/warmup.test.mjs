// The startup warm-up (src/native/warmup.ts): it runs without any binding and does not throw, each call it makes is
// routed to its own method by the transcoder's real routes and reads and writes as a request of that method does (a
// renamed field or a changed binding would otherwise warm a path no request takes, or fail the Worker's startup), and
// a whole warm-up stays a small part of Workers' startup budget (the global scope may use up to 1 s of CPU; this
// machine is not Cloudflare's, so the bound is loose). Synthetic data only.
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { MailHeroUiService } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { ownerApiRoutes } from '../src/native/api.ts'
import { warmCall, WARM_CALLS, warmOpsStatus } from '../src/native/warmup.ts'
import { fromWire } from '@ziyixi/proto/wire-json'
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb'

test('the warm-up runs without bindings, every call routed to its own method', () => {
  const routes = ownerApiRoutes()
  const methods = new Set(MailHeroUiService.methods.map(method => method.localName))
  for (const [name, call] of Object.entries(WARM_CALLS)) {
    assert.ok(methods.has(name), name)
    const { request, answer } = warmCall(routes, name, call)
    const method = MailHeroUiService.methods.find(item => item.localName === name)
    assert.equal(request.$typeName, method.input.typeName, name)
    assert.ok(JSON.parse(answer) !== null && typeof JSON.parse(answer) === 'object', name)
  }
  // The heaviest first requests are warmed: the overview (the UI's first), the three that make a delivery, the lists and reads,
  // and the two reads the coordinator answers.
  for (const name of ['getOverview', 'sendMessage', 'resendDelivery', 'testEndpoint', 'listMessages', 'getMessage', 'listDeliveries', 'getDelivery',
    'getMessageContent', 'summarizeDeliveryAttempts']) assert.ok(Object.hasOwn(WARM_CALLS, name), name)
  // Each request carries what the UI sends: the path's name and the body's fields.
  const send = warmCall(routes, 'sendMessage', WARM_CALLS.sendMessage).request
  assert.match(send.name, /^messages\/[0-9a-f-]{36}$/)
  assert.match(send.endpoint, /^endpoints\/[0-9a-f-]{36}$/)
  assert.match(send.requestId, /^[0-9a-f-]{36}$/)
  // The synthetic rows map as D1's rows do: every state names a value of its enum (none is written as unset).
  const delivery = JSON.parse(warmCall(routes, 'sendMessage', WARM_CALLS.sendMessage).answer).delivery
  assert.deepEqual([delivery.state, delivery.effective_state, delivery.retry_mode], ['pending', 'pending', 'auto'])
  const message = JSON.parse(warmCall(routes, 'getMessage', WARM_CALLS.getMessage).answer)
  assert.deepEqual([message.parse_state, message.delivery_state, message.receive_mode], ['ready', 'delivered', 'forward'])
  const attempt = JSON.parse(warmCall(routes, 'listDeliveryAttempts', WARM_CALLS.listDeliveryAttempts).answer).delivery_attempts[0]
  assert.equal(attempt.outcome, 'delivered')
  const overview = JSON.parse(warmCall(routes, 'getOverview', WARM_CALLS.getOverview).answer)
  assert.equal(overview.active_alerts[0].severity, 'warning')
  assert.equal(JSON.parse(warmCall(routes, 'getSetupStatus', WARM_CALLS.getSetupStatus).answer).checks[0].result, 'ok')
  const update = warmCall(routes, 'updateSettings', WARM_CALLS.updateSettings).request
  assert.deepEqual([update.settings.name, update.settings.sendPaused, update.updateMask.paths], ['settings', true, ['send_paused']])
  // Home's status(): the contract's rules hold, and the status takes the paths a real one takes (a guard, signals with metrics).
  const status = warmOpsStatus()
  fromWire(OpsStatusSchema, status, { strict: true })
  assert.deepEqual([status.health, status.guard.level], ['degraded', 'shed'])
  assert.deepEqual(status.signals.map(signal => signal.code), ['delivery_failed', 'parse_failed', 'guard_shed'])
})

// A cold warm-up, as an isolate's startup runs it: in a fresh Node process that never imports api.ts (whose module
// scope runs the warm-up itself), so no code it times was compiled before. The routes are built as the transcoder
// builds them (http-rule.ts httpBindings, most specific first).
const COLD_WARMUP = `
import { httpBindings } from '@ziyixi/proto/http-rule'
import { compareSpecificity } from '@ziyixi/proto/http-path'
import { MailHeroUiService } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { warmUp, WARMUP_ROUNDS } from ${JSON.stringify(new URL('../src/native/warmup.ts', import.meta.url).href)}
const routes = httpBindings(MailHeroUiService).sort((a, b) => compareSpecificity(a.template, b.template))
const start = performance.now()
warmUp(routes, WARMUP_ROUNDS)
console.log(JSON.stringify({ ms: performance.now() - start, rounds: WARMUP_ROUNDS }))
`

test('a whole cold warm-up takes a small part of the startup budget', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', COLD_WARMUP], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(run.status, 0, run.stderr)
  const { ms, rounds } = JSON.parse(run.stdout.trim().split('\n').at(-1))
  console.log(`warm-up, cold: ${rounds} rounds of ${Object.keys(WARM_CALLS).length} calls in ${ms.toFixed(1)} ms`)
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`)
})
