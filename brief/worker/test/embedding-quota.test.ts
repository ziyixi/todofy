import { describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { EmbeddingSchema, ListModelsResponseSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { embed, embeddingNeurons, embeddingQuotaRate } from '../src/cluster.ts';

describe('embedding quota metadata', () => {
  it('uses the provided catalog rate in the pure budget estimate', () => {
    expect(embeddingNeurons(['abcd', '中文'], 0.003)).toBeCloseTo(0.012);
    expect(embeddingNeurons(['abcd', '中文'], 0)).toBe(0);
  });

  it('reads the common configured embedding rate without an inference call', async () => {
    const calls: string[] = [];
    const rate = await embeddingQuotaRate({ fetch(request) {
      calls.push(request.url);
      return Promise.resolve(Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [{ name: 'models/bge-m3', configured: true, embeddings: true, reservationQuotaUnitsPerToken: 0.003 }] }))));
    } });
    expect(rate).toBe(0.003);
    expect(calls).toEqual(['https://model-router.internal/api/model/v1/models']);
  });

  it('settles the existing ledger value from returned estimated quota units without inventing tokens', async () => {
    const result = await embed({ fetch: () => Promise.resolve(Response.json(toWire(EmbeddingSchema, create(EmbeddingSchema, { dimensions: 1024, vectors: [{ values: Array<number>(1024).fill(1) }], usage: { available: false, billingKind: 'platform_quota', estimatedQuotaUnits: 4.25 } })))) }, ['synthetic']);
    expect(result.neurons).toBe(4.25);
    expect(result.vectors[0]?.length).toBe(1024);
  });

  it('rejects a missing quota estimate instead of charging zero', async () => {
    await expect(embed({ fetch: () => Promise.resolve(Response.json(toWire(EmbeddingSchema, create(EmbeddingSchema, { dimensions: 1024, vectors: [{ values: Array<number>(1024).fill(1) }], usage: { available: false, billingKind: 'platform_quota' } })))) }, ['synthetic'])).rejects.toMatchObject({ code: 'embedding_bad_answer' });
  });
});
