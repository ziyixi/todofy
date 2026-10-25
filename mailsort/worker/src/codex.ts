/** One typed, bounded call to the private subscription-backed Codex gateway. */
import { createHttpClient } from '@ziyixi/proto/http-client';
import { InferenceService } from '@ziyixi/proto/codex/inference/v1/inference_pb';
import { classificationItems, CLASSIFICATION_OUTPUT_SCHEMA, type ClassificationEmail, type ClassificationItem } from './classification-result.ts';
import { CODEX_MODEL, CLASSIFICATION_EFFORT, codexEndpoint } from './classifier-config.ts';
import type { Env } from './env.ts';
import { readCapped } from './gmail.ts';
import { DRAIN_MAX, RESPONSE_MAX_BYTES } from './limits.ts';

export interface CodexUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface CodexBatchResult extends CodexUsage {
  readonly model: string;
  readonly items: readonly ClassificationItem[];
  readonly usageAvailable: boolean;
}
interface CodexErrorOptions {
  readonly attempted?: boolean;
  readonly usage?: CodexUsage | undefined;
}
export class CodexError extends Error {
  readonly code: string;
  readonly attempted: boolean;
  readonly usage: CodexUsage | undefined;
  constructor(code: string, options: CodexErrorOptions = {}) {
    super(code);
    this.name = 'CodexError';
    this.code = code;
    this.attempted = options.attempted ?? false;
    this.usage = options.usage;
  }
}
export class CodexConfigurationError extends CodexError {
  constructor(code: string, options?: CodexErrorOptions) { super(code, options); this.name = 'CodexConfigurationError'; }
}
type CodexEnv = Pick<Env, 'CODEX_ENDPOINT_URL' | 'CODEX_ENDPOINT_TOKEN' | 'CODEX_ACCESS_CLIENT_ID' | 'CODEX_ACCESS_CLIENT_SECRET'>;

export async function classifyWithCodex(
  env: CodexEnv,
  emails: readonly ClassificationEmail[],
  fetcher: typeof fetch,
  prompt: { readonly basePrompt: string; readonly personalRules: string },
): Promise<CodexBatchResult> {
  const endpoint = codexEndpoint(env);
  const token = env.CODEX_ENDPOINT_TOKEN?.trim();
  if (endpoint === null || !token) throw new CodexConfigurationError('codex_not_configured');
  const ids = new Set(emails.map(email => email.id));
  if (!emails.length || emails.length > DRAIN_MAX || ids.size !== emails.length || ids.has('') || !prompt.basePrompt.trim()) throw new CodexError('codex_bad_input');
  const signal = AbortSignal.timeout(120_000);
  let attempted = false;
  let usage: CodexUsage | undefined;
  const client = createHttpClient(InferenceService, async (call) => {
    const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
    if (env.CODEX_ACCESS_CLIENT_ID && env.CODEX_ACCESS_CLIENT_SECRET) {
      headers.set('CF-Access-Client-Id', env.CODEX_ACCESS_CLIENT_ID);
      headers.set('CF-Access-Client-Secret', env.CODEX_ACCESS_CLIENT_SECRET);
    }
    let response: Response;
    attempted = true;
    try { response = await fetcher(endpoint.href, { method: call.httpMethod, headers, body: call.body ?? null, signal, redirect: 'manual' }); }
    catch { throw new CodexError(signal.aborted ? 'codex_timeout' : 'codex_network'); }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new CodexConfigurationError('codex_auth');
    if (response.status === 429) throw new CodexError('codex_quota');
    if (!response.ok) throw new CodexError(`codex_http_${String(response.status)}`);
    const body = await readCapped(response, RESPONSE_MAX_BYTES);
    if (body === null) throw new CodexError('codex_response_too_large');
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  try {
    const answer = await client.runInference({
      instructions: [prompt.basePrompt, prompt.personalRules].filter(text => text.trim()).join('\n\n'),
      inputJson: JSON.stringify({ emails }),
      outputSchemaJson: JSON.stringify(CLASSIFICATION_OUTPUT_SCHEMA),
      model: CODEX_MODEL,
    });
    if (answer.inputTokens < 0 || answer.outputTokens < 0) throw new CodexError('codex_bad_usage');
    // Older gateways did not distinguish unavailable usage from a genuine zero-token response.
    const usageAvailable = answer.usageAvailable || answer.inputTokens > 0 || answer.outputTokens > 0;
    if (usageAvailable) usage = { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
    if (answer.errorCode) {
      if (answer.errorCode === 'codex_auth') throw new CodexConfigurationError('codex_auth');
      throw new CodexError(['codex_quota', 'codex_timeout', 'codex_bad_answer', 'codex_unavailable'].includes(answer.errorCode) ? answer.errorCode : 'codex_unavailable');
    }
    if (answer.model !== CODEX_MODEL || answer.effort !== CLASSIFICATION_EFFORT) throw new CodexError('codex_bad_model');
    let output: unknown;
    try { output = JSON.parse(answer.outputJson); }
    catch { throw new CodexError('codex_bad_json'); }
    const items = classificationItems(output, ids);
    if (items === null) throw new CodexError('codex_bad_items');
    return { model: answer.model, items, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, usageAvailable };
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw new CodexConfigurationError(error.code, { attempted, usage });
    if (error instanceof CodexError) throw new CodexError(error.code, { attempted, usage });
    throw new CodexError(signal.aborted ? 'codex_timeout' : 'codex_bad_answer', { attempted, usage });
  }
}
