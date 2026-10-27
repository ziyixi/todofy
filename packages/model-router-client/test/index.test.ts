/** The common client speaks only the generated HTTP/wire-JSON contract. */
import { describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { RpcError, Code, statusBody } from '@ziyixi/proto/rpc-status';
import { toWire } from '@ziyixi/proto/wire-json';
import { ConversationSchema, EmbeddingSchema, GenerationSchema, ListModelsResponseSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { createModelClient, generationConfig, instructions, modelRequest, type ModelBinding } from '../src/index.ts';

const ID = 'a16e02ae-4934-45a9-898b-11f48f80bd5c';
const NAME = `conversations/${ID}`;
const MODEL = 'models/sol-6-1';
const ARRAY_SCHEMA = { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } };

function transport(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const binding: ModelBinding = { fetch(request) { calls.push(request); return Promise.resolve(respond(request)); } };
  return { calls, client: createModelClient(binding) };
}
function callAt(calls: readonly Request[], index = 0): Request {
  const request = calls[index];
  if (!request) throw new Error('expected a synthetic transport call');
  return request;
}
function completed() {
  return Response.json(toWire(GenerationSchema, create(GenerationSchema, { name: `requests/${ID}`, model: MODEL, state: 'succeeded', output: '[{"title":"synthetic"}]', usage: { available: false, billingKind: 'subscription' } })));
}

describe('Model Router client helpers', () => {
  it('preserves ordered instruction blocks and the original standard JSON Schema', () => {
    const blocks = instructions('first', { text: 'second', cache: true }, { text: 'third', cache: false });
    expect(blocks.map(block => ({ text: block.text, cache: block.cache }))).toEqual([{ text: 'first', cache: false }, { text: 'second', cache: true }, { text: 'third', cache: false }]);
    const config = generationConfig(MODEL, 'synthetic instructions', ARRAY_SCHEMA);
    expect(config.instructions.map(block => block.text)).toEqual(['synthetic instructions']);
    expect(config.outputSchemaJson).toBe(JSON.stringify(ARRAY_SCHEMA));
    expect(generationConfig(MODEL, 'text only').outputSchemaJson).toBe('');
  });

  it('constructs generated requests with a fresh UUID4 and the default operation budget', () => {
    const config = generationConfig(MODEL, 'synthetic');
    const first = modelRequest('first input', config);
    const second = modelRequest('second input', config, 840_000);
    expect(first.$typeName).toBe('modelrouter.inference.v1.GenerateRequest');
    expect(first.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.requestId).not.toBe(first.requestId);
    expect(first.timeoutMs).toBe(110_000);
    expect(second.timeoutMs).toBe(840_000);
  });
});

describe('generated request transport', () => {
  it('preserves catalog query parameters from call.url', async () => {
    const { calls, client } = transport(() => Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [{ name: MODEL, configured: true }] }))));
    const answer = await client.listModels({ app: 'brief' });
    const request = callAt(calls);
    expect(request.url).toBe('https://model-router.internal/api/model/v1/models?app=brief');
    expect(request.method).toBe('GET');
    expect(await request.text()).toBe('');
    expect(answer.models[0]?.configured).toBe(true);
  });

  it('sends wire field names and a standard schema, then returns typed final JSON', async () => {
    const { calls, client } = transport(completed);
    const request = modelRequest('synthetic input', generationConfig(MODEL, 'synthetic instructions', ARRAY_SCHEMA));
    const answer = await client.generate(request);
    const sent = callAt(calls);
    expect(sent.url).toBe('https://model-router.internal/api/model/v1/generations:generate');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('content-type')).toBe('application/json');
    expect(sent.headers.get('authorization')).toBeNull();
    expect(await sent.json()).toMatchObject({ request_id: request.requestId, input: 'synthetic input', timeout_ms: 110_000, config: { model: MODEL, instructions: [{ text: 'synthetic instructions' }], output_schema_json: JSON.stringify(ARRAY_SCHEMA) } });
    expect(answer.output).toBe('[{"title":"synthetic"}]');
    expect(answer.reportedModel).toBe('');
    expect(answer.usage).toMatchObject({ available: false, inputTokens: 0, outputTokens: 0 });
  });

  it('keeps one request identity when its caller repeats the same request', async () => {
    const { calls, client } = transport(completed);
    const request = modelRequest('synthetic', generationConfig(MODEL, 'synthetic'));
    await client.generate(request);
    await client.generate(request);
    expect(await callAt(calls).json()).toEqual(await callAt(calls, 1).json());
  });

  it('uses the named conversation body and preserves its request_id query', async () => {
    const { calls, client } = transport(() => Response.json(toWire(ConversationSchema, create(ConversationSchema, { name: NAME, state: 'open' }))));
    await client.createConversation({ requestId: ID, conversation: { name: NAME, config: generationConfig(MODEL, 'synthetic'), timeoutMs: 840_000 } });
    const request = callAt(calls);
    expect(request.url).toBe(`https://model-router.internal/api/model/v1/conversations?request_id=${ID}`);
    const body = await request.json<Record<string, unknown>>();
    expect(body).toMatchObject({ name: NAME, timeout_ms: 840_000, config: { model: MODEL } });
    expect(body).not.toHaveProperty('conversation');
    expect(body).not.toHaveProperty('request_id');
  });

  it('uses conversation resource paths and returns closed tombstones without configuration', async () => {
    const { calls, client } = transport(() => Response.json(toWire(ConversationSchema, create(ConversationSchema, { name: NAME, state: 'closed' }))));
    await client.getConversation({ name: NAME });
    const closed = await client.closeConversation({ name: NAME, requestId: ID });
    expect(callAt(calls).url).toBe(`https://model-router.internal/api/model/v1/${NAME}`);
    expect(callAt(calls).method).toBe('GET');
    expect(await callAt(calls).text()).toBe('');
    expect(callAt(calls, 1).url).toBe(`https://model-router.internal/api/model/v1/${NAME}:close`);
    expect(await callAt(calls, 1).json()).toEqual({ request_id: ID });
    expect(closed.state).toBe('closed');
    expect(closed.config).toBeUndefined();
  });

  it('sends a conversation turn without copying context or provider formats into the request', async () => {
    const { calls, client } = transport(completed);
    await client.generate({ requestId: ID, conversation: NAME, input: 'second synthetic turn', timeoutMs: 60_000 });
    const body = await callAt(calls).json<Record<string, unknown>>();
    expect(body).toMatchObject({ request_id: ID, conversation: NAME, input: 'second synthetic turn', timeout_ms: 60_000 });
    expect(body).not.toHaveProperty('config');
  });

  it('preserves embedding order, dimensions and unknown platform usage', async () => {
    const { calls, client } = transport(() => Response.json(toWire(EmbeddingSchema, create(EmbeddingSchema, { name: `requests/${ID}`, model: 'models/bge-m3', dimensions: 2, vectors: [{ values: [1, 0] }, { values: [0, 1] }], usage: { available: false, billingKind: 'platform_quota' } }))));
    const result = await client.embed({ requestId: ID, model: 'models/bge-m3', inputs: ['first synthetic', 'second synthetic'] });
    expect(callAt(calls).url).toBe('https://model-router.internal/api/model/v1/embeddings:embed');
    expect(await callAt(calls).json()).toMatchObject({ inputs: ['first synthetic', 'second synthetic'] });
    expect(result.vectors.map(vector => vector.values)).toEqual([[1, 0], [0, 1]]);
    expect(result.dimensions).toBe(2);
    expect(result.usage?.available).toBe(false);
  });

  it('returns an execution failure as a typed result rather than a transport error', async () => {
    const { client } = transport(() => Response.json(toWire(GenerationSchema, create(GenerationSchema, { name: `requests/${ID}`, model: MODEL, state: 'failed', finishReason: 'refused', error: { code: Code.FAILED_PRECONDITION, reason: 'MODEL_REFUSED', message: 'Synthetic refusal.' } }))));
    const result = await client.generate(modelRequest('synthetic', generationConfig(MODEL, 'synthetic')));
    expect(result.error).toMatchObject({ code: Code.FAILED_PRECONDITION, reason: 'MODEL_REFUSED' });
    expect(result.output).toBe('');
  });

  it('keeps request/auth failures in the shared RPC status contract', async () => {
    const { client } = transport(() => Response.json(statusBody(new RpcError(Code.PERMISSION_DENIED, 'CALLER_NOT_CONFIGURED', 'Synthetic caller rejection.'), { domain: 'modelrouter.inference.v1' }), { status: 403 }));
    await expect(client.listModels({})).rejects.toBeInstanceOf(RpcStatusError);
    await expect(client.listModels({})).rejects.toMatchObject({ status: { httpStatus: 403, status: 'PERMISSION_DENIED', reason: 'CALLER_NOT_CONFIGURED' } });
  });
});
