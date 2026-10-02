/**
 * The owner API (proto/dashboard/ui/v1): one handler per rpc of DashboardUiService, served by the shared transcoder
 * (proto/ts/http-transcoder.ts) from src/http.ts after authentication. No business logic: every call is one RPC to
 * HomeState (or none, for the registry), and the Worker never decodes a view. HomeState builds and serializes each
 * view once; a handler answers its bytes as PreEncoded with the view's ETag, or 304 when the request's If-None-Match
 * names it (Workers Free gives this handler 10 ms of CPU). The mutations' answers are small messages the transcoder
 * writes with the wire profile.
 *
 * Errors are RpcErrors with a reason of dashboard.ui.v1.ErrorReason or common.errors.v1.CommonReason; REASONS gives
 * each its google.rpc.Code and its copy. Only a failed call to HomeState is UNAVAILABLE (`callHome`); anything else
 * a handler throws is a bug, answered INTERNAL by the transcoder.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import { OverrideGuardResponseSchema, RunCanaryResponseSchema, type DashboardUiService } from '@ziyixi/proto/dashboard/ui/v1/dashboard_ui_service_pb';
import type { ErrorReason } from '@ziyixi/proto/dashboard/ui/v1/errors_pb';
import { PreEncoded, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { GuardLevel, GuardLevelSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { DescMessage, MessageShape } from '@ziyixi/proto/protobuf';
import { fromWire, wireEnum } from '@ziyixi/proto/wire-json';
import type { ViewId } from './api-types.ts';
import { buildSha } from './config.ts';
import type { Env } from './env.ts';
import { registryBody } from './registry.ts';
import { HOME_OBJECT, type GuardOverrideOutcome, type HomeState, type StartCanaryOutcome } from './state.ts';
import { etagMatches, type ViewBody } from './view-body.ts';

/** What every handler gets: src/http.ts authenticated the owner before routing. */
export interface ApiContext {
  readonly request: Request;
  readonly env: Env;
  /**
   * The instant HomeState takes as now for this request: DEV_NOW when the loopback dev bypass signed the request in
   * (local development and the workerd tests pin the clock with it), else null, the object's own Date.now().
   */
  readonly at: number | null;
}

/** An ErrorInfo reason the dashboard answers: its own (dashboard.ui.v1.ErrorReason) or one every API shares. */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

/**
 * Each reason's code (errors.proto lists the same), its developer message and its user-facing copy (the
 * LocalizedMessage). Exhaustive: a new ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求格式不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到该资源' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '依赖服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请稍后刷新页面' },
  CANARY_ACTIVE: { code: Code.ABORTED, message: 'a canary run is in progress', zh: '已有金丝雀运行正在进行' },
  CANARY_DISABLED: { code: Code.FAILED_PRECONDITION, message: 'the canary is switched off', zh: '金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）' },
  CANARY_LIMIT: { code: Code.RESOURCE_EXHAUSTED, message: "today's manual canary runs are used", zh: '今天的手动金丝雀次数已用完' },
};

export function dashboardError(reason: Reason, headers: Readonly<Record<string, string>> = {}): RpcError {
  const { code, message } = REASONS[reason];
  // UNIMPLEMENTED is 501 in AIP-193's table; a known path with another method is 405 (as the transcoder answers it).
  return new RpcError(code, reason, message, { headers, ...(reason === 'METHOD_NOT_ALLOWED' ? { httpStatus: 405 } : {}) });
}

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** The canaries of the registry (RunCanary's `canaries/{canary}`): only the mail flow's. */
export const CANARY_NAMES: readonly string[] = ['canaries/mail-todofy'];

const GUARD_LEVELS = wireEnum(GuardLevelSchema, GuardLevel);

function home(env: Env): DurableObjectStub<HomeState> {
  return env.HOME.get(env.HOME.idFromName(HOME_OBJECT));
}

/** Any failure of the Durable Object call is UNAVAILABLE (the UI may repeat it, with the same request_id). */
async function callHome<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw dashboardError('UNAVAILABLE');
  }
}

/** A view as HomeState serialized it: its bytes and ETag, or 304 for a GET whose If-None-Match names the ETag. */
async function viewAnswer(ctx: ApiContext, view: ViewId, refresh: boolean): Promise<PreEncoded> {
  const ifNoneMatch = refresh ? null : ctx.request.headers.get('if-none-match');
  const result = await callHome(() => home(ctx.env).view(view, refresh, ifNoneMatch, ctx.at) as unknown as Promise<ViewBody>);
  return new PreEncoded(result.body, { etag: result.etag });
}

/**
 * HomeState's own answer as the method's output message, read as the UI reads it: anything the IDL refuses (a wrong
 * type, a value rule, an unknown field or enum name) is a bug, thrown as such (INTERNAL), never sent.
 */
function ownAnswer<D extends DescMessage>(schema: D, wire: unknown): MessageShape<D> {
  const read = fromWire(schema, wire);
  if (read.unrecognized.length > 0) throw new TypeError(`${schema.typeName}: HomeState wrote fields the IDL does not have`);
  return read.message;
}

/** The request_id of a mutation (the transcoder checked and lower-cased it), or null without one. */
function requestIdOf(requestId: string): string | null {
  return requestId === '' ? null : requestId;
}

export const handlers: ServiceHandlers<ShapeOf<typeof DashboardUiService>, ApiContext> = {
  getRegistry(_request, ctx) {
    // Static per build: answered by the Worker from the string it serialized once, never by HomeState.
    const build = buildSha(ctx.env);
    const etag = `"${build}"`;
    const body = etagMatches(ctx.request.headers.get('if-none-match'), etag) ? null : registryBody(build);
    return Promise.resolve(new PreEncoded(body, { etag }));
  },
  getHomeView: (_request, ctx) => viewAnswer(ctx, 'home', false),
  refreshHomeView: (_request, ctx) => viewAnswer(ctx, 'home', true),
  getFlowsView: (_request, ctx) => viewAnswer(ctx, 'flows', false),
  getCloudflareView: (_request, ctx) => viewAnswer(ctx, 'cloudflare', false),
  refreshCloudflareView: (_request, ctx) => viewAnswer(ctx, 'cloudflare', true),
  getOpsView: (_request, ctx) => viewAnswer(ctx, 'ops', false),

  async overrideGuard(request, ctx) {
    // The strict read refused a level outside the enum; non_null refused the zero value.
    const level = GUARD_LEVELS.name(request.level);
    if (level === null) throw dashboardError('BAD_REQUEST');
    const result = await callHome(
      () => home(ctx.env).setGuardOverride(level, ctx.at, requestIdOf(request.requestId)) as unknown as Promise<GuardOverrideOutcome>,
    );
    if (!result.ok) throw dashboardError('BAD_REQUEST');
    return ownAnswer(OverrideGuardResponseSchema, { guard: result.guard });
  },

  async runCanary(request, ctx) {
    if (!CANARY_NAMES.includes(request.name)) throw dashboardError('NOT_FOUND');
    const result = await callHome(() => home(ctx.env).startCanary(ctx.at, requestIdOf(request.requestId)) as unknown as Promise<StartCanaryOutcome>);
    if (result.ok) return ownAnswer(RunCanaryResponseSchema, { run: result.run });
    switch (result.code) {
      case 'canary_disabled':
        throw dashboardError('CANARY_DISABLED');
      case 'canary_active':
        throw dashboardError('CANARY_ACTIVE');
      case 'canary_limit':
        throw dashboardError('CANARY_LIMIT');
      case 'request_id_reused':
        throw dashboardError('BAD_REQUEST');
    }
  },
};
