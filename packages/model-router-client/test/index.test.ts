/** Generated transport only; fixtures contain no vendor protocol. */
import { describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { RpcError, Code, statusBody } from '@ziyixi/proto/rpc-status';
import { toWire } from '@ziyixi/proto/wire-json';
import { EmbeddingSchema, GenerationSchema, ListModelsResponseSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { createModelClient, instructions, modelRequest, type ModelBinding } from '../src/index.ts';
const NAME = 'conversations/a16e02ae-4934-45a9-898b-11f48f80bd5c';
const MODEL = 'gpt-6.1-sol';
const SCHEMA = { type: 'array', items: { type: 'string' } };
function transport(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const binding: ModelBinding = { fetch(request) { calls.push(request); return Promise.resolve(respond(request)); } };
  return { calls, client: createModelClient(binding) };
}
function callAt(calls: readonly Request[], index = 0): Request {
  const request = calls[index];
  if (!request) throw new Error('expected a synthetic call');
  return request;
}
function completed() {
  return Response.json(toWire(GenerationSchema, create(GenerationSchema, { name: 'requests/synthetic', model: MODEL, output: '["synthetic"]', usage: { available: false, billingKind: 'subscription' } })));
}
describe('flat model transport', () => {
  it('preserves instruction ordering and sends only actual generation options', async () => {
    const { client, calls } = transport(completed);
    const blocks = instructions('first', { text: 'second', cache: true });
    const request = modelRequest('synthetic', { model: MODEL, instructions: blocks, effort: 'medium', outputSchemaJson: JSON.stringify(SCHEMA) });
    const answer = await client.generate(request);
    expect(request.timeoutMs).toBe(110_000);
    expect(callAt(calls).url).toBe('https://model-router.internal/api/model/v1/generations:generate');
    expect(callAt(calls).headers.get('content-type')).toBe('application/json');
    expect(await callAt(calls).json()).toEqual({ model: MODEL, input: 'synthetic', instructions: [{ text: 'first' }, { text: 'second', cache: true }], effort: 'medium', output_schema_json: JSON.stringify(SCHEMA), timeout_ms: 110_000 });
    expect(answer.output).toBe('["synthetic"]');
    expect(answer.usage).toMatchObject({ available: false, billingKind: 'subscription' });
  });
  it('lists native model IDs and provider labels', async () => {
    const { client, calls } = transport(() => Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [{ id: MODEL, provider: 'openai', kind: 'text', configured: true }] }))));
    expect((await client.listModels({})).models[0]?.id).toBe(MODEL);
    expect(callAt(calls).url).toBe('https://model-router.internal/api/model/v1/models');
    expect(callAt(calls).method).toBe('GET');
    expect(await callAt(calls).text()).toBe('');
  });
  it('creates and closes the chosen context without separate operation IDs', async () => {
    const { client, calls } = transport(() => Response.json({}));
    await client.createConversation({ name: NAME, model: MODEL, outputSchemaJson: JSON.stringify(SCHEMA), webResearch: true, timeoutMs: 840_000 });
    await client.closeConversation({ name: NAME });
    expect(callAt(calls).url).toBe('https://model-router.internal/api/model/v1/conversations');
    expect(await callAt(calls).json()).toEqual({ name: NAME, model: MODEL, output_schema_json: JSON.stringify(SCHEMA), web_research: true, timeout_ms: 840_000 });
    expect(callAt(calls, 1).url).toBe(`https://model-router.internal/api/model/v1/${NAME}:close`);
    expect(await callAt(calls, 1).json()).toEqual({});
  });
  it('sends a second turn using only the context, input and deadline', async () => {
    const { client, calls } = transport(completed);
    await client.generate({ conversation: NAME, input: 'correction', timeoutMs: 60_000 });
    expect(await callAt(calls).json()).toEqual({ conversation: NAME, input: 'correction', timeout_ms: 60_000 });
  });
  it('preserves embedding order and unknown platform consumption', async () => {
    const { client, calls } = transport(() => Response.json(toWire(EmbeddingSchema, create(EmbeddingSchema, { name: 'requests/synthetic', model: '@cf/baai/bge-m3', vectors: [{ values: [1, 0] }, { values: [0, 1] }], usage: { available: false, billingKind: 'platform_quota' } }))));
    const answer = await client.embed({ model: '@cf/baai/bge-m3', inputs: ['first', 'second'] });
    expect(await callAt(calls).json()).toEqual({ model: '@cf/baai/bge-m3', inputs: ['first', 'second'] });
    expect(answer.vectors.map(vector => vector.values)).toEqual([[1, 0], [0, 1]]);
    expect(answer.usage?.available).toBe(false);
  });
  it('returns model failure receipts and rejects transport/auth failures', async () => {
    const failed = transport(() => Response.json(toWire(GenerationSchema, create(GenerationSchema, { error: { code: 9, reason: 'MODEL_REFUSED' } }))));
    expect((await failed.client.generate({ model: MODEL, input: 'synthetic' })).error?.reason).toBe('MODEL_REFUSED');
    const rejected = transport(() => Response.json(statusBody(new RpcError(Code.PERMISSION_DENIED, 'CALLER_NOT_CONFIGURED', 'Synthetic.'), { domain: 'modelrouter.inference.v1' }), { status: 403 }));
    await expect(rejected.client.listModels({})).rejects.toBeInstanceOf(RpcStatusError);
  });
});
