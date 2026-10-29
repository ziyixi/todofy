/** Model Router invocation and Mailsort's strict classification result reader. */
import { createModelClient, instructions, modelRequest, type ModelBinding, type Usage } from '@ziyixi/model-router-client';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { Code } from '@ziyixi/proto/rpc-status';
import { classificationItems, CLASSIFICATION_OUTPUT_SCHEMA, type ClassificationEmail, type ClassificationItem } from './classification-result.ts';
import { classifierEffort, classifierModel } from './classifier-config.ts';
import type { ClassificationProviderName, SettingsValue } from './settings.ts';
import { DRAIN_MAX } from './limits.ts';

export interface ClassificationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingTokens: number | null;
  readonly costMicros: number;
}
export interface ClassificationBatchResult {
  readonly model: string;
  readonly items: readonly ClassificationItem[];
  readonly usage?: ClassificationUsage;
}
/**
 * How a failed batch is handled, by the shared Model Router error contract. Configuration waits an hour (or until a
 * settings save) without per-mail attempts; content counts per-mail attempts with a small cap; a timeout counts them
 * with the ordinary cap; infrastructure and capacity defer the whole pass without attempts.
 */
export type FailureKind = 'configuration' | 'content' | 'timeout' | 'infrastructure';

const REASON_KINDS: Readonly<Record<string, FailureKind>> = {
  MODEL_AUTH: 'configuration', MODEL_NOT_CONFIGURED: 'configuration', MODEL_NOT_ALLOWED: 'configuration', MODEL_SPEND_LIMIT: 'configuration',
  MODEL_INVALID_REQUEST: 'content', MODEL_INVALID_ANSWER: 'content', MODEL_REFUSED: 'content', MODEL_OUTPUT_LIMIT: 'content', MODEL_UNSUPPORTED_TOOL: 'content',
  MODEL_TIMEOUT: 'timeout',
  MODEL_QUOTA: 'infrastructure', MODEL_RATE_LIMIT: 'infrastructure', MODEL_UNAVAILABLE: 'infrastructure', MODEL_BUSY: 'infrastructure',
  MODEL_MAINTENANCE: 'infrastructure', MODEL_STORAGE_UNAVAILABLE: 'infrastructure', MODEL_INTERNAL: 'infrastructure',
};

/** The safe error code's suffix (`codex_auth`, `claude_quota`, ...). */
const REASON_SUFFIXES: Readonly<Record<string, string>> = {
  MODEL_AUTH: 'auth', MODEL_NOT_CONFIGURED: 'not_configured', MODEL_NOT_ALLOWED: 'not_allowed', MODEL_SPEND_LIMIT: 'spend_limit',
  MODEL_INVALID_REQUEST: 'bad_input', MODEL_UNSUPPORTED_TOOL: 'bad_input', MODEL_INVALID_ANSWER: 'bad_answer', MODEL_REFUSED: 'bad_answer', MODEL_OUTPUT_LIMIT: 'bad_answer',
  MODEL_TIMEOUT: 'timeout', MODEL_QUOTA: 'quota', MODEL_RATE_LIMIT: 'rate_limit',
};

/** An unknown reason by its google.rpc.Code: 3 content, 7/9/16 configuration, 4 timeout, anything else infrastructure. */
function kindOf(reason: string, code: number): FailureKind {
  return REASON_KINDS[reason] ?? (code === 3 ? 'content' : code === 7 || code === 9 || code === 16 ? 'configuration' : code === 4 ? 'timeout' : 'infrastructure');
}

function suffixOf(reason: string, code: number): string {
  return REASON_SUFFIXES[reason] ?? (code === 3 ? 'bad_input' : code === 7 ? 'not_allowed' : code === 9 ? 'not_configured' : code === 16 ? 'auth' : code === 4 ? 'timeout' : 'unavailable');
}

/** Whether a stored safe code is a configuration failure the owner can fix (a spend limit waits for its month). */
export function configurationCode(code: string): boolean {
  return /^(claude|codex|openai|google)_(auth|not_configured|not_allowed)$/.test(code);
}

export class ClassificationError extends Error {
  readonly code: string;
  readonly kind: FailureKind;
  readonly usage: ClassificationUsage | undefined;
  readonly spendLimited: boolean;
  readonly quota: boolean;
  /** The Router's Retry-After, 0 when it gave none. */
  readonly retryAfterMs: number;
  constructor(provider: ClassificationProviderName, reason: string, options: { code?: number; usage?: ClassificationUsage | undefined; retryAfterSeconds?: number; kind?: FailureKind } = {}) {
    const code = options.code ?? 2;
    super(`${provider}_${suffixOf(reason, code)}`);
    this.name = 'ClassificationError';
    this.code = this.message;
    this.kind = options.kind ?? kindOf(reason, code);
    this.usage = options.usage;
    this.spendLimited = reason === 'MODEL_SPEND_LIMIT';
    this.quota = reason === 'MODEL_QUOTA';
    this.retryAfterMs = Math.max(0, options.retryAfterSeconds ?? 0) * 1000;
  }
}

function usageOf(usage: Usage | undefined): ClassificationUsage | undefined {
  if (!usage?.available) return undefined;
  const costMicros = usage.billingKind === 'api' ? usage.estimatedCostMicrousd : 0;
  if (costMicros === undefined) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cachedInputTokens, thinkingTokens: null, costMicros };
}

export async function classifyEmails(
  binding: ModelBinding | undefined,
  provider: ClassificationProviderName,
  emails: readonly ClassificationEmail[],
  prompt: { readonly basePrompt: string; readonly personalRules: string },
  selection?: Pick<SettingsValue, 'classificationModel' | 'classificationEffort'>,
): Promise<ClassificationBatchResult> {
  if (binding === undefined) throw new ClassificationError(provider, 'MODEL_NOT_CONFIGURED');
  const ids = new Set(emails.map(email => email.id));
  // A broken local batch or an empty saved base prompt: held like configuration, never charged to the mail.
  if (!emails.length || emails.length > DRAIN_MAX || ids.size !== emails.length || ids.has('') || !prompt.basePrompt.trim()) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', { kind: 'configuration' });
  const options = { model: classifierModel({ classificationProvider: provider, ...selection }), effort: classifierEffort(selection ?? {}), outputSchemaJson: JSON.stringify(CLASSIFICATION_OUTPUT_SCHEMA),
    // No cache hint: a cache write costs more than the rare reuse between batches saves. Reported cache usage still counts.
    instructions: instructions(...[prompt.basePrompt, prompt.personalRules].filter(text => text.trim())) };
  let result;
  try {
    result = await createModelClient(binding).generate(modelRequest(JSON.stringify({ emails }), options, 120_000));
  } catch (error) {
    // The Router's own refusal (auth, maintenance) carries a reason; any other transport failure is infrastructure.
    if (error instanceof RpcStatusError) throw new ClassificationError(provider, error.status.reason ?? '', { code: error.status.status === undefined ? 2 : Code[error.status.status] });
    throw new ClassificationError(provider, 'MODEL_UNAVAILABLE', { code: Code.UNAVAILABLE });
  }
  const usage = usageOf(result.usage);
  const outcome = { usage };
  if (result.error) throw new ClassificationError(provider, result.error.reason, { ...outcome, code: result.error.code, retryAfterSeconds: result.error.retryAfterSeconds });
  let output: unknown;
  try { output = JSON.parse(result.output); } catch { throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', outcome); }
  const items = classificationItems(output, ids);
  if (items === null) throw new ClassificationError(provider, 'MODEL_INVALID_ANSWER', outcome);
  return { model: result.model, items, ...(usage === undefined ? {} : { usage }) };
}
