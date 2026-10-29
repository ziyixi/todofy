import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startHarness } from './runtime-harness.ts'

const api = 'openai/gpt-6.1-sol'
const codex = 'gpt-6.1-sol'

async function seedCost(h: Awaited<ReturnType<typeof startHarness>>, cost: number, { model = api, state = 'succeeded', started = Date.now(), legacy = false } = {}) {
  const id = crypto.randomUUID()
  const generation = { usage: { estimated_cost_microusd: cost, billing_kind: 'api' } }
  await h.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, 'console', model, state,
    started, started, `requests/console/${id}.json`, started + 86400000, '',
    JSON.stringify(legacy ? generation : { generation })).run()
}

describe('OpenAI API and Codex through real D1/R2/SQLite DO bindings', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  beforeAll(async () => { h = await startHarness() })
  afterAll(async () => { await h.dispose() })
  beforeEach(async () => {
    await h.db.prepare('DELETE FROM requests').run()
    h.calls.length = 0
    h.openaiOutputs.length = 0
    h.openaiReplies.length = 0
  })

  it('routes the same native model through separate connections and preserves canonical request identities', async () => {
    const subscription = await h.models.generate({ model: codex, input: 'Synthetic subscription call' })
    const paid = await h.forCaller('todofy').generate({ model: api, input: 'Synthetic API call', effort: 'high', maxOutputTokens: 1000 })
    expect(subscription).toMatchObject({ model: codex, usage: { billingKind: 'subscription' } })
    expect(paid).toMatchObject({ model: api, output: '{"answer":"synthetic API result"}', usage: { available: true,
      billingKind: 'api', inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, estimatedCostMicrousd: 662 } })
    expect(h.calls.map(call => call.path)).toEqual(['/api/codex/v1/model/generations:generate', '/v1/responses'])
    expect(h.calls[1]?.body.model).toBe('gpt-6.1-sol')
    expect(h.calls[1]?.caller).toBeNull()
    const detail = await h.owner.getRequest({ name: paid.name })
    expect(detail).toMatchObject({ app: 'todofy', provider: 'openai', reportedModel: codex, generation: { model: api } })
    expect(detail.request?.model).toBe(api)
    const filtered = await h.owner.listRequests({ model: api })
    expect(filtered.requests.map(row => row.generation?.name)).toEqual([paid.name])
    const buckets = (await h.owner.getUsage({ days: 1 })).buckets
    expect(buckets.find(row => row.model === api)).toMatchObject({ provider: 'openai', billingKind: 'api', requestCount: 1, estimatedCostMicrousd: 662 })
    expect(buckets.find(row => row.model === codex)).toMatchObject({ provider: 'codex', billingKind: 'subscription', requestCount: 1 })
    const stored = await h.db.prepare('SELECT generation_json FROM requests WHERE id = ?').bind(paid.name.slice(9)).first<string>('generation_json')
    expect(stored).not.toContain('Synthetic API call')
    expect(stored).not.toContain('synthetic-openai-key')
  })

  it('keeps reported snapshots separate from filterable API model IDs without guessing their price', async () => {
    h.openaiReplies.push({ body: { model: 'gpt-6.1-sol-synthetic-snapshot', status: 'completed', service_tier: 'default',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic snapshot result' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } })
    const answer = await h.models.generate({ model: api, input: 'Synthetic snapshot request' })
    expect(answer.model).toBe(api)
    expect(answer.usage?.estimatedCostMicrousd).toBeUndefined()
    expect(await h.owner.getRequest({ name: answer.name })).toMatchObject({ reportedModel: 'gpt-6.1-sol-synthetic-snapshot', generation: { model: api } })
  })

  it('uses the existing root-array envelope and rejects invalid output while retaining consumed usage', async () => {
    const schema = { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
    h.openaiOutputs.push('{"result":[{"title":"Synthetic reading"}]}', '{"result":[{"wrong":true}]}')
    const request = { model: api, input: 'Synthetic recommendations', outputSchemaJson: JSON.stringify(schema) }
    const answer = await h.models.generate(request)
    expect(answer.error).toBeUndefined()
    expect(JSON.parse(answer.output)).toEqual([{ title: 'Synthetic reading' }])
    expect(h.calls[0]?.body.text).toEqual({ format: { type: 'json_schema', name: 'router_output', strict: true,
      schema: { type: 'object', properties: { result: schema }, required: ['result'], additionalProperties: false } } })
    const invalid = await h.models.generate(request)
    expect(invalid.output).toBe('')
    expect(invalid.error?.reason).toBe('MODEL_INVALID_ANSWER')
    expect(invalid.usage).toMatchObject({ available: true, inputTokens: 100, outputTokens: 50 })
    expect((await h.owner.getRequest({ name: invalid.name })).state).toBe('failed')
  })

  it('keeps exhausted credits separate from rate limiting without retrying or falling back', async () => {
    for (const code of ['credit_balance_exhausted', 'insufficient_quota', 'rate_limit_exceeded']) {
      h.openaiReplies.push({ status: 429, headers: { 'retry-after': '12' }, body: { error: { code, message: 'Synthetic private provider detail' } } })
      const answer = await h.models.generate({ model: api, input: 'Synthetic credit boundary', allowFallback: true })
      expect(answer.error?.reason).toBe(code === 'rate_limit_exceeded' ? 'MODEL_RATE_LIMIT' : 'MODEL_SPEND_LIMIT')
      expect(answer.usage).toMatchObject({ billingKind: 'api', available: true, estimatedCostMicrousd: 0 })
      const detail = await h.owner.getRequest({ name: answer.name })
      expect(detail.generation?.error?.message).not.toContain('Synthetic private provider detail')
    }
    expect(h.calls).toHaveLength(3)
    expect(h.calls.every(call => call.path === '/v1/responses')).toBe(true)
  })

  it('stops new API calls at the monthly estimated limit before registering or calling a provider', async () => {
    await seedCost(h, 40_000_000)
    await seedCost(h, 40_000_000, { model: 'openai/gpt-6-luna', state: 'failed', legacy: true })
    const bodiesBefore = (await h.bucket.list()).objects.length
    await expect(h.models.generate({ model: api, input: 'Synthetic monthly limit refusal' })).rejects.toMatchObject({
      status: { status: 'RESOURCE_EXHAUSTED', reason: 'MODEL_SPEND_LIMIT' },
    })
    expect(h.calls).toHaveLength(0)
    expect(await h.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(2)
    expect((await h.bucket.list()).objects).toHaveLength(bodiesBefore)
  })

  it('allows a call just below the estimated limit and stops the next call after its cost is recorded', async () => {
    await seedCost(h, 79_999_999)
    expect((await h.models.generate({ model: api, input: 'Synthetic below-limit request' })).error).toBeUndefined()
    await expect(h.models.generate({ model: api, input: 'Synthetic after-limit request' })).rejects.toMatchObject({
      status: { reason: 'MODEL_SPEND_LIMIT' },
    })
    expect(h.calls).toHaveLength(1)
    expect(await h.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(2)
  })

  it('counts only the current UTC month and the OpenAI API model prefix', async () => {
    const now = new Date()
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    await seedCost(h, 80_000_000, { started: start - 1 })
    await seedCost(h, 80_000_000, { started: next })
    await seedCost(h, 80_000_000, { model: codex, started: start })
    await seedCost(h, 79_000_000, { started: start })
    expect((await h.models.generate({ model: api, input: 'Synthetic current-month request' })).error).toBeUndefined()
    expect(h.calls).toHaveLength(1)
  })

  it('leaves Codex and Claude on their existing paths when the OpenAI API estimate is at the limit', async () => {
    await seedCost(h, 80_000_000)
    expect((await h.models.generate({ model: codex, input: 'Synthetic Codex request at API limit' })).error).toBeUndefined()
    const claude = await h.models.generate({ model: 'claude-opus-5-5', input: 'Synthetic Claude request at API limit' })
    // This harness has no Claude key; its usual configuration error still registers the invocation.
    expect(claude.error?.reason).toBe('MODEL_NOT_CONFIGURED')
    expect((await h.owner.getRequest({ name: claude.name })).provider).toBe('anthropic')
    expect(await h.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(3)
    expect(h.calls.map(call => call.path)).toEqual(['/api/codex/v1/model/generations:generate'])
  })

  it('continues restricting Newsletter and conversations to Codex before registering work', async () => {
    await expect(h.newsletter.generate({ model: api, input: 'Synthetic denied API call' })).rejects.toMatchObject({ status: { reason: 'MODEL_NOT_ALLOWED' } })
    await expect(h.models.createConversation({ name: `conversations/${crypto.randomUUID()}`, model: api })).rejects.toMatchObject({ status: { reason: 'MODEL_CAPABILITY_UNSUPPORTED' } })
    expect(h.calls).toHaveLength(0)
    expect(await h.db.prepare('SELECT count(*) AS n FROM requests').first('n')).toBe(0)
  })

  it('reads historical OpenAI-labelled subscription records as Codex without rewriting metadata or bodies', async () => {
    const answer = await h.models.generate({ model: codex, input: 'Synthetic historical subscription input' })
    const id = answer.name.slice(9)
    const original = await h.db.prepare('SELECT generation_json,body_key FROM requests WHERE id = ?').bind(id).first<{ generation_json: string; body_key: string }>()
    const raw = JSON.parse(original!.generation_json) as { provider: string }
    raw.provider = 'openai'
    const historical = JSON.stringify(raw)
    await h.db.prepare('UPDATE requests SET generation_json = ? WHERE id = ?').bind(historical, id).run()
    const body = await h.bucket.get(original!.body_key)
    const bodyBefore = await body!.text()
    expect((await h.owner.getRequest({ name: answer.name })).provider).toBe('codex')
    expect((await h.owner.listRequests({})).requests[0]?.provider).toBe('codex')
    expect((await h.owner.getUsage({ days: 1 })).buckets[0]?.provider).toBe('codex')
    // Older catalog aliases also carry an explicit subscription billing identity.
    await h.db.prepare('UPDATE requests SET model = ? WHERE id = ?').bind('models/sol-6-1', id).run()
    expect((await h.owner.getRequest({ name: answer.name })).provider).toBe('codex')
    expect(await h.db.prepare('SELECT generation_json FROM requests WHERE id = ?').bind(id).first('generation_json')).toBe(historical)
    expect(await (await h.bucket.get(original!.body_key))!.text()).toBe(bodyBefore)
  })
})
