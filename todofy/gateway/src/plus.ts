/**
 * Tasks' planning and Mail API (PlusService) and the FlowDay focus methods Plan and Focus use, reached only
 * through the private Planning binding (planning.ts). Tasks checks Access, Origin and CSRF before it forwards.
 */
import { HttpTranscoder, PreEncoded, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { FlowDayUiService, CommandTimerRequestSchema, CommandTimerRequest_Action } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { coordinator } from './coordinator.ts';
import { flag, variable, type Env } from './env.ts';
import { API_DOMAIN, isReason, uiError } from './ui.ts';

interface PlusContext { env: Env }
/**
 * What Tasks calls on its private Planning channel (packages/planning-ui/src/api.ts, tasks/web/src); that path
 * refuses every other PlusService method. VerifyPlanStore is the restore runbook's check.
 */
const NATIVE_METHODS = new Set([
  'ReadPlan', 'ReadWeeklyReview', 'ListPlanningTasks', 'SetTaskPlan', 'SetTaskLead', 'AppendTaskSteps', 'CompleteTask', 'SetWeeklyBet',
  'SetTaskDependency', 'ResolveDependencies', 'ReorderTasks', 'ListMailItems', 'ReadMailSummary', 'ConvertMailItem',
  'DeleteMailSummaries', 'ReadMailSettings', 'UpdateMailCategories', 'VerifyPlanStore',
]);
const PREFIX = '/api/plus/v1/';
const FLOW_PREFIX = '/api/plus/flowday';
const DOMAIN = API_DOMAIN;

function handlers(): ServiceHandlers<ShapeOf<typeof PlusService>, PlusContext> {
  const result: Record<string, unknown> = {};
  for (const method of PlusService.methods) {
    const idempotent = method.input.fields.some(field => field.name === 'request_id');
    result[method.localName] = async (input: Parameters<typeof toWire>[1], ctx: PlusContext) => {
      const wire = toWire(method.input, input);
      if (idempotent && wire['request_id'] === undefined) wire['request_id'] = crypto.randomUUID();
      if (method.name === 'CompleteTask' && wire['flow_date'] && !validDay(wire['flow_date'])) throw uiError('BAD_REQUEST');
      let answer;
      try { answer = await coordinator(ctx.env).plus_native_ui(method.name, JSON.stringify(wire)); }
      catch { throw uiError('UNAVAILABLE'); }
      if ('error' in answer) throw uiError(isReason(answer.error) ? answer.error : 'INTERNAL');
      if (method.name === 'CompleteTask' && typeof wire['flow_date'] === 'string' && wire['flow_date']) {
        const settlement = { ...wire, task_id: wire['flow_task_id'] || wire['task_id'] };
        try { await settleCompleted(ctx.env, settlement as { request_id: string; task_id: string; flow_date: string }); }
        catch (error) { throw error instanceof RpcError ? error : uiError('UNAVAILABLE'); }
      }
      if (method.name === 'ReadPlan') {
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
  authorize: (_request, route, ctx) => {
    if (!NATIVE_METHODS.has(route.method.name)) throw uiError('ACTION_NOT_ALLOWED');
    if (!route.safe && flag(ctx.env, 'MAINTENANCE_MODE')) throw uiError('MAINTENANCE');
  },
});

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function focusClient(env: Env) {
  return createHttpClient(FlowDayUiService, async call => {
    const binding = env.FLOWDAY_NATIVE_FOCUS;
    if (!binding) throw uiError('UNAVAILABLE');
    try {
      return await binding.fetch(new Request(`https://flowday.internal${call.url}`, {
        method: call.httpMethod, headers: { 'content-type': 'application/json' },
        ...(call.body === undefined ? {} : { body: call.body }),
      }));
    } catch { throw uiError('UNAVAILABLE'); }
  });
}

/** Only a persisted successful completion in Tasks can create a frozen settlement. */
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
/** What Plan and Focus call on FlowDay; FlowDay's focus entrypoint allows the same (flowday/worker/src/focus.ts). */
const FOCUS_METHODS = new Set(['listTasks', 'getFlow', 'updateFlow', 'rolloverFlow', 'getTimerSession', 'commandTimer']);
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

/** Called only by the named Planning service binding, after its binding identity and source checks. */
export async function nativePlanning(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  if (!url.pathname.startsWith(PREFIX) && !url.pathname.startsWith(`${FLOW_PREFIX}/`)) {
    return api.errorResponse(uiError('NOT_FOUND'), requestId);
  }
  const context: PlusContext = { env };
  if (url.pathname.startsWith(`${FLOW_PREFIX}/`)) {
    const target = new Request(`https://flowday.internal${url.pathname.slice(FLOW_PREFIX.length)}${url.search}`, request);
    const result = await focusApi.handle(target, context, requestId);
    return result?.response ?? api.errorResponse(uiError('NOT_FOUND'), requestId);
  }
  const result = await api.handle(request, context, requestId);
  return result?.response ?? api.errorResponse(uiError('NOT_FOUND'), requestId);
}
