import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '../src/types.ts';
import { estimateCostMicrousd } from '../src/providers/pricing.ts';
import { addUsage, claudeUsage, geminiUsage, unknownUsage } from '../src/providers/usage.ts';

function reported(value: Partial<TokenUsage> = {}): TokenUsage {
  return { ...unknownUsage(), available: true, inputTokens: 100, outputTokens: 50, ...value };
}

describe('native model token prices', () => {
  it('computes the Sol Standard API reference value without changing subscription billing', () => {
    const usage = reported({ billingKind: 'subscription', inputTokens: 100_000, cachedInputTokens: 10_000, outputTokens: 20_000 });
    expect(estimateCostMicrousd('gpt-6.1-sol', usage)).toBe(381_000);
    expect(usage.billingKind).toBe('subscription');
    expect(usage.estimatedCostMicrousd).toBeUndefined();
  });

  it('values cumulative SDK tokens at the stated Standard reference rate', () => {
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ inputTokens: 272_000 }))).toBe(544_500);
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ inputTokens: 272_001 }))).toBe(544_502);
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ inputTokens: 534_327, cachedInputTokens: 454_400, outputTokens: 1526 }))).toBe(220_554);
  });

  it.each([
    ['claude-opus-5-5', 1_400],
    ['claude-haiku-5-5', 35],
    ['gemini-3.8-flash', 263],
    ['gemini-3.5-flash-lite', 155],
  ])('uses the published text rates for %s', (model, expected) => {
    expect(estimateCostMicrousd(model, reported())).toBe(expected);
  });

  it('uses the full-input Haiku threshold including cache reads', () => {
    expect(estimateCostMicrousd('claude-haiku-5-5', reported({ inputTokens: 100_000, outputTokens: 1000 }))).toBe(10_500);
    expect(estimateCostMicrousd('claude-haiku-5-5', reported({ inputTokens: 100_001, outputTokens: 1000 }))).toBe(52_501);
    expect(estimateCostMicrousd('claude-haiku-5-5', reported({ inputTokens: 100_001, cachedInputTokens: 100_000, outputTokens: 1 }))).toBe(5003);
  });

  it('uses the BGE model page rate only when tokens were actually reported', () => {
    expect(estimateCostMicrousd('@cf/baai/bge-m3', reported({ inputTokens: 1_000_000, outputTokens: 0 }))).toBe(11_800);
    const quotaOnly = { ...unknownUsage('platform_quota'), estimatedQuotaUnits: 1.075 };
    expect(estimateCostMicrousd('@cf/baai/bge-m3', quotaOnly)).toBeUndefined();
  });

  it.each(['models/sol-6-1', 'models/gemini-email', 'models/gemini-report', 'gemini-3.7-flash', 'gemini-3.8-flash-unverified', 'unknown'])('leaves unknown native prices unavailable for %s', model => {
    expect(estimateCostMicrousd(model, reported())).toBeUndefined();
  });

  it('keeps missing usage distinct from reported zero', () => {
    expect(estimateCostMicrousd('gpt-6.1-sol', unknownUsage('subscription'))).toBeUndefined();
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ inputTokens: 0, outputTokens: 0 }))).toBe(0);
  });

  it('keeps inconsistent or overflowing costs unavailable', () => {
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ inputTokens: 10, cachedInputTokens: 11 }))).toBeUndefined();
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ outputTokens: 2_147_483_647 }))).toBeUndefined();
    expect(estimateCostMicrousd('gpt-6.1-sol', reported({ cacheWriteTokens: 10 }))).toBeUndefined();
  });
});

describe('pricing after provider usage normalization', () => {
  it('keeps cache creation TTLs and cached input outside uncached Claude input', () => {
    const usage = claudeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens_details: { thinking_tokens: 12 },
    }, 'claude-opus-5-5', 'claude-opus-5-5');
    expect(usage).toMatchObject({ inputTokens: 150, outputTokens: 50, estimatedCostMicrousd: 1506 });
  });

  it('prices each Claude server fallback iteration at its own model and cache TTL', () => {
    const usage = claudeUsage({ iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 } },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 30 },
    ] }, 'claude-opus-5-5', 'claude-opus-5');
    expect(usage).toMatchObject({ available: true, inputTokens: 350, outputTokens: 30, cacheWriteTokens: 20, cachedInputTokens: 30, estimatedCostMicrousd: 2245 });
    expect(usage.estimatedCostMicrousd).not.toBe(estimateCostMicrousd('claude-opus-5', usage, { fiveMinuteTokens: 10, oneHourTokens: 10 }));
  });

  it('keeps tokens but withholds an aggregate cost if a fallback price or model is unknown', () => {
    for (const model of ['', 'claude-unpriced']) {
      const usage = claudeUsage({ iterations: [
        { type: 'message', input_tokens: 100, output_tokens: 10 },
        { type: 'fallback_message', model, input_tokens: 200, output_tokens: 20 },
      ] }, 'claude-opus-5-5', 'claude-opus-5');
      expect(usage.available).toBe(true);
      expect(usage.inputTokens).toBe(300);
      expect(usage.estimatedCostMicrousd).toBeUndefined();
    }
  });

  it('withholds Claude pricing when cache TTL totals are inconsistent', () => {
    const usage = claudeUsage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 10 } }, 'claude-opus-5-5', 'claude-opus-5-5');
    expect(usage.available).toBe(true);
    expect(usage.estimatedCostMicrousd).toBeUndefined();
  });

  it.each([
    ['gemini-3.8-flash', 256],
    ['gemini-3.5-flash-lite', 153],
  ])('includes Gemini thinking once and discounts reported cache reads for %s', (model, cost) => {
    const usage = geminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 10, candidatesTokenCount: 30, thoughtsTokenCount: 20 }, model);
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, estimatedCostMicrousd: cost });
  });

  it('does not price requested Gemini aliases or missing provider reports', () => {
    const usage = { promptTokenCount: 100, candidatesTokenCount: 50 };
    expect(geminiUsage(usage).estimatedCostMicrousd).toBeUndefined();
    expect(geminiUsage(usage, 'gemini-3.7-flash').estimatedCostMicrousd).toBeUndefined();
    expect(geminiUsage(usage, 'gemini-3.8-flash').estimatedCostMicrousd).toBe(263);
  });

  it('sums estimates only when every consumed usage entry has a known estimate', () => {
    const first = geminiUsage({ promptTokenCount: 100, candidatesTokenCount: 50 }, 'gemini-3.8-flash');
    const second = geminiUsage({ promptTokenCount: 100, candidatesTokenCount: 50 }, 'gemini-3.5-flash-lite');
    expect(addUsage(first, second).estimatedCostMicrousd).toBe(418);
    expect(addUsage(first, unknownUsage()).estimatedCostMicrousd).toBeUndefined();
    expect(addUsage(first, unknownUsage()).available).toBe(false);
  });
});
