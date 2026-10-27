/** One provider-neutral transport for the Cloudflare Router. */
import { create } from '@ziyixi/proto/protobuf';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { GenerateRequestSchema, ModelService, type GenerateRequest, type Instruction, InstructionSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
export type { GenerateRequest, Generation, Usage, Observations, Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
export interface ModelBinding { fetch(request: Request): Promise<Response>; }
export function createModelClient(binding: ModelBinding) {
  return createHttpClient(ModelService, async call => binding.fetch(new Request(`https://model-router.internal${call.url}`, {
    method: call.httpMethod,
    headers: { 'content-type': 'application/json' },
    ...(call.body === undefined ? {} : { body: call.body }),
  })));
}
export function instructions(...blocks: (string | { text: string; cache?: boolean })[]): Instruction[] {
  return blocks.map(block => create(InstructionSchema, typeof block === 'string' ? { text: block } : block));
}
export function modelRequest(input: string, options: Partial<Omit<GenerateRequest, '$typeName' | 'input' | 'timeoutMs'>>, timeoutMs = 110_000): GenerateRequest {
  return create(GenerateRequestSchema, { ...options, input, timeoutMs });
}
