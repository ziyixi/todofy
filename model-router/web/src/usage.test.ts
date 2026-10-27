import { describe, expect, it } from 'vitest'
import type { UsageBucket } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import { estimate, totals, usagePoints } from './usage'
const bucket: UsageBucket = {
  time: '2026-10-26T00:00:00Z',
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  billing_kind: 'api',
  request_count: 1,
  success_count: 1,
  input_tokens: 100,
  output_tokens: 20,
  cached_input_tokens: 60,
  usage_available_count: 1,
  estimated_cost_microusd: 220,
}

describe('usage projections', () => {
  it('keeps API and subscription equivalents separate without double-counting cached tokens', () => {
    const result = totals([
      bucket,
      {
        ...bucket,
        model: 'gpt-6.1-sol',
        provider: 'openai',
        billing_kind: 'subscription',
        estimated_cost_microusd: 500,
      },
    ])
    expect(result).toMatchObject({
      requests: 2,
      known: 2,
      tokens: 240,
      api: { value: 220 },
      subscription: { value: 500 },
    })
  })
  it('does not present a partial cost sum as a complete estimate and preserves reported zero', () => {
    expect(estimate([bucket, { ...bucket, estimated_cost_microusd: undefined }], 'api')).toEqual({
      requests: 2,
      missing: 1,
    })
    expect(estimate([{ ...bucket, estimated_cost_microusd: 0 }], 'api').value).toBe(0)
    expect(estimate([], 'subscription')).toEqual({ requests: 0, missing: 0 })
  })
  it('groups native models into UTC hours and leaves unknown consumption and cost as gaps', () => {
    const points = usagePoints(
      [
        bucket,
        {
          ...bucket,
          time: '2026-10-26T01:00:00Z',
          usage_available_count: 0,
          estimated_cost_microusd: undefined,
        },
      ],
      1,
      '2026-10-26T02:15:00Z',
    )
    expect(points).toHaveLength(3)
    expect(points[0]).toMatchObject({
      time: '2026-10-26T00:00:00.000Z',
      requests: 1,
      input: 100,
      output: 20,
      apiCost: 220,
    })
    expect(points[1]).toMatchObject({ requests: 1, input: null, output: null, apiCost: null })
    expect(points[2]).toMatchObject({ requests: 0, input: 0, output: 0, apiCost: 0 })
  })
  it('uses daily bins for longer ranges and refuses to graph incomplete token totals as complete', () => {
    const points = usagePoints(
      [{ ...bucket, request_count: 2, usage_available_count: 1 }],
      7,
      '2026-10-26T12:30:00Z',
    )
    expect(points).toHaveLength(7)
    expect(points[0]?.time).toBe('2026-10-20T00:00:00.000Z')
    expect(points.at(-1)).toMatchObject({ requests: 2, input: null, output: null })
  })
})
