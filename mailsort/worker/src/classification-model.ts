/** Model Router invocation and Mailsort's strict classification result reader. */
import { createModelClient, generationConfig, instructions, modelRequest, type ModelBinding, type Usage } from '@ziyixi/model-router-client';
import { create } from '@ziyixi/proto/protobuf';
import { ParametersSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { classificationItems, CLASSIFICATION_OUTPUT_SCHEMA, type ClassificationEmail, type ClassificationItem } from './classification-result.ts';
import { CLASSIFICATION_EFFORT, CLASSIFIER_MODELS } from './classifier-config.ts';
import type { ClassificationProviderName } from './settings.ts';
import { DRAIN_MAX } from './limits.ts';

// Hint reuse across adjacent batches; the adapter owns whether and how caching is applied.
export const PROMPT_REUSE_WINDOW_MS = 5 * 60_000;
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
  readonly usageAvailable: boolean;
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
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cachedInputTokens, thinkingTokens: usage.reasoningOutputTokens, costMicros: usage.estimatedCostMicrousd ?? 0 };
}

export async function classifyEmails(
  binding: ModelBinding | undefined,
  provider: ClassificationProviderName,
  emails: readonly ClassificationEmail[],
  prompt: { readonly basePrompt: string; readonly personalRules: string; readonly cachePrompt?: boolean },
): Promise<ClassificationBatchResult> {
  if (binding === undefined) throw new ClassificationError(provider, 'MODEL_NOT_CONFIGURED');
  const ids = new Set(emails.map(email => email.id));
  if (!emails.length || emails.length > DRAIN_MAX || ids.size !== emails.length || ids.has('') || !prompt.basePrompt.trim()) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', { configuration: true });
  const config = generationConfig(CLASSIFIER_MODELS[provider], prompt.basePrompt, CLASSIFICATION_OUTPUT_SCHEMA);
  config.instructions = instructions(...[prompt.basePrompt, prompt.personalRules].filter(text => text.trim()).map(text => ({ text, cache: prompt.cachePrompt === true })));
  config.parameters = create(ParametersSchema, { effort: CLASSIFICATION_EFFORT });
  let result;
  try {
    result = await createModelClient(binding).generate(modelRequest(JSON.stringify({ emails }), config, 120_000));
  } catch {
    throw new ClassificationError(provider, 'MODEL_UNAVAILABLE', { attempted: true });
  }
  const usage = usageOf(result.usage);
  const options = { attempted: result.attemptCount > 0, ...(usage === undefined ? {} : { usage }) };
  if (result.error) throw new ClassificationError(provider, result.error.reason, { ...options, configuration: result.error.reason !== 'MODEL_REFUSED' && [3, 7, 9, 16].includes(result.error.code) });
  if (result.state !== 'succeeded' || result.parameters?.effort !== CLASSIFICATION_EFFORT || (result.usage?.billingKind === 'api' && usage === undefined)) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', options);
  let output: unknown;
  try { output = JSON.parse(result.output); } catch { throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', options); }
  const items = classificationItems(output, ids);
  if (items === null) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', options);
  return { model: result.reportedModel || result.model, items, usageAvailable: usage !== undefined,
    inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0, cacheReadTokens: usage?.cacheReadTokens ?? 0, thinkingTokens: usage?.thinkingTokens ?? null, costMicros: usage?.costMicros ?? 0 };
}
