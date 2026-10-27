/** Provider token counts and the existing Claude API rate cards. */
import type { TokenUsage } from '../types.ts';
export type { TokenUsage } from '../types.ts';

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

export function unknownUsage(billingKind = 'api'): TokenUsage {
  return { available: false, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, billingKind };
}

interface Price {
  input: number;
  output: number;
}

// Same rate cards as Brief and Mailsort. Unknown models have no estimate.
function claudePrice(model: string, input: number): Price | null {
  if (/^claude-opus-5-5(?:-|$)/.test(model)) return { input: 4, output: 20 };
  if (/^claude-opus-(?:5|4-8)(?:-|$)/.test(model)) return { input: 5, output: 25 };
  if (/^claude-haiku-5-5(?:-|$)/.test(model)) return input > 100_000 ? { input: 0.5, output: 2.5 } : { input: 0.1, output: 0.5 };
  return null;
}

function claudeEntry(value: Record<string, unknown>, model: string): TokenUsage {
  const uncached = tokenCount(value['input_tokens']);
  const output = tokenCount(value['output_tokens']);
  const cacheWrite = tokenCount(value['cache_creation_input_tokens'] ?? 0);
  const cached = tokenCount(value['cache_read_input_tokens'] ?? 0);
  const reasoning = tokenCount(record(value['output_tokens_details'])?.['thinking_tokens'] ?? 0);
  if (uncached === null || output === null || cacheWrite === null || cached === null || reasoning === null || reasoning > output) return unknownUsage();
  const input = tokenCount(uncached + cacheWrite + cached);
  if (input === null) return unknownUsage();
  const total = tokenCount(input + output);
  if (total === null) return unknownUsage();
  const usage: TokenUsage = { available: true, inputTokens: input, outputTokens: output, totalTokens: total, cachedInputTokens: cached, cacheWriteTokens: cacheWrite, reasoningOutputTokens: reasoning, billingKind: 'api' };
  const price = claudePrice(model, input);
  const creation = record(value['cache_creation']);
  const cache5m = tokenCount(creation?.['ephemeral_5m_input_tokens'] ?? (creation === null ? cacheWrite : 0));
  const cache1h = tokenCount(creation?.['ephemeral_1h_input_tokens'] ?? 0);
  if (price !== null && cache5m !== null && cache1h !== null && cache5m + cache1h === cacheWrite) {
    // Opus 5.5's cache reads are 0.05x input; the other existing models use 0.1x.
    const readRate = /^claude-opus-5-5(?:-|$)/.test(model) ? 0.05 : 0.1;
    const cost = tokenCount(Math.ceil(uncached * price.input + cache5m * price.input * 1.25 + cache1h * price.input * 2 + cached * price.input * readRate + output * price.output));
    if (cost !== null) usage.estimatedCostMicrousd = cost;
  }
  return usage;
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const result = {
    available: left.available && right.available,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    billingKind: left.billingKind,
  };
  if (Object.values(result).some(value => typeof value === 'number' && tokenCount(value) === null)) return unknownUsage(left.billingKind);
  const cost = left.estimatedCostMicrousd !== undefined && right.estimatedCostMicrousd !== undefined ? tokenCount(left.estimatedCostMicrousd + right.estimatedCostMicrousd) : null;
  return cost === null ? result : { ...result, estimatedCostMicrousd: cost };
}

export function claudeUsage(value: unknown, requestedModel: string, servedModel: string): TokenUsage {
  const usage = record(value);
  if (usage === null) return unknownUsage();
  const iterations = Array.isArray(usage['iterations']) ? usage['iterations'].map(record).filter((entry): entry is Record<string, unknown> => entry !== null && (entry['type'] === undefined || entry['type'] === 'message' || entry['type'] === 'fallback_message')) : [];
  if (iterations.length === 0) return claudeEntry(usage, servedModel);
  return iterations.map(entry => claudeEntry(entry, typeof entry['model'] === 'string' && entry['model'] !== '' ? entry['model'] : requestedModel)).reduce(addUsage);
}

export function geminiUsage(value: unknown): TokenUsage {
  const usage = record(value);
  if (usage === null) return unknownUsage();
  const prompt = tokenCount(usage['promptTokenCount']);
  const candidates = tokenCount(usage['candidatesTokenCount'] ?? 0);
  const reasoning = tokenCount(usage['thoughtsTokenCount'] ?? 0);
  const tools = tokenCount(usage['toolUsePromptTokenCount'] ?? 0);
  const cached = tokenCount(usage['cachedContentTokenCount'] ?? 0);
  if (prompt === null || candidates === null || reasoning === null || tools === null || cached === null || cached > prompt) return unknownUsage();
  const input = tokenCount(prompt + tools);
  const output = tokenCount(candidates + reasoning);
  if (input === null || output === null) return unknownUsage();
  const total = tokenCount(usage['totalTokenCount'] ?? input + output);
  if (total === null || total < input + output) return unknownUsage();
  return { available: true, inputTokens: input, outputTokens: output, totalTokens: total, cachedInputTokens: cached, cacheWriteTokens: 0, reasoningOutputTokens: reasoning, billingKind: 'api' };
}
