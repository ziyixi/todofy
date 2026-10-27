/**
 * The one fake behind every outbound request of the Worker in the workerd tests and the local smoke run: Google (the
 * fake Gmail and token endpoint) and Workers AI (`POST /ai/run/<model>`, the shape of env.ts aiRunner's development
 * runner). The Worker's development fetch (env.ts upstreamFetch) sends each Google request to this loopback origin with
 * the real Google URL in `x-mailsort-original-url`; anything else is a 502 and is recorded as a stray request.
 */
import type { ClassificationEmail as ClaudeEmail } from '../../src/classification-result.ts';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { GenerateRequestSchema, GenerationSchema, ListModelsResponseSchema, type GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { FakeAi } from './fake-ai.ts';
import { FakeGmail, type RecordedLedger } from './fake-gmail.ts';

export const ORIGINAL_URL_HEADER = 'x-mailsort-original-url';
export const MODEL_ENDPOINT = 'https://model-router.internal/api/model/v1/generations:generate';

export class FakeUpstream {
  readonly gmail = new FakeGmail();
  readonly ai = new FakeAi();
  readonly claude = {
    calls: [] as ClaudeEmail[][],
    systems: [] as { text: string; cache: boolean }[][],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    configured: true,
    errorReason: '',
    errorCode: 0,
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
    requests: [] as GenerateRequest[],
    bucket: 'P2' as 'P1' | 'P2' | 'P3' | 'P4',
    configured: true,
    errorReason: '',
    errorCode: 0,
    badItems: false,
    inputTokens: 1200,
    outputTokens: 120,
    usageAvailable: true,
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
    this.claude.configured = true;
    this.claude.errorReason = '';
    this.claude.errorCode = 0;
    this.claude.spendLimit = false;
    this.claude.badItems = false;
    this.codex.calls.length = 0;
    this.codex.requests.length = 0;
    this.codex.bucket = 'P2';
    this.codex.configured = true;
    this.codex.errorReason = '';
    this.codex.errorCode = 0;

    this.codex.badItems = false;
    this.codex.inputTokens = 1200;
    this.codex.outputTokens = 120;
    this.codex.usageAvailable = true;
    this.strays.length = 0;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    if (url.pathname === '/api/model/v1/models') {
      return Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [
        { name: 'models/claude-opus-5-5', configured: this.claude.configured }, { name: 'models/sol-6-1', configured: this.codex.configured },
      ] })));
    }
    if (request.method === 'POST' && url.pathname === '/api/model/v1/generations:generate') {
      const input = fromWire(GenerateRequestSchema, JSON.parse(body)).message;
      const emails = (JSON.parse(input.input) as { emails: ClaudeEmail[] }).emails;
      const isClaude = input.config?.model === 'models/claude-opus-5-5';
      const engine = isClaude ? this.claude : this.codex;
      if (engine.configured) engine.calls.push(emails);
      if (isClaude) this.claude.systems.push(input.config?.instructions ?? []);
      else this.codex.requests.push(input);
      const reason = !engine.configured ? 'MODEL_NOT_CONFIGURED' : isClaude && this.claude.spendLimit ? 'MODEL_SPEND_LIMIT' : engine.errorReason;
      const code = !engine.configured ? 9 : isClaude && this.claude.spendLimit ? 8 : engine.errorCode;
      const items = engine.badItems ? [] : emails.map(email => ({ id: email.id, bucket: engine.bucket, reason: 'Synthetic reading priority.' }));
      const cacheWrite = isClaude ? this.claude.cacheWriteTokens : 0;
      const cacheRead = isClaude ? this.claude.cacheReadTokens : 0;
      const inputTokens = engine.inputTokens + cacheWrite + cacheRead;
      const cost = Math.ceil(engine.inputTokens * 4 + cacheWrite * 5 + cacheRead * 0.2 + engine.outputTokens * 20);
      return Response.json(toWire(GenerationSchema, create(GenerationSchema, {
        name: `requests/${input.requestId}`, model: input.config?.model ?? '', reportedModel: isClaude ? 'claude-opus-5-5' : 'gpt-6.1-sol',
        state: reason ? 'failed' : 'succeeded', output: reason ? '' : JSON.stringify({ items }), parameters: input.config?.parameters,
        upstreamStarted: !reason, attemptCount: engine.configured ? 1 : 0, finishReason: reason ? '' : 'complete',
        ...(reason ? { error: { code, reason, message: 'Synthetic model failure.' } } : {}),
        usage: { available: !reason && (isClaude || this.codex.usageAvailable), billingKind: isClaude ? 'api' : 'subscription', inputTokens: reason ? 0 : inputTokens, outputTokens: reason ? 0 : engine.outputTokens,
          totalTokens: reason ? 0 : inputTokens + engine.outputTokens, cacheWriteTokens: cacheWrite, cachedInputTokens: cacheRead,
          reasoningOutputTokens: isClaude ? this.claude.thinkingTokens ?? 0 : 0, ...(isClaude ? { estimatedCostMicrousd: cost } : {}) },
      })));
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
