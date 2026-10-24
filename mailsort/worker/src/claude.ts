/** One Claude request for masked mail, with strict ID coverage and no automatic retries. */
import { readCapped } from './gmail.ts';
import { RESPONSE_MAX_BYTES } from './limits.ts';
import { PRIORITY_PROMPT } from './priority-prompt.ts';

export const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 16_384;

export interface ClaudeEmail {
  readonly id: string;
  readonly subject: string;
  readonly sender: string;
  readonly received_at: string;
  readonly evaluated_at: string;
  readonly time_zone: string;
  readonly body: string;
  readonly body_truncated: boolean;
}

export interface ClaudeItem {
  readonly id: string;
  readonly bucket: 'P1' | 'P2' | 'P3' | 'P4';
  readonly reason: string;
}

export interface ClaudeUsage {
  readonly model: string;
  readonly inputTokens: number;
  /** Includes thinking; it must not be added again when calculating cost. */
  readonly outputTokens: number;
  readonly thinkingTokens: number | null;
  /** USD millionths at Opus 5.5's $4 input / $20 output per million tokens. */
  readonly costMicros: number;
}

export interface ClaudeBatchResult extends ClaudeUsage {
  readonly items: readonly ClaudeItem[];
}

/** Only safe codes and numeric usage leave this client on failure. */
export class ClaudeError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly usage: ClaudeUsage | undefined;

  constructor(code: string, status?: number, usage?: ClaudeUsage) {
    super(code);
    this.name = 'ClaudeError';
    this.code = code;
    this.status = status;
    this.usage = usage;
  }
}

export class ClaudeBudgetError extends ClaudeError {
  constructor(status: number) {
    super('claude_spend_limit', status);
    this.name = 'ClaudeBudgetError';
  }
}

export class ClaudeConfigurationError extends ClaudeError {
  constructor(code: string, status?: number) {
    super(code, status);
    this.name = 'ClaudeConfigurationError';
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, bucket: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] }, reason: { type: 'string' } },
        required: ['id', 'bucket', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readUsage(message: Record<string, unknown>): ClaudeUsage {
  const usage = record(message['usage']);
  const input = usage?.['input_tokens'];
  const output = usage?.['output_tokens'];
  const details = usage?.['output_tokens_details'];
  const thinking = details === undefined || details === null ? null : record(details)?.['thinking_tokens'];
  if (message['model'] !== CLAUDE_MODEL) throw new ClaudeError('claude_bad_model');
  if (!tokens(input) || !tokens(output) || (thinking !== null && (!tokens(thinking) || thinking > output))) throw new ClaudeError('claude_bad_usage');
  const costMicros = 4 * input + 20 * output;
  if (!Number.isSafeInteger(costMicros)) throw new ClaudeError('claude_bad_usage');
  return { model: message['model'], inputTokens: input, outputTokens: output, thinkingTokens: thinking, costMicros };
}

function readItems(value: unknown, ids: ReadonlySet<string>, usage: ClaudeUsage): ClaudeItem[] {
  const answer = record(value);
  if (answer === null || Object.keys(answer).length !== 1 || !Array.isArray(answer['items']) || answer['items'].length !== ids.size) throw new ClaudeError('claude_bad_items', 200, usage);
  const seen = new Set<string>();
  return answer['items'].map((value: unknown) => {
    const item = record(value);
    const id = item?.['id'];
    const bucket = item?.['bucket'];
    const reason = item?.['reason'];
    if (item === null || Object.keys(item).length !== 3 || typeof id !== 'string' || !ids.has(id) || seen.has(id)
      || (bucket !== 'P1' && bucket !== 'P2' && bucket !== 'P3' && bucket !== 'P4')
      || typeof reason !== 'string' || reason.trim() === '' || reason.length > 1000) throw new ClaudeError('claude_bad_items', 200, usage);
    seen.add(id);
    return { id, bucket, reason };
  });
}

function readAnswer(value: unknown, ids: ReadonlySet<string>): ClaudeBatchResult {
  const message = record(value);
  if (message === null) throw new ClaudeError('claude_bad_response');
  const usage = readUsage(message);
  if (message['type'] !== 'message' || message['role'] !== 'assistant' || message['stop_reason'] !== 'end_turn' || !Array.isArray(message['content'])) throw new ClaudeError('claude_incomplete', 200, usage);
  let text = '';
  for (const value of message['content']) {
    const block = record(value);
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') text += block['text'];
    else if (block?.['type'] !== 'thinking' && block?.['type'] !== 'redacted_thinking') throw new ClaudeError('claude_bad_content', 200, usage);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClaudeError('claude_bad_json', 200, usage);
  }
  return { ...usage, items: readItems(json, ids, usage) };
}

function providerFailure(status: number, value: unknown): ClaudeError {
  const error = record(record(value)?.['error']);
  const message = error?.['message'];
  const spendCode = record(error?.['details'])?.['error_code'] === 'enforced_spend_limit_reached';
  const spendMessage = typeof message === 'string' && /^You have reached your specified (?:workspace )?API usage limits\b/.test(message);
  if ((status === 400 || status === 429) && (spendCode || spendMessage)) return new ClaudeBudgetError(status);
  if (status === 401 || status === 403) return new ClaudeConfigurationError(`claude_${String(status)}`, status);
  return new ClaudeError(`claude_http_${String(status)}`, status);
}

/** The caller owns pending mail, mode gates and the month's $20 cap. This function sends once. */
export async function classifyEmails(apiKey: string, emails: readonly ClaudeEmail[], fetcher: typeof fetch = fetch): Promise<ClaudeBatchResult> {
  if (apiKey.trim() === '') throw new ClaudeConfigurationError('claude_not_configured');
  const ids = new Set(emails.map(email => email.id));
  if (emails.length === 0 || emails.length > 100 || ids.size !== emails.length || ids.has('')) throw new ClaudeError('claude_bad_input');
  const signal = AbortSignal.timeout(CLAUDE_TIMEOUT_MS);
  let response: Response;
  let bytes: Uint8Array | null;
  try {
    response = await fetcher(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: PRIORITY_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ emails }) }],
      }),
      redirect: 'manual',
      signal,
    });
    bytes = await readCapped(response, RESPONSE_MAX_BYTES);
  } catch {
    throw new ClaudeError(signal.aborted ? 'claude_timeout' : 'claude_network');
  }
  if (bytes === null) throw new ClaudeError('claude_response_too_large', response.status);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    if (!response.ok) throw providerFailure(response.status, null);
    throw new ClaudeError('claude_bad_json', response.status);
  }
  if (!response.ok) throw providerFailure(response.status, json);
  return readAnswer(json, ids);
}
