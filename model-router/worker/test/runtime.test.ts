import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, machineToken, origin } from './runtime-harness.ts'

const generatePath = '/api/model/v1/generations:generate'
const sol = 'models/sol-6-1'
const gemini = 'models/gemini-3-8-flash'
const schema = JSON.stringify({
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
  additionalProperties: false,
})

describe('Router with real D1, private R2 and SQLite Durable Objects', () => {
  let harness: Awaited<ReturnType<typeof startHarness>>
  beforeAll(async () => {
    harness = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await harness?.dispose()
  })
  beforeEach(async () => {
    await harness.db.batch([
      harness.db.prepare('DELETE FROM requests'),
      harness.db.prepare('DELETE FROM conversations'),
    ])
    const objects = await harness.bucket.list()
    if (objects.objects.length) await harness.bucket.delete(objects.objects.map((object) => object.key))
    harness.calls.length = 0
    harness.geminiOutputs.length = 0
  })

  it('requires owner authentication, exact Origin, custom header and JSON before body parsing', async () => {
    const body = JSON.stringify({
      request_id: crypto.randomUUID(),
      config: { model: gemini },
      input: 'Synthetic owner input',
      metadata: { source: 'synthetic-owner' },
    })
    const blocked = await harness.mf.dispatchFetch(origin + generatePath, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{ malformed synthetic body',
    })
    expect(blocked.status).toBe(403)
    const error = (await blocked.json()) as { error: { details: { reason?: string }[] } }
    expect(error.error.details.some((detail) => detail.reason === 'CSRF_FAILED')).toBe(true)
    expect(harness.calls).toHaveLength(0)
    const session = await harness.mf.dispatchFetch(`${origin}/api/session`)
    expect(session.status).toBe(200)
    const token = ((await session.json()) as { csrf_token: string }).csrf_token
    expect(token).toBe('1')
    expect(session.headers.get('set-cookie')).toBeNull()
    const headers = { 'x-csrf-token': token, 'content-type': 'application/json' }
    const foreign = await harness.mf.dispatchFetch(origin + generatePath, {
      method: 'POST',
      headers: { ...headers, origin: 'https://untrusted.example.test' },
      body,
    })
    expect(foreign.status).toBe(403)
    expect(harness.calls).toHaveLength(0)
    const form = await harness.mf.dispatchFetch(origin + generatePath, { method: 'POST', headers: { origin, 'x-csrf-token': '1', 'content-type': 'text/plain' }, body })
    expect(form.status).toBe(403)
    expect(harness.calls).toHaveLength(0)
    const response = await harness.mf.dispatchFetch(origin + generatePath, {
      method: 'POST',
      headers: { ...headers, origin },
      body,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'succeeded',
      app: 'console',
      metadata: { source: 'synthetic-owner' },
    })
    expect(harness.calls).toHaveLength(1)
    const stored = await harness.owner.listRequests({ app: 'console' })
    expect(stored.requests).toHaveLength(1)
    expect(stored.requests[0]?.app).toBe('console')
  })

  it('rejects unknown models and unsupported controls before starting or billing an execution', async () => {
    await expect(
      harness.models.generate({
        requestId: crypto.randomUUID(),
        config: { model: 'models/missing' },
        input: 'Synthetic input',
      }),
    ).rejects.toMatchObject({ status: { httpStatus: 400, reason: 'MODEL_NOT_FOUND' } })
    await expect(
      harness.models.generate({
        requestId: crypto.randomUUID(),
        config: { model: sol, parameters: { maxOutputTokens: 32 } },
        input: 'Synthetic input',
      }),
    ).rejects.toMatchObject({ status: { httpStatus: 400, reason: 'PARAMETER_UNSUPPORTED' } })
    expect(harness.calls).toHaveLength(0)
    expect(await harness.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(0)
  })

  it('returns final JSON, persists private bodies separately, and reuses one execution for the same request', async () => {
    const request = {
      requestId: crypto.randomUUID(),
      config: { model: sol, outputSchemaJson: schema, webResearch: true },
      input: 'Synthetic private input',
    }
    const [first, repeated] = await Promise.all([harness.models.generate(request), harness.models.generate(request)])
    const persisted = await harness.models.generate(request)
    expect(first.state).toBe('succeeded')
    expect(first.output).toBe('{"answer":"synthetic executor result"}')
    expect(first.reportedModel).toBe('synthetic-sol-reported')
    expect(first.app).toBe('console')
    expect(first.usage?.billingKind).toBe('subscription')
    expect(first.usage?.estimatedCostMicrousd).toBeUndefined()
    expect(repeated.output).toBe(first.output)
    expect(persisted.output).toBe(first.output)
    expect(persisted.observations?.openedUrls).toEqual(['https://example.test/synthetic-research-evidence'])
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({ caller: 'console', bearer: null })
    const row = await harness.db
      .prepare('SELECT generation_json,body_key FROM requests WHERE id = ?')
      .bind(request.requestId)
      .first<{ generation_json: string; body_key: string }>()
    expect(row?.generation_json).not.toContain('Synthetic private input')
    expect(row?.generation_json).not.toContain('synthetic executor result')
    expect(row?.generation_json).not.toContain('https://example.test/synthetic-research-evidence')
    const stored = await harness.bucket.get(row!.body_key)
    expect(await stored?.text()).toContain('Synthetic private input')
    const detail = await harness.owner.getRequest({ name: first.name })
    expect(detail.contentAvailable).toBe(true)
    expect(detail.generation?.output).toBe(first.output)
    expect(detail.input).toBe(request.input)
    expect(detail.generation?.observations?.openedUrls).toEqual(persisted.observations?.openedUrls)
    await expect(harness.models.generate({ ...request, input: 'A different synthetic input' })).rejects.toMatchObject({
      status: { httpStatus: 409 },
    })
    expect(harness.calls).toHaveLength(1)
  })

  it('uses authenticated binding props and does not trust correlation tags as identity', async () => {
    const body = {
      request_id: crypto.randomUUID(),
      config: { model: gemini, output_schema_json: schema },
      input: 'Synthetic bound caller input',
    }
    const response = await harness.caller('todofy', generatePath, body, {
      'x-router-app': 'brief',
      'x-router-owner': 'true',
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ app: 'todofy', state: 'succeeded', reported_model: 'synthetic-gemini-reported' })
    const forbidden = await harness.caller('todofy', generatePath, {
      ...body,
      request_id: crypto.randomUUID(),
      metadata: { app: 'brief' },
    })
    expect(forbidden.status).toBe(200)
    expect(await forbidden.json()).toMatchObject({ app: 'todofy' })
    expect(harness.calls).toHaveLength(2)
    const unknown = await harness.caller('unknown', generatePath, body)
    expect(unknown.status).toBe(403)
    const ownerOnly = await harness.caller('todofy', '/api/model/v1/requests')
    expect(ownerOnly.status).toBe(403)
  })

  it('records invalid schema output as one terminal failure and does not execute it again', async () => {
    harness.geminiOutputs.push('{"answer":123}')
    const body = {
      request_id: crypto.randomUUID(),
      config: { model: 'models/gemini-email', output_schema_json: schema, parameters: { allow_fallback: true } },
      input: 'Synthetic schema failure',
    }
    const first = await harness.caller('todofy', generatePath, body)
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result).toMatchObject({ state: 'failed', error: { reason: 'MODEL_INVALID_ANSWER' }, attempt_count: 1 })
    expect(result).not.toHaveProperty('output')
    const repeated = await harness.caller('todofy', generatePath, body)
    expect(await repeated.json()).toMatchObject({ state: 'failed', error: { reason: 'MODEL_INVALID_ANSWER' } })
    expect(harness.calls).toHaveLength(1)
  })

  it('preserves two short conversation turns and prevents execution after close', async () => {
    const conversation = await harness.forCaller('todofy').createConversation({
      requestId: crypto.randomUUID(),
      conversation: { config: { model: gemini, outputSchemaJson: schema }, timeoutMs: 60_000 },
    })
    expect(conversation.state).toBe('open')
    for (const input of ['Synthetic first turn', 'Synthetic second turn']) {
      const response = await harness.caller('todofy', generatePath, {
        request_id: crypto.randomUUID(),
        conversation: conversation.name,
        input,
      })
      expect(await response.json()).toMatchObject({ state: 'succeeded', conversation: conversation.name })
    }
    expect(harness.calls[1]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Synthetic first turn' }] },
      { role: 'model', parts: [{ text: '{"answer":"synthetic"}' }] },
      { role: 'user', parts: [{ text: 'Synthetic second turn' }] },
    ])
    const closed = await harness.caller('todofy', `/api/model/v1/${conversation.name}:close`, {
      request_id: crypto.randomUUID(),
    })
    expect(await closed.json()).toMatchObject({ state: 'closed' })
    const late = await harness.caller('todofy', generatePath, {
      request_id: crypto.randomUUID(),
      conversation: conversation.name,
      input: 'Synthetic late turn',
    })
    expect(late.status).toBe(400)
    expect(harness.calls).toHaveLength(2)
  })

  it('does not put an invalid schema answer into the next conversation turn', async () => {
    const conversation = await harness.forCaller('todofy').createConversation({
      requestId: crypto.randomUUID(),
      conversation: { config: { model: gemini, outputSchemaJson: schema } },
    })
    harness.geminiOutputs.push('{"answer":123}', '{"answer":"valid"}')
    const invalid = await harness.caller('todofy', generatePath, {
      request_id: crypto.randomUUID(),
      conversation: conversation.name,
      input: 'Synthetic invalid turn',
    })
    expect(await invalid.json()).toMatchObject({ state: 'failed' })
    const valid = await harness.caller('todofy', generatePath, {
      request_id: crypto.randomUUID(),
      conversation: conversation.name,
      input: 'Synthetic valid turn',
    })
    expect(await valid.json()).toMatchObject({ state: 'succeeded' })
    expect(harness.calls[1]?.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Synthetic valid turn' }] }])
    await harness.caller('todofy', `/api/model/v1/${conversation.name}:close`, { request_id: crypto.randomUUID() })
  })

  it('preserves two executor turns and close over the existing private Codex alias', async () => {
    const client = harness.forCaller('brief')
    const conversation = await client.createConversation({
      requestId: crypto.randomUUID(),
      conversation: { config: { model: sol, outputSchemaJson: schema }, timeoutMs: 60_000 },
    })
    expect(conversation.state).toBe('open')
    for (const input of ['Synthetic executor first round', 'Synthetic executor second round']) {
      const result = await client.generate({ requestId: crypto.randomUUID(), conversation: conversation.name, input })
      expect(result.state).toBe('succeeded')
      expect(result.app).toBe('brief')
      expect(result.conversation).toBe(conversation.name)
      expect(result.output).toBe('{"answer":"synthetic executor result"}')
    }
    const closed = await client.closeConversation({ name: conversation.name, requestId: crypto.randomUUID() })
    expect(closed.state).toBe('closed')
    expect(harness.calls).toHaveLength(4)
    expect(harness.calls.every((call) => call.path.startsWith('/api/codex/v1/model/') && call.caller === 'brief')).toBe(
      true,
    )
    expect(
      harness.calls
        .filter((call) => call.path.endsWith('generations:generate'))
        .every((call) => call.body.conversation === conversation.name && call.body.config === undefined),
    ).toBe(true)
  })

  it('paginates bounded metadata and keeps subscription usage separate from unavailable USD estimates', async () => {
    for (let index = 0; index < 3; index += 1)
      await harness.models.generate({
        requestId: crypto.randomUUID(),
        config: { model: sol },
        input: `Synthetic page ${index}`,
      })
    const first = await harness.owner.listRequests({ pageSize: 2, app: 'console', model: sol, state: 'succeeded' })
    expect(first.requests).toHaveLength(2)
    expect(first.nextPageToken).not.toBe('')
    expect(first.requests.every((request) => request.output === '')).toBe(true)
    const next = await harness.owner.listRequests({
      pageSize: 2,
      app: 'console',
      model: sol,
      state: 'succeeded',
      pageToken: first.nextPageToken,
    })
    expect(next.requests).toHaveLength(1)
    expect(new Set([...first.requests, ...next.requests].map((request) => request.name)).size).toBe(3)
    const usage = await harness.owner.getUsage({ days: 1, app: 'console', model: sol })
    expect(usage).toMatchObject({
      requestCount: 3,
      successCount: 3,
      usageAvailableCount: 3,
      subscriptionRequestCount: 3,
      inputTokens: 42,
      outputTokens: 15,
      apiCostAvailable: false,
    })
    await expect(harness.owner.listRequests({ pageSize: 101 })).rejects.toMatchObject({ status: { httpStatus: 400 } })
    await expect(harness.owner.getUsage({ days: 91 })).rejects.toMatchObject({ status: { httpStatus: 400 } })
  })

  it('hides expired private content while retaining metadata, then bounds the ninety-day cleanup', async () => {
    const old = await harness.models.generate({
      requestId: crypto.randomUUID(),
      config: { model: sol },
      input: 'Synthetic expiring body',
    })
    const fresh = await harness.models.generate({
      requestId: crypto.randomUUID(),
      config: { model: sol },
      input: 'Synthetic retained body',
    })
    const oldId = old.name.replace('requests/', '')
    await harness.db
      .prepare('UPDATE requests SET content_expire_ms = ? WHERE id = ?')
      .bind(Date.now() - 1, oldId)
      .run()
    const detail = await harness.owner.getRequest({ name: old.name })
    expect(detail.contentAvailable).toBe(false)
    expect(detail.input).toBe('')
    expect(detail.generation?.output).toBe('')
    expect(detail.generation?.contentUnavailable).toBe(true)
    const oldRow = await harness.db
      .prepare('SELECT body_key FROM requests WHERE id = ?')
      .bind(oldId)
      .first<{ body_key: string }>()
    expect(await harness.bucket.get(oldRow!.body_key)).not.toBeNull()
    await harness.db
      .prepare('UPDATE requests SET started_ms = ? WHERE id = ?')
      .bind(Date.now() - 91 * 86_400_000, oldId)
      .run()
    expect((await harness.mf.dispatchFetch(`${origin}/__test/cleanup`)).status).toBe(204)
    expect(await harness.db.prepare('SELECT id FROM requests WHERE id = ?').bind(oldId).first()).toBeNull()
    expect((await harness.owner.getRequest({ name: fresh.name })).contentAvailable).toBe(true)
  })

  it('marks a missing retained result unavailable without starting a second execution', async () => {
    const request = { requestId: crypto.randomUUID(), config: { model: sol }, input: 'Synthetic missing-result input' }
    const first = await harness.models.generate(request)
    expect(first.state).toBe('succeeded')
    const row = await harness.db
      .prepare('SELECT body_key FROM requests WHERE id = ?')
      .bind(request.requestId)
      .first<{ body_key: string }>()
    await harness.bucket.delete(row!.body_key)
    await expect(harness.models.generate(request)).rejects.toMatchObject({
      status: { reason: 'MODEL_CONTENT_UNAVAILABLE' },
    })
    const detail = await harness.owner.getRequest({ name: first.name })
    expect(detail.contentAvailable).toBe(false)
    expect(detail.generation?.contentUnavailable).toBe(true)
    expect(harness.calls).toHaveLength(1)
  })

  it('rejects a different conversation configuration reused under the same create identity', async () => {
    const client = harness.forCaller('todofy')
    const request = {
      requestId: crypto.randomUUID(),
      conversation: {
        config: { model: gemini, instructions: [{ text: 'Synthetic original instruction' }] },
        timeoutMs: 60_000,
      },
    }
    const first = await client.createConversation(request)
    const same = await client.createConversation(request)
    expect(same.name).toBe(first.name)
    await expect(
      client.createConversation({
        ...request,
        conversation: {
          ...request.conversation,
          config: { ...request.conversation.config, instructions: [{ text: 'Synthetic changed instruction' }] },
        },
      }),
    ).rejects.toMatchObject({ status: { httpStatus: 409 } })
    expect(harness.calls).toHaveLength(0)
    await client.closeConversation({ name: first.name, requestId: crypto.randomUUID() })
  })

  it('serves content-free Ops status and refuses quota shedding through its named binding', async () => {
    await harness.models.generate({
      requestId: crypto.randomUUID(),
      config: { model: sol },
      input: 'Synthetic private Ops boundary',
    })
    const probe = await harness.mf.getWorker('router-ops-probe')
    const response = await probe.fetch(origin)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      version: 'ops-v1',
      app: 'model-router',
      modes: { maintenance: false },
      counters: { requests_today: 1, succeeded_today: 1 },
    })
    expect(JSON.stringify(body)).not.toContain('Synthetic private Ops boundary')
    const guard = await probe.fetch(`${origin}/guard`, {
      method: 'POST',
      body: JSON.stringify({ level: 'shed', reason: 'synthetic', until: null }),
    })
    expect(guard.status).toBe(400)
    expect(harness.calls).toHaveLength(1)
  })

  it('counts Ops today from UTC midnight instead of the preceding twenty-four hours', async () => {
    const previous = await harness.models.generate({
      requestId: crypto.randomUUID(),
      config: { model: sol },
      input: 'Synthetic previous-day request',
    })
    const current = await harness.models.generate({
      requestId: crypto.randomUUID(),
      config: { model: sol },
      input: 'Synthetic current-day request',
    })
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000
    await harness.db.batch([
      harness.db
        .prepare('UPDATE requests SET started_ms = ? WHERE id = ?')
        .bind(midnight - 1, previous.name.replace('requests/', '')),
      harness.db
        .prepare('UPDATE requests SET started_ms = ? WHERE id = ?')
        .bind(midnight + 1, current.name.replace('requests/', '')),
    ])
    const probe = await harness.mf.getWorker('router-ops-probe')
    expect(await (await probe.fetch(origin)).json()).toMatchObject({
      counters: { requests_today: 1, succeeded_today: 1, failed_today: 0 },
    })
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
      body: JSON.stringify({ request_id: crypto.randomUUID(), config: { model: gemini }, input: 'Synthetic authenticated owner input' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ app: 'console', state: 'succeeded' })
    expect(harness.calls).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
}, 30_000)
