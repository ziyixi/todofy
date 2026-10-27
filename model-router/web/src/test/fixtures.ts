import { vi } from 'vitest'
import type {
  Generation,
  Model,
  RequestRecord,
  UsageSummary,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RouterApi } from '../api'

export const models: Model[] = [
  {
    name: 'models/structured',
    display_name: 'Structured',
    provider: 'Example',
    upstream_model: 'structured-2026',
    configured: true,
    generation: true,
    efforts: ['low', 'high'],
    temperature: true,
    max_output_tokens: true,
  },
  {
    name: 'models/subscription',
    display_name: 'Subscription',
    provider: 'Example SDK',
    upstream_model: 'subscription-2026',
    configured: true,
    generation: true,
  },
  {
    name: 'models/unconfigured',
    display_name: 'Unconfigured',
    provider: 'Example',
    configured: false,
    generation: true,
  },
  {
    name: 'models/vector',
    display_name: 'Vector',
    provider: 'Example',
    configured: true,
    embeddings: true,
    dimensions: 1024,
  },
]

export const generation: Generation = {
  name: 'requests/00000000-0000-4000-8000-000000000001',
  app: 'synthetic-app',
  model: 'models/structured',
  state: 'succeeded',
  started_at: '2026-10-26T10:00:00Z',
  completed_at: '2026-10-26T10:00:01Z',
  duration_ms: 1000,
  content_expire_time: '2026-11-02T10:00:00Z',
  output: '{"answer":"synthetic response"}',
  parameters: { effort: 'high', temperature: 0.3, max_output_tokens: 100 },
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
  config: {
    model: 'models/structured',
    instructions: [{ text: 'Synthetic instructions', cache: true }],
    parameters: generation.parameters,
    output_schema_json: '{"type":"object"}',
  },
  input: 'Synthetic input',
  content_available: true,
}

export const usage: UsageSummary = {
  request_count: 2,
  success_count: 1,
  failure_count: 1,
  usage_available_count: 1,
  input_tokens: 100,
  output_tokens: 20,
  subscription_request_count: 1,
  days: [
    { day: '2026-10-26', request_count: 2, success_count: 1, failure_count: 1, input_tokens: 100, output_tokens: 20 },
  ],
}

export function mockApi(overrides: Partial<RouterApi> = {}): RouterApi {
  return {
    listModels: vi.fn().mockResolvedValue(models),
    listRequests: vi.fn().mockResolvedValue({ requests: [generation] }),
    getRequest: vi.fn().mockResolvedValue(record),
    getUsage: vi.fn().mockResolvedValue(usage),
    generate: vi.fn().mockResolvedValue(generation),
    ...overrides,
  }
}
