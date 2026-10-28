/** Model work and bounded backup steps run in the DO's execution budget. */
import { DurableObject } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { EmptySchema } from '@ziyixi/proto/protobuf/wkt';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { RpcStatusError, HttpResponseError } from '@ziyixi/proto/http-client';
import {
  ModelService,
  GenerationSchema,
  GenerateRequestSchema,
  ModelErrorSchema,
  EmbeddingSchema,
  UsageSchema,
  ObservationsSchema,
  ListModelsResponseSchema,
  type GenerateRequest,
  type Generation,
  type CreateConversationRequest,
  type EmbedRequest,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { ConsoleService, RequestRecordSchema } from '@ziyixi/proto/modelrouter/inference/v1/console_pb';
import { Store, DAY, CONTENT_DAYS, timestamp } from './store.ts';
import { validateConfig, validateOutput, providerOutputSchema, callerOutput, budget, MAX_INPUT_BYTES } from './schema.ts';
import { modelCatalog, providerFor, routeFor } from './catalog.ts';
import { executorClient } from './executor.ts';
import { generateClaude } from './providers/claude.ts';
import { generateGemini } from './providers/gemini.ts';
import { embedWorkersAI } from './providers/workers-ai.ts';
import { estimateCostMicrousd } from './providers/pricing.ts';
import { timedOut } from './providers/common.ts';
import { backupStep, newBackup, type BackupCursor } from './backup.ts';
import { Code, RpcError, invalid, precondition, resourceId } from './errors.ts';
import type { Env, ProviderResult } from './types.ts';

interface ApiContext {
  engine: RouterEngine;
  app: string;
  owner: boolean;
}
interface Context {
  app: string;
  request: CreateConversationRequest;
  expireMs: number;
}
const knownApps = new Set(['console', 'mailsort', 'todofy', 'newsletter']);
/** The external Newsletter token reaches only subscription Codex models; in-account bindings stay unrestricted. */
function allowModel(app: string, provider: string): void {
  if (app === 'newsletter' && provider !== 'codex')
    throw new RpcError(Code.PERMISSION_DENIED, 'MODEL_NOT_ALLOWED', 'This caller may use only Codex models.');
}
const modelApi = new HttpTranscoder(ModelService, {
  listModels: (_req, ctx: ApiContext) =>
    Promise.resolve(create(ListModelsResponseSchema, { models: modelCatalog(ctx.engine.environment) })),
  generate: (req, ctx) => ctx.engine.generate(req, ctx.app),
  embed: (req, ctx) => ctx.engine.embed(req, ctx.app),
  createConversation: (req, ctx) => ctx.engine.createConversation(req, ctx.app),
  closeConversation: (req, ctx) => ctx.engine.closeConversation(req.name, ctx.app),
}, { domain: 'modelrouter.inference.v1', maxBodyBytes: 3 * 1024 * 1024, authorize: () => {} });
const consoleApi = new HttpTranscoder(ConsoleService, {
  listRequests: (req, ctx: ApiContext) => ctx.engine.store.list(req),
  getRequest: (req, ctx) => ctx.engine.store.detail(resourceId(req.name, 'requests')),
  getUsage: (req, ctx) => ctx.engine.store.usage(req),
}, {
  domain: 'modelrouter.inference.v1', maxBodyBytes: 16384,
  authorize: (_req, _route, ctx) => {
    if (!ctx.owner) throw new RpcError(Code.PERMISSION_DENIED, 'OWNER_REQUIRED', 'The console is owner-only.');
  },
});

export class RouterEngine extends DurableObject<Env> {
  readonly store: Store;
  readonly environment: Env;
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
  async generate(req: GenerateRequest, app: string): Promise<Generation> {
    if (!req.input || new TextEncoder().encode(req.input).length > MAX_INPUT_BYTES)
      invalid('INVALID_INPUT', 'Input is empty or exceeds 2 MiB.');
    if (
      req.conversation &&
      (req.model || req.instructions.length || req.effort || req.maxOutputTokens || req.outputSchemaJson || req.allowFallback)
    )
      invalid('INVALID_MODEL_REQUEST', 'A conversation turn supplies only its context, input and deadline.');
    if (req.conversation && this.turns.has(req.conversation))
      precondition('CONVERSATION_BUSY', 'This context already has a running turn.');
    const controller = new AbortController();
    const done = this.run(req, app, controller);
    if (req.conversation) this.turns.set(req.conversation, { controller, done });
    try {
      return await done;
    } finally {
      if (this.turns.get(req.conversation)?.done === done) this.turns.delete(req.conversation);
    }
  }
  private async run(req: GenerateRequest, app: string, controller: AbortController): Promise<Generation> {
    let effective = req;
    let context: Context | undefined;
    if (req.conversation) {
      resourceId(req.conversation, 'conversations');
      context = await this.ctx.storage.get<Context>(req.conversation);
      if (!context || context.app !== app || context.expireMs <= Date.now())
        precondition('CONVERSATION_CLOSED', 'Create a new context.');
      effective = create(GenerateRequestSchema, {
        model: context.request.model,
        instructions: context.request.instructions,
        effort: context.request.effort,
        outputSchemaJson: context.request.outputSchemaJson,
        input: req.input,
        conversation: req.conversation,
        timeoutMs: req.timeoutMs,
      });
    }
    validateConfig(effective);
    const providerRequest = { ...effective, outputSchemaJson: providerOutputSchema(effective.outputSchemaJson) };
    const route = routeFor(effective.model);
    allowModel(app, route.provider);
    const started = Date.now();
    const duration = Math.min(budget(req.timeoutMs), context ? context.expireMs - started : 840000);
    const timer = setTimeout(() => controller.abort(new DOMException('The model exceeded its time budget.', 'TimeoutError')), duration);
    let value = create(GenerationSchema, {
      name: `requests/${crypto.randomUUID()}`,
      model: route.upstreamModel,
      usage: { billingKind: route.provider === 'codex' ? 'subscription' : 'api' },
    });
    const trace = create(RequestRecordSchema, {
      generation: value,
      app,
      provider: providerFor(value.model),
      state: 'running',
      startedAt: timestamp(started),
      contentExpireTime: timestamp(started + CONTENT_DAYS * DAY),
      contentAvailable: true,
    });
    try {
      await this.store.start(trace, effective);
    } catch {
      clearTimeout(timer);
      throw new RpcError(Code.UNAVAILABLE, 'MODEL_STORAGE_UNAVAILABLE', 'The request could not be registered.');
    }
    try {
      let result: ProviderResult;
      if (route.provider === 'codex') {
        const answer = await executorClient(this.env, controller.signal).generate({
          ...(req.conversation ? req : providerRequest), timeoutMs: duration,
        });
        result = {
          output: answer.output,
          reportedModel: '',
          usage: answer.usage ?? create(UsageSchema, { billingKind: 'subscription' }),
          observations: answer.observations ?? { searched: false, openedUrls: [] },
          ...(answer.error ? { error: { ...answer.error } } : {}),
        };
        result.usage.estimatedCostMicrousd = estimateCostMicrousd(route.upstreamModel, result.usage);
      } else {
        const provider = route.provider === 'anthropic' ? generateClaude : generateGemini;
        result = await provider(providerRequest, {
          env: this.env,
          caller: app,
          route,
          signal: controller.signal,
          deadlineMs: started + duration,
          fetcher: (input, init) => fetch(input, init),
        });
      }
      value = create(GenerationSchema, {
        name: value.name,
        model: result.reportedModel || route.upstreamModel,
        output: result.error ? result.output : callerOutput(effective.outputSchemaJson, result.output),
        usage: create(UsageSchema, result.usage),
        observations: create(ObservationsSchema, result.observations),
        contributingModels: result.contributingModels ?? [],
        ...(result.error ? { error: create(ModelErrorSchema, result.error) } : {}),
      });
      trace.reportedModel = result.reportedModel;
      if (!value.error && !validateOutput(effective, value.output)) {
        value.error = create(ModelErrorSchema, {
          code: Code.INTERNAL,
          reason: 'MODEL_INVALID_ANSWER',
          message: 'The model did not return the requested output format.',
        });
      }
    } catch (error) {
      let code: Code = Code.INTERNAL;
      let reason = 'MODEL_INTERNAL';
      let message = 'The model execution did not complete.';
      if (controller.signal.aborted && timedOut(controller.signal)) {
        code = Code.DEADLINE_EXCEEDED;
        reason = 'MODEL_TIMEOUT';
        message = 'The model exceeded its time budget.';
      } else if (controller.signal.aborted) {
        code = Code.CANCELLED;
        reason = 'MODEL_CANCELLED';
        message = 'The context was closed during this turn.';
      } else if (error instanceof RpcError) {
        code = error.code;
        reason = error.reason;
      } else if (error instanceof RpcStatusError || error instanceof HttpResponseError) {
        code = error instanceof RpcStatusError ? Code[error.status.status ?? 'UNAVAILABLE'] : Code.UNAVAILABLE;
        if (error instanceof RpcStatusError && error.status.reason) reason = error.status.reason;
        else if (code === Code.UNAUTHENTICATED || code === Code.PERMISSION_DENIED) reason = 'MODEL_AUTH';
        else if (code === Code.RESOURCE_EXHAUSTED) reason = 'MODEL_QUOTA';
        else reason = 'MODEL_UNAVAILABLE';
      }
      value.error = create(ModelErrorSchema, { code, reason, message });
    } finally {
      clearTimeout(timer);
    }
    if (value.error) {
      value.output = '';
      trace.state = value.error.code === Code.CANCELLED ? 'cancelled' : 'failed';
    } else {
      trace.state = 'succeeded';
    }
    trace.generation = value;
    trace.completedAt = timestamp(Date.now());
    trace.durationMs = Date.now() - started;
    await this.store.finish(trace, effective);
    return value;
  }
  async createConversation(req: CreateConversationRequest, app: string) {
    resourceId(req.name, 'conversations');
    const route = routeFor(req.model);
    if (route.provider !== 'codex')
      invalid('MODEL_CAPABILITY_UNSUPPORTED', 'Only Codex contexts are currently used.');
    validateConfig(create(GenerateRequestSchema, {
      model: req.model,
      instructions: req.instructions,
      effort: req.effort,
      outputSchemaJson: req.outputSchemaJson,
    }));
    if (await this.ctx.storage.get(req.name))
      throw new RpcError(Code.ALREADY_EXISTS, 'CONVERSATION_EXISTS', 'Use a new context name.');
    const expireMs = Date.now() + budget(req.timeoutMs || 840000);
    await this.ctx.storage.put(req.name, { app, request: req, expireMs } satisfies Context);
    await this.wakeAt(expireMs);
    await executorClient(this.env).createConversation({ ...req, outputSchemaJson: providerOutputSchema(req.outputSchemaJson) });
    return create(EmptySchema);
  }
  async closeConversation(name: string, app: string) {
    resourceId(name, 'conversations');
    const context = await this.ctx.storage.get<Context>(name);
    if (!context) return create(EmptySchema);
    if (context.app !== app)
      throw new RpcError(Code.NOT_FOUND, 'CONVERSATION_NOT_FOUND', 'Context is unavailable.');
    const turn = this.turns.get(name);
    turn?.controller.abort();
    await executorClient(this.env).closeConversation({ name });
    if (turn) await turn.done.catch(() => undefined);
    await this.ctx.storage.delete(name);
    return create(EmptySchema);
  }
  async embed(req: EmbedRequest, app: string) {
    const route = routeFor(req.model);
    allowModel(app, route.provider);
    if (
      route.provider !== 'workers_ai' || req.inputs.length < 1 || req.inputs.length > 50 ||
      req.inputs.some((text) => !text || new TextEncoder().encode(text).length > 32768)
    )
      invalid('INVALID_EMBEDDING_REQUEST', 'Supply between 1 and 50 texts, each at most 32 KiB.');
    const started = Date.now();
    const request = create(GenerateRequestSchema, { model: req.model, input: JSON.stringify(req.inputs) });
    const name = `requests/${crypto.randomUUID()}`;
    const trace = create(RequestRecordSchema, {
      generation: { name, model: req.model, usage: { billingKind: 'platform_quota' } },
      app,
      provider: providerFor(req.model),
      state: 'running',
      startedAt: timestamp(started),
      contentExpireTime: timestamp(started + CONTENT_DAYS * DAY),
      contentAvailable: true,
    });
    await this.store.start(trace, request);
    const result = await embedWorkersAI(req.inputs, {
      env: this.env,
      caller: app,
      route,
      signal: AbortSignal.timeout(60000),
      deadlineMs: started + 60000,
      fetcher: (input, init) => fetch(input, init),
    });
    trace.generation = create(GenerationSchema, {
      name,
      model: req.model,
      output: result.error ? '' : JSON.stringify(result.vectors),
      usage: create(UsageSchema, result.usage),
      ...(result.error ? { error: create(ModelErrorSchema, result.error) } : {}),
    });
    trace.state = result.error ? 'failed' : 'succeeded';
    trace.completedAt = timestamp(Date.now());
    trace.durationMs = Date.now() - started;
    await this.store.finish(trace, request);
    return create(EmbeddingSchema, {
      name,
      model: req.model,
      vectors: result.vectors.map((values) => ({ values })),
      usage: result.usage,
      error: trace.generation.error,
    });
  }
  async backupStatus(): Promise<{ completedMs: number; startedMs: number }> {
    const last = await this.ctx.storage.get<{ time: number }>('last-backup');
    const pending = await this.ctx.storage.get<BackupCursor>('backup');
    if (!last && !pending) await this.startBackup();
    return { completedMs: last?.time ?? 0, startedMs: pending?.started_ms ?? Date.now() };
  }
  async startBackup(): Promise<void> {
    const today = newBackup(Date.now());
    const pending = await this.ctx.storage.get<BackupCursor>('backup');
    if (!pending || pending.prefix !== today.prefix) await this.ctx.storage.put('backup', today);
    await this.wakeAt(Date.now() + 1000);
  }
  private async wakeAt(time: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > time) await this.ctx.storage.setAlarm(time);
  }
  override async alarm(): Promise<void> {
    const contexts = await this.ctx.storage.list<Context>({ prefix: 'conversations/' });
    for (const [name, context] of contexts) {
      // The gateway closes its SDK context at the same deadline; only the ownership record remains here.
      if (context.expireMs <= Date.now()) await this.ctx.storage.delete(name);
      else await this.wakeAt(context.expireMs);
    }
    const cursor = await this.ctx.storage.get<BackupCursor>('backup');
    if (!cursor) return;
    const step = await backupStep(this.env, cursor);
    if (step.next) {
      await this.ctx.storage.put('backup', step.next);
      await this.wakeAt(Date.now() + 1000);
    } else {
      await this.ctx.storage.delete('backup');
      await this.ctx.storage.put('last-backup', { time: Date.now(), ...step.counts });
    }
  }
}
