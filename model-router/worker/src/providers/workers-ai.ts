import type { EmbeddingResult, ProviderContext } from '../types.ts';
import { providerStatus } from './common.ts';
import { estimateTokens, record, unknownUsage } from './usage.ts';

const DIMENSIONS = 1024;

/** The binding returns vectors in the same order as the text batch. */
export async function embedWorkersAI(inputs: readonly string[], context: ProviderContext): Promise<EmbeddingResult> {
  const base: EmbeddingResult = { vectors: [], dimensions: DIMENSIONS, usage: unknownUsage('platform_quota') };
  const fail = (code: number, message: string) => ({ ...base, error: providerStatus(code, message) });
  if (context.route.upstreamModel !== '@cf/baai/bge-m3' || !context.route.embeddings || inputs.length < 1 || inputs.length > 50 || inputs.some(text => text.trim() === '')) return fail(3, 'embedding_invalid_input');
  if (context.env.AI === undefined) return fail(9, 'embedding_not_configured');
  if (context.signal.aborted) return fail(1, 'embedding_cancelled');
  if (context.deadlineMs <= Date.now()) return fail(4, 'embedding_deadline');
  let value: unknown;
  try {
    // Workers AI bindings do not expose a cancellation signal. Await completion before releasing execution.
    value = await context.env.AI.run(context.route.upstreamModel, { text: [...inputs] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return /\b4006\b|daily free allocation|neurons|quota/i.test(message) ? fail(8, 'embedding_quota') : fail(14, 'embedding_unavailable');
  }
  base.usage.estimatedQuotaUnits = inputs.reduce((sum, text) => sum + estimateTokens(text), 0) * (context.route.quotaUnitsPerToken ?? 0);
  if (context.signal.aborted) return fail(1, 'embedding_cancelled');
  if (context.deadlineMs <= Date.now()) return fail(4, 'embedding_deadline');
  const data = record(value)?.['data'];
  if (!Array.isArray(data) || data.length !== inputs.length) return fail(13, 'embedding_invalid_response');
  const vectors: number[][] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length !== DIMENSIONS || !row.every((item): item is number => typeof item === 'number' && Number.isFinite(item))) return fail(13, 'embedding_invalid_response');
    vectors.push([...row]);
  }
  return { ...base, vectors };
}
