/** Model Router invocation and Mailsort's strict classification result reader. */
import { createModelClient, instructions, modelRequest, type ModelBinding, type Usage } from '@ziyixi/model-router-client';
import { classificationItems, CLASSIFICATION_OUTPUT_SCHEMA, type ClassificationEmail, type ClassificationItem } from './classification-result.ts';
import { CLASSIFICATION_EFFORT, CLASSIFIER_MODELS } from './classifier-config.ts';
import type { ClassificationProviderName } from './settings.ts';
import { DRAIN_MAX } from './limits.ts';

export interface ClassificationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingTokens: number | null;
  readonly costMicros: number;
}
export interface ClassificationBatchResult extends ClassificationUsage {
  readonly model: string;
  readonly items: readonly ClassificationItem[];
}
export class ClassificationError extends Error {
  readonly code: string;
  readonly attempted: boolean;
  readonly usage: ClassificationUsage | undefined;
  readonly configuration: boolean;
  readonly spendLimited: boolean;
  readonly quota: boolean;
  constructor(provider: ClassificationProviderName, reason: string, options: { attempted?: boolean; usage?: ClassificationUsage; configuration?: boolean } = {}) {
    const suffix = reason === 'MODEL_SPEND_LIMIT' ? 'spend_limit' : reason === 'MODEL_AUTH' ? 'auth' : reason === 'MODEL_NOT_CONFIGURED' ? 'not_configured' : reason === 'MODEL_QUOTA' ? 'quota' : reason === 'MODEL_TIMEOUT' ? 'timeout' : reason === 'MODEL_INVALID_ANSWER' || reason === 'MODEL_REFUSED' || reason === 'MODEL_OUTPUT_LIMIT' ? 'bad_answer' : 'unavailable';
    super(`${provider}_${suffix}`);
    this.name = 'ClassificationError';
    this.code = this.message;
    this.attempted = options.attempted ?? false;
    this.usage = options.usage;
    this.configuration = options.configuration ?? (reason === 'MODEL_AUTH' || reason === 'MODEL_NOT_CONFIGURED');
    this.spendLimited = reason === 'MODEL_SPEND_LIMIT';
    this.quota = reason === 'MODEL_QUOTA';
  }
}

function usageOf(usage: Usage | undefined): ClassificationUsage | undefined {
  if (!usage?.available || (usage.billingKind === 'api' && usage.estimatedCostMicrousd === undefined)) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cachedInputTokens, thinkingTokens: null, costMicros: usage.billingKind === 'api' ? usage.estimatedCostMicrousd ?? 0 : 0 };
}

export async function classifyEmails(
  binding: ModelBinding | undefined,
  provider: ClassificationProviderName,
  emails: readonly ClassificationEmail[],
  prompt: { readonly basePrompt: string; readonly personalRules: string },
): Promise<ClassificationBatchResult> {
  if (binding === undefined) throw new ClassificationError(provider, 'MODEL_NOT_CONFIGURED');
  const ids = new Set(emails.map(email => email.id));
  if (!emails.length || emails.length > DRAIN_MAX || ids.size !== emails.length || ids.has('') || !prompt.basePrompt.trim()) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', { configuration: true });
  const options = { model: CLASSIFIER_MODELS[provider], effort: CLASSIFICATION_EFFORT, outputSchemaJson: JSON.stringify(CLASSIFICATION_OUTPUT_SCHEMA),
    // No cache hint: a cache write costs more than the rare reuse between batches saves. Reported cache usage still counts.
    instructions: instructions(...[prompt.basePrompt, prompt.personalRules].filter(text => text.trim())) };
  let result;
  try {
    result = await createModelClient(binding).generate(modelRequest(JSON.stringify({ emails }), options, 120_000));
  } catch {
    throw new ClassificationError(provider, 'MODEL_UNAVAILABLE', { attempted: true });
  }
  const usage = usageOf(result.usage);
  const outcome = { attempted: result.error?.reason !== 'MODEL_NOT_CONFIGURED', ...(usage === undefined ? {} : { usage }) };
  if (result.error) throw new ClassificationError(provider, result.error.reason, { ...outcome, configuration: result.error.reason !== 'MODEL_REFUSED' && [3, 7, 9, 16].includes(result.error.code) });
  if (result.usage?.billingKind === 'api' && usage === undefined) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', outcome);
  let output: unknown;
  try { output = JSON.parse(result.output); } catch { throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', outcome); }
  const items = classificationItems(output, ids);
  if (items === null) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', outcome);
  return { model: result.model, items,
    inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0, cacheReadTokens: usage?.cacheReadTokens ?? 0, thinkingTokens: usage?.thinkingTokens ?? null, costMicros: usage?.costMicros ?? 0 };
}
