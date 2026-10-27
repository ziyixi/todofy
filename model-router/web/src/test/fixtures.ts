import { vi } from 'vitest'
import type { Generation, Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RequestRecord, UsageSummary } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import type { RouterApi } from '../api'

export const models: Model[] = [
  {
    id: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    provider: 'anthropic',
    kind: 'text',
    configured: true,
    efforts: ['low', 'high'],
  },
  { id: 'gpt-6.1-sol', display_name: 'Sol 6.1', provider: 'openai', kind: 'text', configured: true },
  {
    id: 'gemini-3.8-flash',
    display_name: 'Gemini 3.8 Flash',
    provider: 'google',
    kind: 'text',
    configured: false,
  },
  {
    id: '@cf/baai/bge-m3',
    display_name: 'BGE-M3',
    provider: 'cloudflare',
    kind: 'embedding',
    configured: true,
  },
]
export const generation: Generation = {
  name: 'requests/00000000-0000-4000-8000-000000000001',
  model: 'claude-opus-5-5',
  output: '{"answer":"synthetic response"}',
  usage: {
    available: true,
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 60,
    billing_kind: 'api',
    estimated_cost_microusd: 220,
  },
}
export const record: RequestRecord = {
  generation,
  app: 'synthetic-app',
  provider: 'anthropic',
  state: 'succeeded',
  started_at: '2026-10-26T10:00:00Z',
  completed_at: '2026-10-26T10:00:01Z',
  duration_ms: 1000,
  content_expire_time: '2026-11-02T10:00:00Z',
  content_available: true,
  request: {
    model: 'claude-opus-5-5',
    input: 'Synthetic input',
    instructions: [{ text: 'Synthetic instructions', cache: true }],
    effort: 'high',
    max_output_tokens: 100,
    output_schema_json: '{"type":"object"}',
  },
}
export const summary: RequestRecord = {
  ...record,
  request: undefined,
  content_available: false,
  generation: { ...generation, output: undefined },
}
export const usage: UsageSummary = {
  buckets: [
    {
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
    },
    {
      time: '2026-10-26T00:00:00Z',
      model: 'gpt-6.1-sol',
      provider: 'openai',
      billing_kind: 'subscription',
      request_count: 1,
      failure_count: 1,
      usage_available_count: 0,
    },
  ],
}
export function mockApi(overrides: Partial<RouterApi> = {}): RouterApi {
  return {
    listModels: vi.fn().mockResolvedValue(models),
    listRequests: vi.fn().mockResolvedValue({ requests: [summary] }),
    getRequest: vi.fn().mockResolvedValue(record),
    getUsage: vi.fn().mockResolvedValue(usage),
    generate: vi.fn().mockResolvedValue(generation),
    ...overrides,
  }
}
