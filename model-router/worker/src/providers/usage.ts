/** Provider token counts, with each Claude fallback iteration priced before aggregation. */
import type { TokenUsage } from '../types.ts';
import { estimateCostMicrousd } from './pricing.ts';
export type { TokenUsage } from '../types.ts';

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

export function unknownUsage(billingKind = 'api'): TokenUsage {
  return { available: false, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, billingKind };
}

/** The retained text estimate: roughly one token per CJK character, others per 3.5 code units. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.5);
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
  const usage: TokenUsage = { available: true, inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: cacheWrite, billingKind: 'api' };
  const creation = record(value['cache_creation']);
  const cache5m = tokenCount(creation?.['ephemeral_5m_input_tokens'] ?? (creation === null ? cacheWrite : 0));
  const cache1h = tokenCount(creation?.['ephemeral_1h_input_tokens'] ?? 0);
  if (cache5m !== null && cache1h !== null && cache5m + cache1h === cacheWrite) {
    const cost = estimateCostMicrousd(model, usage, { fiveMinuteTokens: cache5m, oneHourTokens: cache1h });
    if (cost !== undefined) usage.estimatedCostMicrousd = cost;
  }
  return usage;
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const result = {
    available: left.available && right.available,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
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
  return iterations.map(entry => claudeEntry(entry,
    typeof entry['model'] === 'string' && entry['model'] !== '' ? entry['model']
      : entry['type'] === 'fallback_message' ? '' : requestedModel)).reduce(addUsage);
}

export function geminiUsage(value: unknown, reportedModel = ''): TokenUsage {
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
  const result: TokenUsage = { available: total === input + output, inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: 0, billingKind: 'api' };
  const cost = estimateCostMicrousd(reportedModel, result);
  return cost === undefined ? result : { ...result, estimatedCostMicrousd: cost };
}
