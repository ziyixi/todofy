/** Separate, token-authenticated extension API. Owner setup retains Access and CSRF. */
import { HttpTranscoder, PreEncoded, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { FlowDayUiService, CommandTimerRequestSchema, CommandTimerRequest_Action } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { coordinator } from './coordinator.ts';
import { sha256Hex, utf8 } from './crypto.ts';
import { verifyCsrf } from './csrf.ts';
import { flag, variable, type Env } from './env.ts';
import { withPrivateHeaders, type Context } from './http.ts';
import { API_DOMAIN, isReason, uiError } from './ui.ts';

interface PlusContext { env: Env; owner: string | null }
const OWNER_METHODS = new Set(['ConfirmPlanMapping', 'IssueExtensionConnection', 'ReadExtensionConnections', 'RevokeExtensionConnection']);
const PREFIX = '/api/plus/v1/';
const FLOW_PREFIX = '/api/plus/flowday';
const DOMAIN = API_DOMAIN;

function handlers(): ServiceHandlers<ShapeOf<typeof PlusService>, PlusContext> {
  const result: Record<string, unknown> = {};
  for (const method of PlusService.methods) {
    const idempotent = method.input.fields.some(field => field.name === 'request_id');
    result[method.localName] = async (input: Parameters<typeof toWire>[1], ctx: PlusContext) => {
      if (ctx.owner === null && OWNER_METHODS.has(method.name)) throw uiError('UNAUTHORIZED');
      const wire = toWire(method.input, input);
      if (idempotent && wire['request_id'] === undefined) wire['request_id'] = crypto.randomUUID();
      if (method.name === 'CompleteTask' && wire['flow_date'] && !validDay(wire['flow_date'])) throw uiError('BAD_REQUEST');
      let answer;
      try { answer = await coordinator(ctx.env).plus_ui(method.name, JSON.stringify(wire), ctx.owner !== null); }
      catch { throw uiError('UNAVAILABLE'); }
      if ('error' in answer) throw uiError(isReason(answer.error) ? answer.error : 'INTERNAL');
      if (method.name === 'CompleteTask' && typeof wire['flow_date'] === 'string' && wire['flow_date']) {
        try { await settleCompleted(ctx.env, wire as { request_id: string; task_id: string; flow_date: string }); }
        catch (error) { throw error instanceof RpcError ? error : uiError('UNAVAILABLE'); }
      }
      if (method.name === 'ReadPlan' || method.name === 'ConfirmPlanMapping' || method.name === 'UpdatePlanLabels') {
        const output = JSON.parse(answer.ok) as { plan: Record<string, unknown> };
        output.plan['flowday_url'] = variable(ctx.env, 'FLOWDAY_PUBLIC_URL');
        return new PreEncoded(JSON.stringify(output));
      }
      return new PreEncoded(answer.ok);
    };
  }
  return result as ServiceHandlers<ShapeOf<typeof PlusService>, PlusContext>;
}

const api = new HttpTranscoder(PlusService, handlers(), {
  domain: DOMAIN,
  maxBodyBytes: 32 * 1024,
  authorize: async (request, route, ctx) => {
    if (!route.safe) {
      if (ctx.owner !== null) await verifyCsrf(request, ctx.env, ctx.owner);
      if (flag(ctx.env, 'MAINTENANCE_MODE')) throw uiError('MAINTENANCE');
    }
  },
});

export function plusPath(path: string): boolean {
  return path.startsWith(PREFIX) || path.startsWith(`${FLOW_PREFIX}/`);
}

export async function plusOwner(ctx: Context, owner: string | null): Promise<Response> {
  const result = await api.handle(ctx.request, { env: ctx.env, owner }, ctx.requestId);
  return result?.response ?? api.errorResponse(uiError('NOT_FOUND'), ctx.requestId);
}

export async function plusExtension(ctx: Context): Promise<Response> {
  try {
    // Browsers call through the extension background's host permission. We do not grant page CORS.
    const match = /^Bearer (todofy_plus_[A-Za-z0-9_-]{43})$/.exec(ctx.request.headers.get('authorization') ?? '');
    if (!match) throw uiError('UNAUTHORIZED');
    let accepted: boolean;
    try { accepted = await coordinator(ctx.env).plus_auth(await sha256Hex(utf8(match[1] ?? ''))); }
    catch { throw uiError('UNAVAILABLE'); }
    if (!accepted) throw uiError('UNAUTHORIZED');
    let response: Response;
    if (ctx.url.pathname.startsWith(`${FLOW_PREFIX}/`)) response = await proxyFocus(ctx);
    else response = await plusOwner(ctx, null);
    return withPrivateHeaders(response, false);
  } catch (error) {
    return withPrivateHeaders(api.errorResponse(error instanceof RpcError ? error : uiError('INTERNAL'), ctx.requestId), false);
  }
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function focusClient(env: Env) {
  return createHttpClient(FlowDayUiService, async call => {
    if (!env.FLOWDAY_FOCUS) throw uiError('UNAVAILABLE');
    try {
      return await env.FLOWDAY_FOCUS.fetch(new Request(`https://flowday.internal${call.url}`, {
        method: call.httpMethod, headers: { 'content-type': 'application/json' },
        ...(call.body === undefined ? {} : { body: call.body }),
      }));
    } catch { throw uiError('UNAVAILABLE'); }
  });
}

/** Only a persisted successful Todoist close can create a frozen settlement. */
async function settleCompleted(env: Env, input: { request_id: string; task_id: string; flow_date: string }): Promise<void> {
  const client = focusClient(env);
  const core = coordinator(env);
  let frozen = await core.plus_focus_claim(input.request_id, null, null);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (frozen === null) {
      const timer = await client.getTimerSession({ name: 'timerSession' });
      const request = JSON.stringify({ name: 'timerSession', request_id: crypto.randomUUID(), etag: timer.etag,
        action: 'settle', task_id: input.task_id, flow_date: input.flow_date });
      frozen = await core.plus_focus_claim(input.request_id, request, null);
      if (frozen === null) throw uiError('INTERNAL');
    }
    const request = fromWire(CommandTimerRequestSchema, JSON.parse(frozen), { strict: true }).message;
    try { await client.commandTimer(request); return; }
    catch (error) {
      if (!(error instanceof RpcStatusError) || error.status.httpStatus !== 409 || attempt !== 0) throw uiError('UNAVAILABLE');
      const timer = await client.getTimerSession({ name: 'timerSession' });
      const replacement = JSON.stringify(toWire(CommandTimerRequestSchema, { ...request, requestId: crypto.randomUUID(), etag: timer.etag }));
      frozen = await core.plus_focus_claim(input.request_id, replacement, request.etag);
    }
  }
  throw uiError('UNAVAILABLE');
}

// The proxy decodes and re-encodes each FlowDay page within the Free 10 ms CPU limit; a 200-task page of long titles
// and descriptions reached 10.2 ms cold in CI, so a page is capped at 100 tasks and clients follow next_page_token.
const FOCUS_PAGE_MAX = 100;
const FOCUS_METHODS = new Set(['getTask', 'listTasks', 'getFlow', 'getTimerSession', 'commandTimer', 'syncTasks', 'listTimeEntries', 'updateTask', 'updateFlow', 'rolloverFlow']);
function focusHandlers(): ServiceHandlers<ShapeOf<typeof FlowDayUiService>, PlusContext> {
  const handlers: Record<string, unknown> = {};
  for (const method of FlowDayUiService.methods) {
    handlers[method.localName] = async (input: Parameters<typeof toWire>[1], ctx: PlusContext) => {
      if (!FOCUS_METHODS.has(method.localName)) throw uiError('ACTION_NOT_ALLOWED');
      if (method.localName === 'commandTimer' && (input as { action?: number }).action === CommandTimerRequest_Action.SETTLE) throw uiError('ACTION_NOT_ALLOWED');
      if (method.localName === 'listTasks') {
        const request = input as { pageSize?: number };
        request.pageSize = Math.min(request.pageSize || FOCUS_PAGE_MAX, FOCUS_PAGE_MAX);
      }
      if (method.localName === 'updateTask') {
        const paths = (input as { updateMask?: { paths: string[] } }).updateMask?.paths;
        if (paths?.length !== 1 || paths[0] !== 'estimated_minutes') throw uiError('ACTION_NOT_ALLOWED');
      }
      const client = focusClient(ctx.env);
      // The two services use the same generated descriptor; no hand-written DTO or raw body forwarding.
      const call = client[method.localName as keyof typeof client] as (request: typeof input) => Promise<typeof input>;
      try { return await call(input); }
      catch (error) {
        if (error instanceof RpcStatusError) {
          throw new RpcError(error.status.status ? Code[error.status.status] : Code.UNAVAILABLE,
            error.status.reason ?? 'UNAVAILABLE', error.status.message, { httpStatus: error.status.httpStatus });
        }
        throw uiError('UNAVAILABLE');
      }
    };
  }
  return handlers as ServiceHandlers<ShapeOf<typeof FlowDayUiService>, PlusContext>;
}
const focusApi = new HttpTranscoder(FlowDayUiService, focusHandlers(), {
  domain: DOMAIN, maxBodyBytes: 32 * 1024,
  authorize: (_request, route, ctx) => { if (!route.safe && flag(ctx.env, 'MAINTENANCE_MODE')) throw uiError('MAINTENANCE'); },
});
async function proxyFocus(ctx: Context): Promise<Response> {
  const path = ctx.url.pathname.slice(FLOW_PREFIX.length);
  const request = new Request(`https://flowday.internal${path}${ctx.url.search}`, ctx.request);
  const result = await focusApi.handle(request, { env: ctx.env, owner: null }, ctx.requestId);
  return result?.response ?? api.errorResponse(uiError('NOT_FOUND'), ctx.requestId);
}
