/**
 * Todofy's owner API, TodofyUiService (proto/todofy/ui/v1), served by the shared transcoder
 * (proto/ts/http-transcoder.ts). owner.ts authenticates the owner with Access first; the transcoder's
 * `authorize` hook adds, for every method but GET, the CSRF check and MAINTENANCE_MODE before the body is read.
 *
 * The work runs in todofy-core: each rpc but GetIntegration is one call of TodofyCore.owner_ui (the coordinator's
 * RPC method) with the rpc's name and the decoded request in wire JSON, and the answer is read leniently with the
 * generated code and written again by the transcoder. The gateway adds only what is transport: AIP-158 page
 * tokens (proto/ts/page-token.ts, bound to the list's other parameters; TodofyCore sees and returns the cursor
 * inside), a made-up request_id for a mutation sent without one (so it is not deduplicated), Retry-After, and the
 * mapping of each reason to its google.rpc.Code and the owner's copy. A failed core call (the object down, a
 * deploy in progress) is UNAVAILABLE; TodofyCore answers its own bugs (a Python exception, an answer its codec
 * refuses) as the reason INTERNAL, and an answer the generated code here cannot read is INTERNAL too.
 * GetIntegration is composed here from the gateway's own facts and TodofyCore's setup().
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import { HttpTranscoder, type RouteInfo, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type DescMethod, type JsonObject, type JsonValue, type Message } from '@ziyixi/proto/protobuf';
import { Code, errorDetail, RpcError, type ErrorDetail } from '@ziyixi/proto/rpc-status';
import type { ErrorReason } from '@ziyixi/proto/todofy/ui/v1/errors_pb';
import { MailEventSchema } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb';
import { ConfiguredSecretsSchema, IntegrationSchema } from '@ziyixi/proto/todofy/ui/v1/status_pb';
import { TodofyUiService } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { coordinator, type CoreSetup, type UiAnswer, type UiRefusal } from './coordinator.ts';
import { csv, flag, variable, type Env } from './env.ts';

/** ErrorInfo.domain: the API's name (TodofyUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 'todofy.ziyixi.science';
/** Request bodies (a reconcile or a recompute) are a few hundred bytes; the core read at most 16 KiB before. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Seconds a write waits in maintenance (the UI shows MAINTENANCE until then). */
export const MAINTENANCE_RETRY_AFTER_S = '300';

/** An ErrorInfo reason Todofy answers: its own (todofy.ui.v1.ErrorReason) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

/**
 * Each reason's code (errors.proto lists the same), its developer message and its user-facing copy (the
 * LocalizedMessage, from worker/todofy/core/api_errors.py where the reason was a code before). Exhaustive: a new
 * ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求参数无效' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到该资源' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'a dependency is unavailable; repeat the request', zh: '依赖服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务内部错误' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the event changed since its etag', zh: '事件已被更新，请刷新后重试' },
  ACTION_NOT_ALLOWED: { code: Code.FAILED_PRECONDITION, message: 'the event does not allow this action now', zh: '该事件当前状态不允许此操作' },
  RATE_LIMITED: { code: Code.RESOURCE_EXHAUSTED, message: "the hour's report computations are used up", zh: '请求过于频繁，请稍后再试' },
  MAINTENANCE: { code: Code.UNAVAILABLE, message: 'maintenance mode: writes wait', zh: '服务维护中，请稍后再试' },
};

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

export function uiError(reason: Reason, details: readonly ErrorDetail[] = [], headers: Readonly<Record<string, string>> = {}): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details, headers });
}

/** What every handler gets: the bindings and the canonical owner Access let in. */
export interface UiContext {
  readonly env: Env;
  readonly url: URL;
  readonly owner: string;
}

const PAGE_FIELDS = new Set(['page_size', 'page_token']);

/** A list's parameters a page token is bound to: every field of the request but page_size and page_token. */
function pageParameters(wire: JsonObject): PageParameters {
  const parameters: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(wire)) {
    if (!PAGE_FIELDS.has(name) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) parameters[name] = value;
  }
  return parameters;
}

/** A reason TodofyCore answered, with its MailEvent detail and Retry-After. */
function coreRefusal(answer: UiRefusal): RpcError {
  const reason: Reason = isReason(answer.error) ? answer.error : 'INTERNAL';
  const details = answer.detail === null ? [] : [errorDetail(MailEventSchema, fromWire(MailEventSchema, JSON.parse(answer.detail)).message)];
  const headers: Record<string, string> = answer.retry_after === null ? {} : { 'retry-after': String(answer.retry_after) };
  return uiError(reason, details, headers);
}

/** The handler of an rpc TodofyCore answers: one owner_ui call, with the page token and request_id handled here. */
function forwarded(method: DescMethod): (request: Message, ctx: UiContext) => Promise<Message> {
  const paged = method.input.fields.some((field) => field.name === 'page_token');
  const idempotent = method.input.fields.some((field) => field.name === 'request_id');
  return async (request, ctx) => {
    const wire: JsonObject = { ...toWire<DescMessage>(method.input, request) };
    const parameters = paged ? pageParameters(wire) : {};
    let cursor: JsonValue | null = null;
    if (paged && typeof wire['page_token'] === 'string') {
      try {
        cursor = decodePageToken(wire['page_token'], parameters);
      } catch (error) {
        if (error instanceof PageTokenError) throw uiError('BAD_REQUEST');
        throw error;
      }
      delete wire['page_token'];
    }
    // AIP-155: without an ID nothing is deduplicated; TodofyCore keys every owner action by one.
    if (idempotent && wire['request_id'] === undefined) wire['request_id'] = crypto.randomUUID();
    let answer: UiAnswer;
    try {
      answer = await coordinator(ctx.env).owner_ui(ctx.owner, method.name, JSON.stringify(wire), cursor === null ? null : JSON.stringify(cursor));
    } catch {
      throw uiError('UNAVAILABLE');
    }
    if ('error' in answer) throw coreRefusal(answer);
    const message = fromWire(method.output, JSON.parse(answer.ok)).message as Message & { nextPageToken?: string };
    if (paged && answer.next_cursor !== null) message.nextPageToken = encodePageToken(JSON.parse(answer.next_cursor) as JsonValue, parameters);
    return message;
  };
}

/** GetIntegration: the gateway's facts and TodofyCore's (whether each secret is set, never its value). */
async function getIntegration(_request: Message, ctx: UiContext): Promise<Message> {
  const { env } = ctx;
  let core: CoreSetup;
  try {
    core = await coordinator(env).setup();
  } catch {
    throw uiError('UNAVAILABLE');
  }
  return create(IntegrationSchema, {
    name: 'integration',
    build: variable(env, 'BUILD_SHA', 'unknown'),
    publicHost: variable(env, 'TODOFY_PUBLIC_HOST').toLowerCase(),
    hooksHosts: csv(env, 'TODOFY_HOOKS_HOSTS'),
    webhookPath: '/hooks/mail',
    mailSourceId: core.mail_source_id,
    accessOwner: ctx.owner,
    configured: create(ConfiguredSecretsSchema, {
      mailWebhookToken: Boolean(variable(env, 'MAIL_WEBHOOK_TOKEN_SHA256')),
      reportBasicAuth: Boolean(variable(env, 'REPORT_BASIC_AUTH_SHA256')),
      geminiApiKey: core.configured['gemini_api_key'] === true,
      todoistApiKey: core.configured['todoist_api_key'] === true,
      todoistProject: core.configured['todoist_project'] === true,
    }),
  });
}

type Handlers = ServiceHandlers<ShapeOf<typeof TodofyUiService>, UiContext>;

const handlers = Object.fromEntries(
  TodofyUiService.methods.map((method) => [method.localName, method.name === 'GetIntegration' ? getIntegration : forwarded(method)]),
) as unknown as Handlers;

/**
 * The transcoder, built at global scope so that reading the descriptors' options happens at startup, outside any
 * request's CPU time. `authorize` is owner.ts's CSRF and maintenance check.
 */
export function transcoder(authorize: (request: Request, route: RouteInfo, ctx: UiContext) => Promise<void>): HttpTranscoder<ShapeOf<typeof TodofyUiService>, UiContext> {
  return new HttpTranscoder(TodofyUiService, handlers, {
    domain: API_DOMAIN,
    maxBodyBytes: MAX_BODY_BYTES,
    authorize,
    localize: (reason) => (isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined),
    // A bug (the handlers wrap their TodofyCore calls as UNAVAILABLE themselves): never answered as retryable.
    onUnexpected: () => uiError('INTERNAL'),
  });
}

/** MAINTENANCE_MODE refuses every write, with a Retry-After (TodofyCore refuses them too). */
export function maintenance(env: Env): RpcError | null {
  return flag(env, 'MAINTENANCE_MODE') ? uiError('MAINTENANCE', [], { 'retry-after': MAINTENANCE_RETRY_AFTER_S }) : null;
}

