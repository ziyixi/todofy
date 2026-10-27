/** Synthetic Model Router results. No provider protocol, credentials or external requests. */
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { GenerationSchema, type GenerateRequest, type Usage } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';

export interface FakeMessage {
  readonly model?: string;
  readonly output?: string;
  readonly finishReason?: string;
  readonly usage?: Partial<Omit<Usage, '$typeName'>>;
  readonly error?: { code: number; reason: string; message?: string; retryAfterSeconds?: number };
  readonly upstreamStarted?: boolean;
  readonly contributingModels?: string[];
}
export function jsonAnswer(value: unknown, model = 'synthetic-reported-model', usage: FakeMessage['usage'] = {}): FakeMessage {
  return { model, output: JSON.stringify(value), usage };
}
export function modelError(reason: string, code: number, upstreamStarted = false): FakeMessage {
  return { error: { code, reason }, upstreamStarted, finishReason: upstreamStarted ? 'interrupted' : '', usage: { available: false } };
}
export function modelResponse(request: GenerateRequest, message: FakeMessage): Response {
  const finish = message.finishReason ?? 'complete';
  const error = message.error ?? (finish === 'refused' ? { code: 9, reason: 'MODEL_REFUSED' } : finish === 'output_limit' ? { code: 8, reason: 'MODEL_OUTPUT_LIMIT' } : undefined);
  const model = message.model ?? request.config?.model ?? '';
  return Response.json(toWire(GenerationSchema, create(GenerationSchema, {
    name: `requests/${request.requestId}`, app: 'brief', model: request.config?.model ?? '', reportedModel: model,
    state: error ? 'failed' : 'succeeded', output: error ? '' : message.output ?? '{}', parameters: request.config?.parameters,
    finishReason: finish, upstreamStarted: message.upstreamStarted ?? true, attemptCount: 1,
    contributingModels: message.contributingModels ?? [model],
    usage: { available: true, inputTokens: 4000, outputTokens: 3000, totalTokens: 7000, estimatedCostMicrousd: 20_000, ...message.usage },
    ...(error ? { error: { ...error, message: error.message ?? 'Safe synthetic model failure.' } } : {}),
  })));
}
export function stepOf(body: Record<string, unknown>): 'gate' | 'pick' | 'write' | 'repair' | 'deep_pick' | 'deep_read' | 'entail' | 'unknown' {
  const system = JSON.stringify(body['instructions'] ?? []);
  if (system.includes('# 初筛的输出')) return 'gate';
  if (system.includes('# 挑选的输出')) return 'pick';
  if (system.includes('# 深读挑选的输出')) return 'deep_pick';
  if (system.includes('# 修订')) return 'repair';
  if (system.includes('# 输出规则（深读）')) return 'deep_read';
  if (system.includes('# 输出规则')) return 'write';
  if (system.includes('verdict')) return 'entail';
  return 'unknown';
}
