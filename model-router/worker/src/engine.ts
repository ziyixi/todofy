/** Stateful model work runs in a DO, outside the ordinary Worker's 10 ms CPU budget. */
import { DurableObject } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { RpcStatusError, HttpResponseError } from '@ziyixi/proto/http-client';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import {
  ModelService,
  ConsoleService,
  GenerationSchema,
  GenerationConfigSchema,
  ModelErrorSchema,
  ConversationSchema,
  EmbeddingSchema,
  UsageSchema,
  ListModelsResponseSchema,
  type GenerateRequest,
  type Generation,
  type CreateConversationRequest,
  type EmbedRequest,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { Store, DAY, CONTENT_DAYS, timestamp, type ConversationRow } from './store.ts';
import { validateConfig, validateOutput, budget, MAX_INPUT_BYTES } from './schema.ts';
import { modelCatalog, routeFor } from './catalog.ts';
import { executorClient } from './executor.ts';
import { generateClaude } from './providers/claude.ts';
import { generateGemini } from './providers/gemini.ts';
import { embedWorkersAI } from './providers/workers-ai.ts';
import { Code, RpcError, invalid, precondition, resourceId, requestId } from './errors.ts';
import type { Env, ProviderResult } from './types.ts';

interface ApiContext {
  engine: RouterEngine;
  app: string;
  owner: boolean;
}
const knownApps = new Set(['console', 'mailsort', 'todofy', 'brief', 'newsletter']);
const modelApi = new HttpTranscoder(
  ModelService,
  {
    listModels: async (_req, ctx: ApiContext) =>
      create(ListModelsResponseSchema, {
        models: await modelCatalog(ctx.engine.environment),
      }),
    generate: (req, ctx) => ctx.engine.generate(req, ctx.app),
    embed: (req, ctx) => ctx.engine.embed(req, ctx.app),
    createConversation: (req, ctx) => ctx.engine.createConversation(req, ctx.app),
    getConversation: (req, ctx) => ctx.engine.getConversation(req.name, ctx.app),
    closeConversation: (req, ctx) => ctx.engine.closeConversation(req.name, req.requestId, ctx.app),
  },
  { domain: 'modelrouter.inference.v1', maxBodyBytes: 3 * 1024 * 1024, authorize: () => {} },
);
const consoleApi = new HttpTranscoder(
  ConsoleService,
  {
    listRequests: (req, ctx: ApiContext) => ctx.engine.store.list(req),
    getRequest: (req, ctx) => ctx.engine.store.detail(resourceId(req.name, 'requests')),
    getUsage: (req, ctx) => ctx.engine.store.usage(req),
  },
  {
    domain: 'modelrouter.inference.v1',
    maxBodyBytes: 16384,
    authorize: (_req, _route, ctx) => {
      if (!ctx.owner) throw new RpcError(Code.PERMISSION_DENIED, 'OWNER_REQUIRED', 'The console is owner-only.');
    },
  },
);

export class RouterEngine extends DurableObject<Env> {
  readonly store: Store;
  readonly environment: Env;
  private readonly inflight = new Map<string, { hash: string; done: Promise<Generation> }>();
  private readonly turns = new Map<string, { controller: AbortController; done: Promise<Generation> }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.environment = env;
    this.store = new Store(env);
  }
  override async fetch(request: Request): Promise<Response> {
    const app = request.headers.get('x-router-app') ?? '';
    if (!knownApps.has(app)) return new Response(null, { status: 403 });
    const context = { engine: this, app, owner: request.headers.get('x-router-owner') === 'true' };
    const result =
      (await modelApi.handle(request, context, crypto.randomUUID())) ??
      (await consoleApi.handle(request, context, crypto.randomUUID()));
    return result?.response ?? new Response(null, { status: 404 });
  }
  private async hash(value: unknown): Promise<string> {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async generate(req: GenerateRequest, app: string): Promise<Generation> {
    const id = requestId(req.requestId);
    if (!!req.config === !!req.conversation)
      invalid('INVALID_MODEL_REQUEST', 'Supply one configuration or conversation.');
    if (!req.input || new TextEncoder().encode(req.input).length > MAX_INPUT_BYTES)
      invalid('INVALID_INPUT', 'Input is empty or exceeds 2 MiB.');
    if (
      Object.keys(req.metadata).length > 16 ||
      Object.entries(req.metadata).some(([key, value]) => key.length > 64 || value.length > 128)
    )
      invalid('INVALID_METADATA', 'Use at most 16 short correlation tags.');
    const hash = await this.hash({ app, req });
    const live = this.inflight.get(id);
    if (live) {
      if (live.hash !== hash)
        throw new RpcError(Code.ALREADY_EXISTS, 'REQUEST_ID_CONFLICT', 'This request ID has already been used.');
      return live.done;
    }
    const done = this.accept(req, app, hash);
    this.inflight.set(id, { hash, done });
    try {
      return await done;
    } finally {
      this.inflight.delete(id);
    }
  }
  private async accept(req: GenerateRequest, app: string, hash: string): Promise<Generation> {
    const id = req.requestId;
    const row = await this.store.request(id);
    if (row) {
      if (row.app !== app || row.input_hash !== hash)
        throw new RpcError(Code.ALREADY_EXISTS, 'REQUEST_ID_CONFLICT', 'This request ID has already been used.');
      if (row.state === 'running')
        precondition(
          'MODEL_RESULT_UNKNOWN',
          'The previous execution was interrupted. Inspect its request record before sending a new request.',
        );
      const saved = await this.store.read(row, true);
      if (saved.contentUnavailable)
        precondition(
          'MODEL_CONTENT_UNAVAILABLE',
          'This execution is recorded, but its result content is no longer retained.',
        );
      return saved;
    }
    if (req.conversation && this.turns.has(req.conversation))
      precondition('CONVERSATION_BUSY', 'This conversation already has a running turn.');
    const controller = new AbortController();
    const operation = this.run(req, app, hash, controller);
    if (req.conversation) this.turns.set(req.conversation, { controller, done: operation });
    try {
      return await operation;
    } finally {
      if (this.turns.get(req.conversation)?.done === operation) this.turns.delete(req.conversation);
    }
  }
  private async run(
    req: GenerateRequest,
    app: string,
    hash: string,
    controller: AbortController,
  ): Promise<Generation> {
    let config = req.config;
    let context: ConversationRow | null = null;
    if (req.conversation) {
      context = await this.ownedConversation(req.conversation, app);
      if (context.state !== 'open' || context.expire_ms <= Date.now())
        precondition('CONVERSATION_CLOSED', 'Create a new conversation.');
      const body = await this.env.REQUEST_BODIES.get(context.config_key);
      if (!body) precondition('CONVERSATION_LOST', 'Conversation configuration is no longer available.');
      config = fromWire(GenerationConfigSchema, await body.json()).message;
    }
    if (!config) invalid('INVALID_MODEL_REQUEST', 'A generation configuration is required.');
    config = { ...config, model: routeFor(config.model).name };
    validateConfig(config);
    const route = routeFor(config.model);
    const started = Date.now();
    const duration = Math.min(budget(req.timeoutMs), context ? context.expire_ms - started : 840000);
    const timer = setTimeout(() => controller.abort(), duration);
    let value = create(GenerationSchema, {
      name: `requests/${req.requestId}`,
      app,
      model: config.model,
      state: 'running',
      conversation: req.conversation,
      startedAt: timestamp(started),
      contentExpireTime: timestamp(started + CONTENT_DAYS * DAY),
      metadata: req.metadata,
      parameters: config.parameters,
      usage: { billingKind: route.provider === 'codex' ? 'subscription' : 'api' },
    });
    try {
      await this.store.start(value, hash, config, req.input);
    } catch {
      clearTimeout(timer);
      throw new RpcError(Code.UNAVAILABLE, 'MODEL_STORAGE_UNAVAILABLE', 'The request could not be registered.');
    }
    try {
      let result: ProviderResult;
      let nextHistory: { key: string; turns: { role: 'user' | 'assistant'; content: string }[] } | undefined;
      if (route.provider === 'codex') {
        const answer = await executorClient(this.env, app, controller.signal).generate({
          ...req,
          timeoutMs: duration,
          ...(context ? { config: undefined } : { config }),
        });
        result = {
          output: answer.output,
          reportedModel: answer.reportedModel,
          usage: answer.usage ?? create(UsageSchema, { billingKind: 'subscription' }),
          observations: answer.observations ?? { searched: false, openedUrls: [] },
          parameters: answer.parameters ??
            create(GenerationConfigSchema).parameters ?? { effort: '', allowFallback: false },
          ...(answer.error ? { error: { ...answer.error, details: [] } } : {}),
          upstreamStarted: answer.upstreamStarted,
          attemptCount: answer.attemptCount,
          finishReason: answer.finishReason,
        };
      } else {
        const history = context ? await this.env.REQUEST_BODIES.get(context.history_key) : null;
        const turns = history ? await history.json<{ role: 'user' | 'assistant'; content: string }[]>() : [];
        const provider = route.provider === 'anthropic' ? generateClaude : generateGemini;
        result = await provider(config, req.input, {
          env: this.env,
          caller: app,
          requestId: req.requestId,
          route,
          signal: controller.signal,
          deadlineMs: started + duration,
          fetcher: (input, init) => fetch(input, init),
          history: turns,
        });
        if (context)
          nextHistory = {
            key: context.history_key,
            turns: [...turns, { role: 'user', content: req.input }, { role: 'assistant', content: result.output }],
          };
      }
      value = {
        ...value,
        output: result.output,
        reportedModel: result.reportedModel,
        usage: create(UsageSchema, result.usage),
        observations: { $typeName: 'modelrouter.inference.v1.Observations', ...result.observations },
        parameters: { $typeName: 'modelrouter.inference.v1.Parameters', ...result.parameters },
        upstreamStarted: result.upstreamStarted ?? !result.error,
        attemptCount: result.attemptCount ?? 1,
        finishReason: result.finishReason || (result.error ? 'interrupted' : 'complete'),
        contributingModels: result.contributingModels ?? [],
      };
      if (result.error)
        value.error = create(ModelErrorSchema, {
          ...result.error,
          reason: 'reason' in result.error ? String(result.error.reason) : 'MODEL_UNAVAILABLE',
        });
      else if (!validateOutput(config, value.output))
        value.error = create(ModelErrorSchema, {
          code: Code.INTERNAL,
          reason: 'MODEL_INVALID_ANSWER',
          message: 'The model did not return the requested output format.',
        });
      if (!value.error && nextHistory && !controller.signal.aborted)
        await this.env.REQUEST_BODIES.put(nextHistory.key, JSON.stringify(nextHistory.turns));
    } catch (error) {
      const code = controller.signal.aborted
        ? Code.DEADLINE_EXCEEDED
        : error instanceof RpcError
          ? error.code
          : error instanceof RpcStatusError
            ? Code[error.status.status ?? 'UNAVAILABLE']
            : error instanceof HttpResponseError
              ? Code.UNAVAILABLE
              : Code.INTERNAL;
      value.error = create(ModelErrorSchema, {
        code,
        reason: controller.signal.aborted
          ? 'MODEL_TIMEOUT'
          : error instanceof RpcError
            ? error.reason
            : error instanceof RpcStatusError || error instanceof HttpResponseError
              ? code === Code.UNAUTHENTICATED || code === Code.PERMISSION_DENIED
                ? 'MODEL_AUTH'
                : code === Code.RESOURCE_EXHAUSTED
                  ? 'MODEL_QUOTA'
                  : 'MODEL_UNAVAILABLE'
              : 'MODEL_INTERNAL',
        message: controller.signal.aborted
          ? 'The model exceeded its time budget.'
          : 'The model execution did not complete.',
      });
    } finally {
      clearTimeout(timer);
    }
    value.state = value.error ? (value.error.code === Code.CANCELLED ? 'cancelled' : 'failed') : 'succeeded';
    if (value.error) value.output = '';
    value.completedAt = timestamp(Date.now());
    value.durationMs = Date.now() - started;
    return this.store.finish(value, config, req.input);
  }
  private async ownedConversation(name: string, app: string): Promise<ConversationRow> {
    const row = await this.store.conversation(resourceId(name, 'conversations'));
    if (!row || row.app !== app)
      throw new RpcError(Code.NOT_FOUND, 'CONVERSATION_NOT_FOUND', 'Conversation is unavailable.');
    return row;
  }
  private async view(row: ConversationRow) {
    const object = row.config_key ? await this.env.REQUEST_BODIES.get(row.config_key) : null;
    return create(ConversationSchema, {
      name: `conversations/${row.id}`,
      ...(object ? { config: fromWire(GenerationConfigSchema, await object.json()).message } : {}),
      timeoutMs: Math.min(840000, Math.max(0, row.expire_ms - row.created_ms)),
      state: row.state,
      expireTime: timestamp(row.expire_ms),
      app: row.app,
    });
  }
  async createConversation(req: CreateConversationRequest, app: string) {
    const id = resourceId(req.conversation?.name || `conversations/${requestId(req.requestId)}`, 'conversations');
    const config = req.conversation?.config;
    if (!config) invalid('INVALID_MODEL_REQUEST', 'Conversation configuration is required.');
    validateConfig(config);
    const existing = await this.store.conversation(id);
    if (existing) {
      if (existing.app !== app || existing.state !== 'open')
        precondition('CONVERSATION_CLOSED', 'This conversation ID cannot be reopened.');
      const previous = await this.view(existing);
      if (
        !previous.config ||
        JSON.stringify(toWire(GenerationConfigSchema, previous.config)) !==
          JSON.stringify(toWire(GenerationConfigSchema, config)) ||
        previous.timeoutMs !== budget(req.conversation?.timeoutMs || 840000)
      ) {
        throw new RpcError(
          Code.ALREADY_EXISTS,
          'CONVERSATION_ID_CONFLICT',
          'This conversation ID already has a different configuration.',
        );
      }
      return previous;
    }
    const route = routeFor(config.model);
    const now = Date.now();
    const timeout = budget(req.conversation?.timeoutMs || 840000);
    const row: ConversationRow = {
      id,
      app,
      model: route.name,
      provider: route.provider,
      state: 'creating',
      config_key: `conversations/${id}/config.json`,
      history_key: `conversations/${id}/history.json`,
      expire_ms: now + timeout,
      created_ms: now,
    };
    await this.env.DB.prepare(
      'INSERT INTO conversations (id,app,model,provider,state,config_key,history_key,expire_ms,created_ms) VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        ...[
          row.id,
          row.app,
          row.model,
          row.provider,
          row.state,
          row.config_key,
          row.history_key,
          row.expire_ms,
          row.created_ms,
        ],
      )
      .run();
    await this.env.REQUEST_BODIES.put(row.config_key, JSON.stringify(toWire(GenerationConfigSchema, config)));
    if (route.provider === 'codex')
      await executorClient(this.env, app).createConversation({
        ...req,
        conversation: create(ConversationSchema, { name: `conversations/${id}`, config, timeoutMs: timeout }),
      });
    const changed = await this.env.DB.prepare(
      "UPDATE conversations SET state = 'open' WHERE id = ? AND state = 'creating'",
    )
      .bind(id)
      .run();
    if (!changed.meta.changes) precondition('CONVERSATION_CLOSED', 'Conversation was closed during creation.');
    row.state = 'open';
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > row.expire_ms) await this.ctx.storage.setAlarm(row.expire_ms);
    return this.view(row);
  }
  async getConversation(name: string, app: string) {
    let row = await this.ownedConversation(name, app);
    if (row.provider === 'codex' && ['open', 'creating', 'closing'].includes(row.state)) {
      const remote = await executorClient(this.env, app).getConversation({ name });
      if (remote.state !== 'open') {
        await this.env.DB.prepare('UPDATE conversations SET state = ? WHERE id = ?').bind(remote.state, row.id).run();
        row = { ...row, state: remote.state };
      }
    } else if (row.state === 'open' && row.expire_ms <= Date.now()) {
      await this.closeConversation(name, crypto.randomUUID(), app);
      row = { ...row, state: 'expired' };
    }
    return this.view(row);
  }
  async closeConversation(name: string, operation: string, app: string) {
    requestId(operation);
    const id = resourceId(name, 'conversations');
    let row = await this.store.conversation(id);
    if (row && row.app !== app)
      throw new RpcError(Code.NOT_FOUND, 'CONVERSATION_NOT_FOUND', 'Conversation is unavailable.');
    if (!row) {
      const now = Date.now();
      await this.env.DB.prepare(
        "INSERT INTO conversations (id,app,model,provider,state,config_key,history_key,expire_ms,created_ms) VALUES (?,?,'','','closed','','',?,?)",
      )
        .bind(id, app, now, now)
        .run();
      row = (await this.store.conversation(id))!;
    }
    if (['closed', 'expired', 'lost'].includes(row.state)) return this.view(row);
    await this.env.DB.prepare("UPDATE conversations SET state = 'closing' WHERE id = ?").bind(id).run();
    const turn = this.turns.get(name);
    turn?.controller.abort();
    if (row.provider === 'codex') {
      const answer = await executorClient(this.env, app).closeConversation({ name, requestId: operation });
      if (!['closed', 'expired', 'lost'].includes(answer.state))
        precondition('CONVERSATION_CLEANUP_PENDING', 'Execution cleanup is not yet confirmed.');
    }
    if (turn) await turn.done.catch(() => undefined);
    await this.env.DB.prepare("UPDATE conversations SET state = 'closed' WHERE id = ?").bind(id).run();
    return this.view({ ...row, state: 'closed' });
  }
  async embed(req: EmbedRequest, app: string) {
    requestId(req.requestId);
    const route = routeFor(req.model);
    if (
      !route.embeddings ||
      req.inputs.length < 1 ||
      req.inputs.length > 50 ||
      req.inputs.some((text) => !text || new TextEncoder().encode(text).length > 32768)
    )
      invalid('INVALID_EMBEDDING_REQUEST', 'Supply between 1 and 50 texts, each at most 32 KiB.');
    const hash = await this.hash({ app, embed: req });
    const live = this.inflight.get(req.requestId);
    if (live && live.hash !== hash)
      throw new RpcError(Code.ALREADY_EXISTS, 'REQUEST_ID_CONFLICT', 'This request ID has already been used.');
    const run = async (): Promise<Generation> => {
      const saved = await this.store.request(req.requestId);
      if (saved) {
        if (saved.app !== app || saved.input_hash !== hash)
          throw new RpcError(Code.ALREADY_EXISTS, 'REQUEST_ID_CONFLICT', 'This request ID has already been used.');
        if (saved.state === 'running')
          precondition('MODEL_RESULT_UNKNOWN', 'The earlier execution has no final receipt.');
        return this.store.read(saved, true);
      }
      const started = Date.now();
      const config = create(GenerationConfigSchema, { model: route.name });
      const input = JSON.stringify(req.inputs);
      let trace = create(GenerationSchema, {
        name: `requests/${req.requestId}`,
        app,
        model: route.name,
        state: 'running',
        startedAt: timestamp(started),
        contentExpireTime: timestamp(started + CONTENT_DAYS * DAY),
        metadata: req.metadata,
        usage: { billingKind: 'platform_quota' },
      });
      await this.store.start(trace, hash, config, input);
      const result = await embedWorkersAI(req.inputs, {
        env: this.env,
        caller: app,
        requestId: req.requestId,
        route,
        signal: AbortSignal.timeout(60000),
        deadlineMs: started + 60000,
        fetcher: (input, init) => fetch(input, init),
      });
      trace = {
        ...trace,
        output: result.error ? '' : JSON.stringify(result.vectors),
        usage: create(UsageSchema, result.usage),
        state: result.error ? 'failed' : 'succeeded',
        completedAt: timestamp(Date.now()),
        durationMs: Date.now() - started,
        attemptCount: 1,
        upstreamStarted: !result.error,
        finishReason: result.error ? 'interrupted' : 'complete',
        ...(result.error ? { error: create(ModelErrorSchema, result.error) } : {}),
      };
      return this.store.finish(trace, config, input);
    };
    const operation = live?.done ?? run();
    if (!live) this.inflight.set(req.requestId, { hash, done: operation });
    try {
      const value = await operation;
      return create(EmbeddingSchema, {
        name: value.name,
        model: value.model,
        dimensions: route.dimensions,
        vectors: value.output ? (JSON.parse(value.output) as number[][]).map((values) => ({ values })) : [],
        usage: value.usage,
        ...(value.error ? { error: value.error } : {}),
      });
    } finally {
      if (!live) this.inflight.delete(req.requestId);
    }
  }
  override async alarm(): Promise<void> {
    const rows = await this.env.DB.prepare(
      "SELECT * FROM conversations WHERE state IN ('open','creating','closing') AND expire_ms <= ? LIMIT 50",
    )
      .bind(Date.now())
      .all<ConversationRow>();
    for (const row of rows.results)
      await this.closeConversation(`conversations/${row.id}`, crypto.randomUUID(), row.app);
    const next = await this.env.DB.prepare(
      "SELECT min(expire_ms) AS next FROM conversations WHERE state IN ('open','creating','closing')",
    ).first<{ next: number | null }>();
    if (next?.next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next.next));
  }
}
