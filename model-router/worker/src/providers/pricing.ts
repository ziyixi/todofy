/** Standard text-token rates, checked against the linked official pages on 2026-10-27. */
import type { TokenUsage } from '../types.ts';

type CostUsage = Pick<TokenUsage, 'available' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens'>;
interface TokenPrice {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}
interface CacheCreation {
  fiveMinuteTokens: number;
  oneHourTokens: number;
}

// USD per million tokens equals micro-USD per token. No tool, storage or service-tier charges.
function tokenPrice(model: string, inputTokens: number): TokenPrice | undefined {
  switch (model) {
    // Standard, <=272K input tokens. This is the reference API value for subscription use.
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol
    case 'gpt-6.1-sol':
      return inputTokens <= 272_000 ? { input: 2, output: 10, cachedInput: 0.1 } : undefined;

    // https://platform.claude.com/docs/en/about-claude/pricing
    case 'claude-opus-5-5':
      return { input: 4, output: 20, cachedInput: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };
    case 'claude-haiku-5-5':
      return inputTokens > 100_000
        ? { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 }
        : { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 };
    // Existing Claude server-fallback writers. These are prices, not additional catalog routes.
    case 'claude-opus-5':
    case 'claude-opus-4-8':
      return { input: 5, output: 25, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };

    // https://ai.google.dev/gemini-api/docs/pricing
    // Flash's introductory Standard rates run through 2026-12-31; refresh manually before then.
    case 'gemini-3.8-flash':
      return { input: 0.75, output: 3.75, cachedInput: 0.075 };
    case 'gemini-3.5-flash-lite':
      return { input: 0.3, output: 2.5, cachedInput: 0.03 };
    // gemini-3.7-flash is deprecated and automatically routed to 3.8. Price the reported model.
    // https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.7

    // The model page gives 0.0118; the platform table rounds it to 0.012.
    // https://developers.cloudflare.com/workers-ai/models/bge-m3/
    case '@cf/baai/bge-m3':
      return { input: 0.0118, output: 0 };
    default:
      return undefined;
  }
}

/** Prices complete normalized counts; cache/read/reasoning subsets are never charged twice. */
export function estimateCostMicrousd(model: string, usage: CostUsage, cacheCreation?: CacheCreation): number | undefined {
  if (!usage.available) return undefined;
  const price = tokenPrice(model, usage.inputTokens);
  if (!price) return undefined;
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  if (uncached < 0 || (usage.cachedInputTokens > 0 && price.cachedInput === undefined)) return undefined;
  let writes = 0;
  if (usage.cacheWriteTokens > 0) {
    if (!cacheCreation || cacheCreation.fiveMinuteTokens + cacheCreation.oneHourTokens !== usage.cacheWriteTokens
      || price.cacheWrite5m === undefined || price.cacheWrite1h === undefined) return undefined;
    writes = cacheCreation.fiveMinuteTokens * price.cacheWrite5m + cacheCreation.oneHourTokens * price.cacheWrite1h;
  }
  const cost = Math.ceil(uncached * price.input + usage.cachedInputTokens * (price.cachedInput ?? 0) + writes + usage.outputTokens * price.output);
  return Number.isSafeInteger(cost) && cost >= 0 && cost <= 2_147_483_647 ? cost : undefined;
}
