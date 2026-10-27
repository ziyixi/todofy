import { expect, it } from 'vitest'
import { startHarness } from './runtime-harness.ts'

it('adapts the actual recommendation array schema internally and returns only the original array', async () => {
  const h = await startHarness()
  try {
    const schema = { type: 'array', maxItems: 2, items: { type: 'object', properties: { rank: { type: 'integer' }, title: { type: 'string' }, reason: { type: 'string' } }, required: ['rank', 'title', 'reason'], additionalProperties: false } }
    const items = [{ rank: 1, title: 'Synthetic reading', reason: 'Synthetic practice' }]
    h.executorOutputs.push(JSON.stringify({ result: items }))
    const answer = await h.models.generate({ model: 'gpt-6.1-sol', input: 'Synthetic recommendations', outputSchemaJson: JSON.stringify(schema) })
    expect(answer.error).toBeUndefined()
    expect(JSON.parse(answer.output)).toEqual(items)
    expect(JSON.parse(String(h.calls[0]?.body.output_schema_json))).toEqual({ type: 'object', properties: { result: schema }, required: ['result'], additionalProperties: false })
    const detail = await h.owner.getRequest({ name: answer.name })
    expect(JSON.parse(detail.request!.outputSchemaJson)).toEqual(schema)
    expect(JSON.parse(detail.generation!.output)).toEqual(items)
    h.executorOutputs.push('{"result":[{"wrong":true}]}')
    const invalid = await h.models.generate({ model: 'gpt-6.1-sol', input: 'Synthetic invalid recommendations', outputSchemaJson: JSON.stringify(schema) })
    expect(invalid.error?.reason).toBe('MODEL_INVALID_ANSWER')
  } finally { await h.dispose() }
}, 30000)
