/**
 * Tasks' planning and Mail API (PlusService), reached only through the private Planning binding (planning.ts).
 * Tasks checks Access, Origin and CSRF before it forwards.
 */
import { HttpTranscoder, PreEncoded, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { coordinator } from './coordinator.ts';
import { flag, type Env } from './env.ts';
import { API_DOMAIN, isReason, uiError } from './ui.ts';

interface PlusContext { env: Env }
/**
 * What Tasks calls on its private Planning channel (packages/planning-ui/src/api.ts, tasks/web/src); that path
 * refuses every other PlusService method. VerifyPlanStore is the restore runbook's check.
 */
const NATIVE_METHODS = new Set([
  'ReadPlan', 'ReadWeeklyReview', 'ListPlanningTasks', 'SetTaskPlan', 'SetTaskLead', 'AppendTaskSteps', 'SetWeeklyBet',
  'SetTaskDependency', 'ResolveDependencies', 'ReorderTasks', 'ListMailItems', 'ReadMailSummary', 'ConvertMailItem',
  'DeleteMailSummaries', 'ReadMailSettings', 'UpdateMailCategories', 'VerifyPlanStore',
]);
const PREFIX = '/api/plus/v1/';
const DOMAIN = API_DOMAIN;

function handlers(): ServiceHandlers<ShapeOf<typeof PlusService>, PlusContext> {
  const result: Record<string, unknown> = {};
  for (const method of PlusService.methods) {
    const idempotent = method.input.fields.some(field => field.name === 'request_id');
    result[method.localName] = async (input: Parameters<typeof toWire>[1], ctx: PlusContext) => {
      const wire = toWire(method.input, input);
      if (idempotent && wire['request_id'] === undefined) wire['request_id'] = crypto.randomUUID();
      let answer;
      try { answer = await coordinator(ctx.env).plus_native_ui(method.name, JSON.stringify(wire)); }
      catch { throw uiError('UNAVAILABLE'); }
      if ('error' in answer) throw uiError(isReason(answer.error) ? answer.error : 'INTERNAL');
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

/** Called only by the named Planning service binding, after its binding identity and source checks. */
export async function nativePlanning(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  if (!url.pathname.startsWith(PREFIX)) return api.errorResponse(uiError('NOT_FOUND'), requestId);
  const result = await api.handle(request, { env }, requestId);
  return result?.response ?? api.errorResponse(uiError('NOT_FOUND'), requestId);
}
