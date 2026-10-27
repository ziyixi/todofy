import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseStatus } from '@ziyixi/proto/rpc-status'
import { gunzipSync } from 'node:zlib'
import { startHarness, machineToken, origin } from './runtime-harness.ts'
import { newBackup, type BackupStep, type BackupComplete } from '../src/backup.ts'

const generatePath = '/api/model/v1/generations:generate'
const sol = 'gpt-6.1-sol'
const gemini = 'gemini-3.5-flash-lite'
const schema = JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false })

describe('Router with native D1, private R2 and SQLite Durable Objects', () => {
  let harness: Awaited<ReturnType<typeof startHarness>>
  beforeAll(async () => { harness = await startHarness() })
  afterAll(async () => { await harness.dispose() })
  beforeEach(async () => {
    await harness.db.prepare('DELETE FROM requests').run()
    const objects = await harness.bucket.list()
    if (objects.objects.length) await harness.bucket.delete(objects.objects.map((object) => object.key))
    harness.calls.length = 0
    harness.geminiOutputs.length = 0
  })

  it('authenticates and checks Origin, custom header and JSON before reading input', async () => {
    for (const headers of [
      { origin, 'content-type': 'application/json' },
      { origin: 'https://foreign.example.test', 'x-csrf-token': '1', 'content-type': 'application/json' },
      { origin, 'x-csrf-token': '1', 'content-type': 'text/plain' },
    ]) {
      const response = await harness.mf.dispatchFetch(origin + generatePath, { method: 'POST', headers, body: '{broken synthetic body' })
      expect(response.status).toBe(403)
    }
    expect(harness.calls).toHaveLength(0)
    const accepted = await harness.models.generate({ model: gemini, input: 'Synthetic input' })
    expect(accepted.output).toBe('{"answer":"synthetic"}')
    expect((await harness.owner.listRequests({})).requests[0]?.app).toBe('console')
  })

  it('catalog lists actual models/providers and rejects unused request options', async () => {
    const models = (await harness.models.listModels({})).models
    expect(models).toHaveLength(6)
    expect(models.find((model) => model.id === sol)).toMatchObject({ provider: 'openai', kind: 'text' })
    expect(models.some((model) => /gemini-(email|report)/.test(model.id))).toBe(false)
    for (const body of [
      { model: gemini, input: 'Synthetic', temperature: 0.4 },
      { model: gemini, input: 'Synthetic', metadata: { app: 'other' } },
      { model: 'models/gemini-email', input: 'Synthetic' },
      { model: sol, input: 'Synthetic', max_output_tokens: 100 },
    ]) {
      const response = await harness.mf.dispatchFetch(origin + generatePath, { method: 'POST', headers: { origin, 'x-csrf-token': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(response.status).toBe(400)
    }
    expect(harness.calls).toHaveLength(0)
  })

  it('returns a slim final result and keeps trace metadata and bodies in the owner console', async () => {
    const answer = await harness.models.generate({ model: sol, input: 'Synthetic private prompt', effort: 'medium', outputSchemaJson: schema })
    expect(answer).toMatchObject({ model: sol, output: '{"answer":"synthetic executor result"}', usage: { available: true, inputTokens: 14, outputTokens: 5, billingKind: 'subscription', estimatedCostMicrousd: 78 } })
    expect(answer).not.toHaveProperty('state')
    expect(answer).not.toHaveProperty('parameters')
    const row = (await harness.owner.listRequests({})).requests[0]!
    expect(row).toMatchObject({ app: 'console', provider: 'openai', state: 'succeeded', reportedModel: '', contentAvailable: false })
    expect(row.request).toBeUndefined()
    expect(row.generation?.output).toBe('')
    const detail = await harness.owner.getRequest({ name: answer.name })
    expect(detail.contentAvailable).toBe(true)
    expect(detail.request).toMatchObject({ model: sol, input: 'Synthetic private prompt', effort: 'medium' })
    expect(detail.generation?.output).toBe(answer.output)
    const stored = await harness.db.prepare('SELECT generation_json FROM requests').first<{ generation_json: string }>()
    expect(stored?.generation_json).not.toContain('Synthetic private prompt')
    expect(harness.calls[0]?.caller).toBeNull()
    expect(harness.calls[0]?.bearer).toBeNull()
  })

  it('uses binding identity and excludes machine callers from owner history', async () => {
    const answer = await harness.forCaller('mailsort').generate({ model: gemini, input: 'Synthetic mail' })
    expect((await harness.owner.getRequest({ name: answer.name })).app).toBe('mailsort')
    expect((await harness.caller('unknown', generatePath, { model: gemini, input: 'Synthetic' })).status).toBe(403)
    expect((await harness.caller('todofy', '/api/model/v1/requests')).status).toBe(403)
  })

  it('limits the external Newsletter token to Codex models before registering a request', async () => {
    for (const refused of [
      harness.newsletter.generate({ model: gemini, input: 'Synthetic API-billed attempt' }),
      harness.newsletter.embed({ model: '@cf/baai/bge-m3', inputs: ['Synthetic embedding attempt'] }),
    ]) await expect(refused).rejects.toMatchObject({ status: { status: 'PERMISSION_DENIED', reason: 'MODEL_NOT_ALLOWED' } })
    expect(harness.calls).toHaveLength(0)
    expect(await harness.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(0)
    const answer = await harness.newsletter.generate({ model: sol, input: 'Synthetic Codex input' })
    expect(answer.error).toBeUndefined()
    expect((await harness.owner.getRequest({ name: answer.name })).app).toBe('newsletter')
    // In-account bindings and the owner keep their model choices.
    expect((await harness.forCaller('mailsort').generate({ model: gemini, input: 'Synthetic binding input' })).error).toBeUndefined()
  })

  it('keeps failed structured output and consumed tokens visible without returning invalid JSON as success', async () => {
    harness.geminiOutputs.push('{"wrong":true}')
    const answer = await harness.models.generate({ model: gemini, input: 'Synthetic schema input', outputSchemaJson: schema })
    expect(answer.error?.reason).toBe('MODEL_INVALID_ANSWER')
    expect(answer.output).toBe('')
    expect(answer.usage?.inputTokens).toBe(12)
    expect((await harness.owner.getRequest({ name: answer.name })).state).toBe('failed')
  })

  it('reports the Router deadline as MODEL_TIMEOUT, not a cancellation', async () => {
    harness.delayNextGemini(4000)
    const answer = await harness.models.generate({ model: gemini, input: 'Synthetic slow input', timeoutMs: 1500 })
    expect(answer.error).toMatchObject({ code: 4, reason: 'MODEL_TIMEOUT' })
    expect((await harness.owner.getRequest({ name: answer.name })).state).toBe('failed')
  })

  it('preserves two Codex turns and observed web actions, then acknowledges cleanup', async () => {
    const name = `conversations/${crypto.randomUUID()}`
    expect(await harness.models.createConversation({ name, model: sol, instructions: [{ text: 'Synthetic instructions', cache: true }], webResearch: true, outputSchemaJson: schema })).toEqual({ $typeName: 'google.protobuf.Empty' })
    const first = await harness.models.generate({ conversation: name, input: 'Synthetic first turn' })
    const second = await harness.models.generate({ conversation: name, input: 'Synthetic correction' })
    expect(first.observations).toMatchObject({ searched: true, openedUrls: ['https://example.test/synthetic-research-evidence'] })
    expect(second.name).not.toBe(first.name)
    expect(second.usage?.inputTokens).toBe(14)
    await harness.models.closeConversation({ name })
    await harness.models.closeConversation({ name })
    await expect(harness.models.generate({ conversation: name, input: 'After close' })).rejects.toMatchObject({ status: { reason: 'CONVERSATION_CLOSED' } })
    expect(harness.calls.filter((call) => call.path.endsWith(':close'))).toHaveLength(1)
  })

  it('paginates metadata and aggregates actual-model hourly/daily usage with separate billing kinds', async () => {
    for (const model of [sol, gemini, sol]) await harness.models.generate({ model, input: 'Synthetic aggregate input' })
    const first = await harness.owner.listRequests({ pageSize: 2 })
    expect(first.requests).toHaveLength(2)
    const last = await harness.owner.listRequests({ pageSize: 2, pageToken: first.nextPageToken })
    expect(last.requests).toHaveLength(1)
    expect(new Set([...first.requests, ...last.requests].map((row) => row.generation?.name)).size).toBe(3)
    const usage = await harness.owner.getUsage({ days: 1 })
    expect(usage.buckets).toHaveLength(2)
    expect(usage.buckets.find((bucket) => bucket.model === sol)).toMatchObject({ provider: 'openai', billingKind: 'subscription', requestCount: 2, inputTokens: 28, estimatedCostMicrousd: 156, usageAvailableCount: 2 })
    expect(usage.buckets.find((bucket) => bucket.model === gemini)).toMatchObject({ provider: 'google', billingKind: 'api', requestCount: 1 })
    expect(usage.buckets.every((bucket) => bucket.time?.seconds === BigInt(Math.floor(Date.now() / 3600000) * 3600))).toBe(true)
    const daily = await harness.owner.getUsage({ days: 7 })
    expect(daily.buckets.every((bucket) => bucket.time?.seconds === BigInt(Math.floor(Date.now() / 86400000) * 86400))).toBe(true)
  })

  it('keeps unknown usage and incomplete estimates distinct from zero', async () => {
    const answer = await harness.models.generate({ model: sol, input: 'Synthetic usage gap' })
    const row = await harness.db.prepare('SELECT generation_json FROM requests WHERE id = ?').bind(answer.name.slice(9)).first<{ generation_json: string }>()
    const record = JSON.parse(row!.generation_json) as { generation: { usage: object } }
    record.generation.usage = { available: false, billing_kind: 'subscription' }
    await harness.db.prepare('UPDATE requests SET generation_json = ? WHERE id = ?').bind(JSON.stringify(record), answer.name.slice(9)).run()
    const point = (await harness.owner.getUsage({ days: 1 })).buckets[0]!
    expect(point.usageAvailableCount).toBe(0)
    expect(point.costAvailableCount).toBe(0)
    expect(point.estimatedCostMicrousd).toBeUndefined()
  })

  it('keeps known cost subtotals and coverage with priced and unpriced failures in one D1 bucket', async () => {
    const answers = []
    for (let index = 0; index < 4; index++) answers.push(await harness.models.generate({ model: sol, input: 'Synthetic mixed cost coverage' }))
    const started = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1
    await harness.db.prepare('UPDATE requests SET started_ms = ?').bind(started).run()
    for (const [index, usage] of [
      [1, { available: true, input_tokens: 14, output_tokens: 5, billing_kind: 'subscription', estimated_cost_microusd: 78 }],
      [2, { available: true, input_tokens: 0, output_tokens: 0, billing_kind: 'subscription', estimated_cost_microusd: 0 }],
      [3, { available: false, billing_kind: 'subscription' }],
    ] as const) {
      const id = answers[index]!.name.slice(9)
      const row = await harness.db.prepare('SELECT generation_json FROM requests WHERE id = ?').bind(id).first<{ generation_json: string }>()
      const record = JSON.parse(row!.generation_json) as { state: string; generation: { usage: object } }
      record.state = 'failed'
      record.generation.usage = usage
      await harness.db.prepare("UPDATE requests SET generation_json = ?,state = 'failed' WHERE id = ?").bind(JSON.stringify(record), id).run()
    }
    const point = (await harness.owner.getUsage({ days: 1 })).buckets[0]!
    expect(point).toMatchObject({ requestCount: 4, successCount: 1, failureCount: 3, usageAvailableCount: 3, costAvailableCount: 3, estimatedCostMicrousd: 156 })
    // Reported zero is priced; an unpriced failure is still distinguishable from zero.
    await harness.db.prepare('DELETE FROM requests WHERE id != ?').bind(answers[2]!.name.slice(9)).run()
    expect((await harness.owner.getUsage({ days: 1 })).buckets[0]).toMatchObject({ costAvailableCount: 1, estimatedCostMicrousd: 0 })
  })

  it('retains metadata after body expiry and bounds cleanup to old history', async () => {
    const answer = await harness.models.generate({ model: gemini, input: 'Synthetic expiry input' })
    await harness.db.prepare('UPDATE requests SET content_expire_ms = ? WHERE id = ?').bind(Date.now() - 1000, answer.name.slice(9)).run()
    const expired = await harness.owner.getRequest({ name: answer.name })
    expect(expired.contentAvailable).toBe(false)
    expect(expired.request).toBeUndefined()
    expect(expired.generation?.output).toBe('')
    await harness.db.prepare('UPDATE requests SET started_ms = ? WHERE id = ?').bind(Date.now() - 91 * 86400000, answer.name.slice(9)).run()
    await harness.mf.dispatchFetch(origin + '/__test/cleanup')
    expect(await harness.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(0)
  })

  it('reads original historical bodies without requiring deleted public fields', async () => {
    const id = crypto.randomUUID()
    const key = `requests/todofy/${id}.json`
    await harness.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, 'todofy', gemini, 'succeeded', Date.now(), Date.now(), key, Date.now() + 86400000, 'legacy-hash', JSON.stringify({ name: `requests/${id}`, model: 'models/gemini-email', reported_model: gemini, state: 'succeeded', usage: { available: true, input_tokens: 3, output_tokens: 1, total_tokens: 4, billing_kind: 'api' } })).run()
    await harness.bucket.put(key, JSON.stringify({ config: { model: 'models/gemini-email', parameters: { effort: 'low', temperature: 0.7 } }, input: 'Synthetic old input', output: 'Synthetic old result' }))
    const detail = await harness.owner.getRequest({ name: `requests/${id}` })
    expect(detail).toMatchObject({ provider: 'google', reportedModel: gemini, state: 'succeeded', contentAvailable: true })
    expect(detail.request).toMatchObject({ model: 'models/gemini-email', input: 'Synthetic old input', effort: 'low' })
    expect(detail.generation?.output).toBe('Synthetic old result')
  })

  it('uses actual D1/R2 bindings for complete gzip metadata and retained body copies', async () => {
    const answer = await harness.models.generate({ model: gemini, input: 'Synthetic backup input' })
    let cursor = newBackup(Date.now() + 86400000)
    for (let step = 0; step < 12; step += 1) {
      const response = await harness.mf.dispatchFetch(origin + '/__test/backup-step', { method: 'POST', body: JSON.stringify(cursor) })
      expect(response.status).toBe(200)
      const next = await response.json() as BackupStep
      if (!next.next) break
      cursor = next.next
    }
    const marker = await harness.backups.get(`${cursor.prefix}complete.json`)
    expect(await marker?.json() as BackupComplete).toMatchObject({ requests: 1, bodies: 1 })
    const page = await harness.backups.get(`${cursor.prefix}requests/00000.ndjson.gz`)
    const rows = new TextDecoder().decode(gunzipSync(new Uint8Array(await page!.arrayBuffer())))
    expect(rows).toContain(answer.name.slice(9))
    const copy = await harness.backups.get(`${cursor.prefix}bodies/requests/console/${answer.name.slice(9)}.json`)
    expect(await copy!.text()).toContain('Synthetic backup input')
  })

  it('continues native backup when expired VPS context cleanup is unavailable', async () => {
    const isolated = await startHarness()
    try {
      await isolated.models.generate({ model: gemini, input: 'Synthetic independent backup' })
      const name = `conversations/${crypto.randomUUID()}`
      await isolated.models.createConversation({ name, model: sol, timeoutMs: 1000 })
      isolated.failNextClose()
      const ops = await isolated.mf.getWorker('router-ops-probe')
      await ops.fetch(origin)
      const prefix = newBackup(Date.now()).prefix
      await expect.poll(async () => {
        const marker = await isolated.backups.get(`${prefix}complete.json`)
        return marker ? await marker.json() : null
      }, { timeout: 10000, interval: 100 }).toMatchObject({ requests: 1, bodies: 1 })
      expect(isolated.calls.some((call) => call.path.endsWith(':close'))).toBe(true)
    } finally { await isolated.dispose() }
  }, 15000)

  it('keeps Ops content-free and does not offer quota shedding', async () => {
    await harness.models.generate({ model: sol, input: 'Synthetic private Ops input' })
    const ops = await harness.mf.getWorker('router-ops-probe')
    const status = await (await ops.fetch(origin)).json() as { counters: Record<string, number> }
    expect(status.counters.requests_today).toBe(1)
    expect(JSON.stringify(status)).not.toContain('Synthetic private Ops input')
    const guard = await ops.fetch(origin + '/guard', { method: 'POST', body: JSON.stringify({ level: 'shed' }) })
    expect(guard.status).toBe(400)
  })
})

it('authenticates before parsing private bodies and never grants Newsletter owner history access', async () => {
  const harness = await startHarness({ ownerBypass: false })
  try {
    const denied = await harness.mf.dispatchFetch(origin + generatePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ broken synthetic JSON',
    })
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ error: { status: 'UNAUTHENTICATED' } })
    const history = await harness.mf.dispatchFetch(`${origin}/api/model/v1/requests`, {
      headers: { authorization: `Bearer ${machineToken}` },
    })
    expect(history.status).toBe(401)
    expect(history.headers.get('cache-control')).toContain('no-store')
    const catalog = await harness.mf.dispatchFetch(`${origin}/api/model/v1/models`, {
      headers: { authorization: `Bearer ${machineToken}` },
    })
    expect(catalog.status).toBe(200)
    expect(harness.calls).toHaveLength(0)
    const jwt = await harness.ownerToken()
    const ownerHeaders = { 'cf-access-jwt-assertion': jwt }
    const session = await harness.mf.dispatchFetch(`${origin}/api/session`, { headers: ownerHeaders })
    expect(session.status).toBe(200)
    expect(session.headers.get('set-cookie')).toBeNull()
    expect(await session.json()).toEqual({ csrf_token: '1' })
    const publicOrigin = 'https://models.example.test'
    for (const headers of [
      { 'content-type': 'application/json', 'x-csrf-token': '1' },
      { origin: 'null', 'content-type': 'application/json', 'x-csrf-token': '1' },
      { origin: publicOrigin, 'content-type': 'application/json' },
      { origin: publicOrigin, 'content-type': 'text/plain', 'x-csrf-token': '1' },
    ]) {
      const refused = await harness.mf.dispatchFetch(origin + generatePath, {
        method: 'POST', headers: { ...ownerHeaders, ...headers }, body: '{malformed synthetic JSON',
      })
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { status: 'PERMISSION_DENIED' } })
    }
    expect(harness.calls).toHaveLength(0)
    const accepted = await harness.mf.dispatchFetch(origin + generatePath, {
      method: 'POST',
      headers: { ...ownerHeaders, origin: publicOrigin, 'content-type': 'application/json', 'x-csrf-token': 'cached.opaque.header' },
      body: JSON.stringify({ model: gemini, input: 'Synthetic authenticated owner input' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ model: gemini })
    expect(harness.calls).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
}, 30_000)


it('maintenance returns standard UNAVAILABLE before parsing while history, health and Ops remain readable', async () => {
  const harness = await startHarness({ maintenance: true })
  try {
    for (const [method, path] of [['POST', '/generations:generate'], ['POST', '/embeddings:embed'], ['POST', '/conversations']] as const) {
      for (const caller of ['owner', 'newsletter', 'binding']) {
        const headers = { 'content-type': 'application/json', origin, 'x-csrf-token': '1', ...(caller === 'newsletter' ? { authorization: `Bearer ${machineToken}` } : {}) }
        const worker = caller === 'binding' ? await harness.mf.getWorker('caller-todofy') : null
        const init = { method, headers, ...(method === 'POST' ? { body: '{broken synthetic JSON' } : {}) }
        const response = worker ? await worker.fetch(`${origin}/api/model/v1${path}`, init) : await harness.mf.dispatchFetch(`${origin}/api/model/v1${path}`, init)
        expect(response.status).toBe(503)
        expect(parseStatus(response.status, await response.json())?.reason).toBe('MODEL_MAINTENANCE')
      }
    }
    expect((await harness.owner.listRequests({})).requests).toEqual([])
    // Newsletter's startup preflight reads this catalog before it can become ready.
    expect((await harness.models.listModels({})).models).toHaveLength(6)
    // Startup recovery must acknowledge names registered before a refused Create.
    const close = await harness.mf.dispatchFetch(`${origin}/api/model/v1/conversations/${crypto.randomUUID()}:close`, {
      method: 'POST', headers: { authorization: `Bearer ${machineToken}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect(close.status).toBe(200)
    expect(await close.json()).toEqual({})
    expect((await harness.owner.getUsage({ days: 1 })).buckets).toEqual([])
    expect((await harness.mf.dispatchFetch(`${origin}/health`)).status).toBe(200)
    const ops = await harness.mf.getWorker('router-ops-probe')
    expect(await (await ops.fetch(origin)).json()).toMatchObject({ modes: { maintenance: true } })
    expect(harness.calls).toHaveLength(0)
  } finally { await harness.dispose() }
}, 30000)
