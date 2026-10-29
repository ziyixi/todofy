/**
 * The one fake behind every outbound request of the Worker in the workerd tests and the local smoke run: Google (the
 * fake Gmail and token endpoint) and Model Router (the common inference API, for both providers). The Worker's
 * development fetch (env.ts upstreamFetch) sends each Google request to this loopback origin with the real Google URL in
 * `x-mailsort-original-url`; anything else is a 502 and is recorded as a stray request.
 */
import type { ClassificationEmail as ClaudeEmail } from '../../src/classification-result.ts';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { GenerateRequestSchema, GenerationSchema, ListModelsResponseSchema, type GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { FakeGmail, type RecordedLedger } from './fake-gmail.ts';

export const ORIGINAL_URL_HEADER = 'x-mailsort-original-url';
export const MODEL_ENDPOINT = 'https://model-router.internal/api/model/v1/generations:generate';

export class FakeUpstream {
  readonly gmail = new FakeGmail();
  readonly claude = {
    calls: [] as ClaudeEmail[][],
    systems: [] as { text: string; cache: boolean }[][],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    configured: true,
    errorReason: '',
    errorCode: 0,
    retryAfterSeconds: 0,
    badItems: false,
    /** A message ID whose presence makes the whole batch answer invalid (one mail the model cannot answer). */
    poison: '',
    spendLimit: false,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 1200,
    outputTokens: 120,
    thinkingTokens: 40 as number | null,
    costAvailable: true,
  };
  readonly codex = {
    calls: [] as ClaudeEmail[][],
    requests: [] as GenerateRequest[],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    configured: true,
    errorReason: '',
    errorCode: 0,
    badItems: false,
    inputTokens: 1200,
    outputTokens: 120,
  };
  readonly api = {
    calls: [] as ClaudeEmail[][],
    requests: [] as GenerateRequest[],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    configured: true,
    errorReason: '',
    errorCode: 0,
    badItems: false,
    inputTokens: 1200,
    outputTokens: 120,
    costAvailable: true,
  };
  /** Requests that were neither Google nor Model Router. */
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
    this.claude.calls.length = 0;
    this.claude.systems.length = 0;
    this.claude.cacheWriteTokens = 0;
    this.claude.cacheReadTokens = 0;
    this.claude.configured = true;
    this.claude.errorReason = '';
    this.claude.errorCode = 0;
    this.claude.retryAfterSeconds = 0;
    this.claude.poison = '';
    this.claude.spendLimit = false;
    this.claude.badItems = false;
    this.claude.costAvailable = true;
    this.codex.calls.length = 0;
    this.codex.requests.length = 0;
    this.codex.bucket = 'P2';
    this.codex.configured = true;
    this.codex.errorReason = '';
    this.codex.errorCode = 0;

    this.codex.badItems = false;
    this.codex.inputTokens = 1200;
    this.codex.outputTokens = 120;
    this.api.calls.length = 0;
    this.api.requests.length = 0;
    this.api.bucket = 'P2';
    this.api.configured = true;
    this.api.errorReason = '';
    this.api.errorCode = 0;
    this.api.badItems = false;
    this.api.costAvailable = true;
    this.strays.length = 0;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    if (url.pathname === '/api/model/v1/models') {
      return Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'anthropic', kind: 'text', efforts: ['low', 'medium', 'high'], configured: this.claude.configured },
        { id: 'gpt-6.1-sol', displayName: 'Sol 6.1', provider: 'codex', kind: 'text', efforts: ['low', 'medium', 'high'], configured: this.codex.configured },
        { id: 'openai/gpt-6.1-sol', displayName: 'Sol 6.1', provider: 'openai', kind: 'text', efforts: ['low', 'medium', 'high'], configured: this.api.configured },
        { id: 'openai/gpt-6-astra', displayName: 'GPT-6 Astra', provider: 'openai', kind: 'text', efforts: ['low', 'medium', 'high'], configured: false },
        { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', provider: 'google', kind: 'text', efforts: ['low', 'medium', 'high'], configured: this.api.configured },
      ] })));
    }
    if (request.method === 'POST' && url.pathname === '/api/model/v1/generations:generate') {
      const input = fromWire(GenerateRequestSchema, JSON.parse(body)).message;
      const emails = (JSON.parse(input.input) as { emails: ClaudeEmail[] }).emails;
      const isClaude = input.model === 'claude-opus-5-5';
      const isApi = input.model.startsWith('openai/') || input.model.startsWith('gemini-');
      const engine = isClaude ? this.claude : isApi ? this.api : this.codex;
      if (engine.configured) engine.calls.push(emails);
      if (isClaude) this.claude.systems.push(input.instructions);
      else if (isApi) this.api.requests.push(input);
      else this.codex.requests.push(input);
      const reason = !engine.configured ? 'MODEL_NOT_CONFIGURED' : isClaude && this.claude.spendLimit ? 'MODEL_SPEND_LIMIT' : engine.errorReason;
      const code = !engine.configured ? 9 : isClaude && this.claude.spendLimit ? 8 : engine.errorCode;
      const poisoned = isClaude && this.claude.poison !== '' && emails.some(email => email.id === this.claude.poison);
      const items = engine.badItems || poisoned ? [] : emails.map(email => ({ id: email.id, bucket: engine.bucket, reason: 'Synthetic reading priority.' }));
      const cacheWrite = isClaude ? this.claude.cacheWriteTokens : 0;
      const cacheRead = isClaude ? this.claude.cacheReadTokens : 0;
      const inputTokens = engine.inputTokens + cacheWrite + cacheRead;
      const cost = Math.ceil(engine.inputTokens * 4 + cacheWrite * 5 + cacheRead * 0.2 + engine.outputTokens * 20);
      return Response.json(toWire(GenerationSchema, create(GenerationSchema, {
        name: `requests/${crypto.randomUUID()}`, model: input.model, output: reason ? '' : JSON.stringify({ items }),
        ...(reason ? { error: { code, reason, message: 'Synthetic model failure.', retryAfterSeconds: isClaude ? this.claude.retryAfterSeconds : 0 } } : {}),
        usage: { available: !reason, billingKind: isClaude || isApi ? 'api' : 'subscription', inputTokens: reason ? 0 : inputTokens, outputTokens: reason ? 0 : engine.outputTokens,
          cacheWriteTokens: cacheWrite, cachedInputTokens: cacheRead,
          ...((isClaude ? this.claude.costAvailable : isApi && this.api.costAvailable) ? { estimatedCostMicrousd: cost } : {}) },
      })));
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
