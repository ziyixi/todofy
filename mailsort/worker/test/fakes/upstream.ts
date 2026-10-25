/**
 * The one fake behind every outbound request of the Worker in the workerd tests and the local smoke run: Google (the
 * fake Gmail and token endpoint) and Workers AI (`POST /ai/run/<model>`, the shape of env.ts aiRunner's development
 * runner). The Worker's development fetch (env.ts upstreamFetch) sends each Google request to this loopback origin with
 * the real Google URL in `x-mailsort-original-url`; anything else is a 502 and is recorded as a stray request.
 */
import type { ClaudeEmail } from '../../src/claude.ts';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { RunInferenceRequestSchema, RunInferenceResponseSchema, type RunInferenceRequest } from '@ziyixi/proto/codex/inference/v1/inference_pb';
import { FakeAi } from './fake-ai.ts';
import { FakeGmail, type RecordedLedger } from './fake-gmail.ts';

export const ORIGINAL_URL_HEADER = 'x-mailsort-original-url';
export const CODEX_ENDPOINT = 'https://codex.synthetic.example/api/codex/v1/inference:run';

export class FakeUpstream {
  readonly gmail = new FakeGmail();
  readonly ai = new FakeAi();
  readonly claude = {
    calls: [] as ClaudeEmail[][],
    systems: [] as { text: string; cache_control?: { type: string; ttl: string } }[][],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    status: 200,
    badItems: false,
    spendLimit: false,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 1200,
    outputTokens: 120,
    thinkingTokens: 40 as number | null,
  };
  readonly codex = {
    calls: [] as ClaudeEmail[][],
    requests: [] as RunInferenceRequest[],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    status: 200,
    errorCode: '',
    badItems: false,
  };
  /** Requests that were neither Google nor Workers AI. */
  readonly strays: string[] = [];
  /**
   * Reads the store's label paths (the workerd harness and the smoke run set it). Called when a label create or rename
   * arrives, while the Worker waits for it: the independent table then checks the name against what the store
   * planned at that moment, not only its shape (../runtime/helpers.ts checkGoogleCalls).
   */
  plannedPaths: (() => Promise<readonly string[]>) | null = null;
  /** Reads the persisted one-time priority setup plan while the Worker waits for a label DELETE. */
  priorityDeletes: (() => Promise<readonly string[]>) | null = null;
  /** Reads the persisted ledger rows for a modify, including the original fixed priority labels. */
  ledgerRows: ((messageId: string) => Promise<readonly RecordedLedger[]>) | null = null;

  reset(): void {
    this.gmail.reset();
    this.ai.reset();
    this.claude.calls.length = 0;
    this.claude.systems.length = 0;
    this.claude.cacheWriteTokens = 0;
    this.claude.cacheReadTokens = 0;
    this.claude.status = 200;
    this.claude.spendLimit = false;
    this.claude.badItems = false;
    this.codex.calls.length = 0;
    this.codex.requests.length = 0;
    this.codex.bucket = 'P2';
    this.codex.status = 200;
    this.codex.errorCode = '';
    this.codex.badItems = false;
    this.strays.length = 0;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const originalUrl = request.headers.get(ORIGINAL_URL_HEADER) ?? request.url;
    if (request.method === 'POST' && originalUrl === CODEX_ENDPOINT) {
      const input = fromWire(RunInferenceRequestSchema, JSON.parse(body)).message;
      const emails = (JSON.parse(input.inputJson) as { emails: ClaudeEmail[] }).emails;
      this.codex.requests.push(input);
      this.codex.calls.push(emails);
      if (this.codex.status !== 200) return new Response('Synthetic private gateway failure.', { status: this.codex.status });
      const items = this.codex.badItems ? [] : emails.map(email => ({ id: email.id, bucket: this.codex.bucket, reason: 'Synthetic reading priority.' }));
      return Response.json(toWire(RunInferenceResponseSchema, create(RunInferenceResponseSchema, {
        model: 'gpt-6.1-sol', effort: 'medium', outputJson: this.codex.errorCode ? '' : JSON.stringify({ items }),
        inputTokens: 1200, outputTokens: 120, errorCode: this.codex.errorCode,
      })));
    }
    if (request.method === 'POST' && originalUrl === 'https://api.anthropic.com/v1/messages') {
      const input = JSON.parse(body) as { messages: { content: string }[]; system: { text: string; cache_control?: { type: string; ttl: string } }[] };
      const emails = (JSON.parse(input.messages[0]?.content ?? '{}') as { emails: ClaudeEmail[] }).emails;
      this.claude.calls.push(emails);
      this.claude.systems.push(input.system);
      if (this.claude.spendLimit) return Response.json({ error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, { status: 429 });
      if (this.claude.status !== 200) return Response.json({ error: { type: 'api_error' } }, { status: this.claude.status });
      const items = this.claude.badItems ? [] : emails.map(email => ({ id: email.id, bucket: this.claude.bucket, reason: 'Synthetic reading priority.' }));
      return Response.json({ model: 'claude-opus-5-5', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ items }) }],
        usage: { input_tokens: this.claude.inputTokens, output_tokens: this.claude.outputTokens,
          cache_creation_input_tokens: this.claude.cacheWriteTokens, cache_read_input_tokens: this.claude.cacheReadTokens,
          ...(this.claude.thinkingTokens === null ? {} : { output_tokens_details: { thinking_tokens: this.claude.thinkingTokens } }) } });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/ai/run/')) {
      try {
        return Response.json(this.ai.run(decodeURIComponent(url.pathname.slice('/ai/run/'.length)), JSON.parse(body) as Record<string, unknown>));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'ai_error' }, { status: 500 });
      }
    }
    // The development fetch sends the real URL in a header; without the bypass (the CPU test) the URL is Google's itself.
    const original = request.headers.get(ORIGINAL_URL_HEADER) ?? (/^https:\/\/(gmail|oauth2)\.googleapis\.com\//.test(request.url) ? request.url : null);
    if (original === null) {
      this.strays.push(`${request.method} ${request.url}`);
      return new Response('stray', { status: 502 });
    }
    const google = new URL(original);
    const labelWrite = (request.method === 'POST' || request.method === 'PATCH') && /\/labels(\/[^/]+)?$/.test(google.pathname);
    const planned = labelWrite ? await this.plannedPaths?.() : undefined;
    const priorityDeletes = request.method === 'DELETE' ? await this.priorityDeletes?.() : undefined;
    const modify = request.method === 'POST' ? /^\/gmail\/v1\/users\/me\/messages\/([0-9a-f]{6,32})\/modify$/.exec(google.pathname) : null;
    const ledgerRows = modify?.[1] === undefined ? undefined : await this.ledgerRows?.(modify[1]);
    return this.gmail.handle(request.method, google, request.headers, body, planned, priorityDeletes, ledgerRows);
  }
}
