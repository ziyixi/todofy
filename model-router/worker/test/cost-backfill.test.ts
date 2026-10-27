import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { expect, it } from 'vitest'
import { startHarness } from './runtime-harness.ts'

it('backfills only missing metadata estimates, including large cumulative SDK usage and legacy JSON', async () => {
  const h = await startHarness()
  try {
    const usage = { available: true, input_tokens: 534327, output_tokens: 1526, cached_input_tokens: 454400, billing_kind: 'subscription' }
    const samples = [
      { id: 'large', model: 'gpt-6.1-sol', state: 'succeeded', json: { generation: { usage } } },
      { id: 'legacy', model: 'gemini-3.5-flash-lite', state: 'succeeded', json: { usage: { available: true, input_tokens: 27, output_tokens: 8 } } },
      { id: 'known', model: 'gpt-6.1-sol', state: 'succeeded', json: { generation: { usage: { ...usage, estimated_cost_microusd: 123 } } } },
      { id: 'unknown', model: 'gpt-6.1-sol', state: 'failed', json: { generation: { usage: { billing_kind: 'subscription' } } } },
    ]
    for (const row of samples) {
      await h.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(row.id, 'newsletter', row.model, row.state, 1, 2, `requests/newsletter/${row.id}.json`, 3, '', JSON.stringify(row.json)).run()
    }
    const sql = await readFile(new URL('../../migrations/0003_missing_cost_estimates.sql', import.meta.url), 'utf8')
    await h.db.prepare(sql).run()
    await h.db.prepare(sql).run()
    const values = await h.db.prepare("SELECT id,state,json_extract(COALESCE(json_extract(generation_json,'$.generation'),generation_json),'$.usage.estimated_cost_microusd') AS cost FROM requests ORDER BY id").all()
    expect(values.results).toEqual([
      { id: 'known', state: 'succeeded', cost: 123 },
      { id: 'large', state: 'succeeded', cost: 220554 },
      { id: 'legacy', state: 'succeeded', cost: 29 },
      { id: 'unknown', state: 'failed', cost: null },
    ])
    const after = await h.db.prepare("SELECT generation_json FROM requests WHERE id='large'").first<string>('generation_json')
    expect((JSON.parse(after!) as { generation: { usage: object } }).generation.usage).toMatchObject(usage)
    expect((await h.bucket.list()).objects).toEqual([])
  } finally { await h.dispose() }
}, 30000)
