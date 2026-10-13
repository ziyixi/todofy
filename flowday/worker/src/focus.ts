/** Private service-binding surface for Todofy's authenticated extension gateway. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { FlowDayUiService } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { HttpTranscoder, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { handlers, type ApiContext } from './api.ts';
import { Meter, isStorageError, openDb } from './db.ts';
import type { Env } from './env.ts';
import { API_DOMAIN, flowdayError, localize } from './errors.ts';
import { MAX_BODY_BYTES } from './limits.ts';

const focusApi = new HttpTranscoder<ShapeOf<typeof FlowDayUiService>, ApiContext>(FlowDayUiService, {
  ...handlers,
  getTask: handlers.getTask,
  listTasks: handlers.listTasks,
  getFlow: handlers.getFlow,
  getTimerSession: handlers.getTimerSession,
  commandTimer: handlers.commandTimer,
  syncTasks: handlers.syncTasks,
  listTimeEntries: handlers.listTimeEntries,
  async updateTask(request, context) {
    if (request.updateMask?.paths.join(',') !== 'estimated_minutes') throw flowdayError('BAD_REQUEST');
    return handlers.updateTask(request, context);
  },
  async updateFlow(request, context) {
    if (request.updateMask?.paths.join(',') !== 'task_ids') throw flowdayError('BAD_REQUEST');
    return handlers.updateFlow(request, context);
  },
}, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  localize,
  authorize(_request, route) {
    if (!new Set(['GetTask', 'ListTasks', 'GetFlow', 'GetTimerSession', 'CommandTimer', 'SyncTasks', 'ListTimeEntries', 'UpdateTask', 'UpdateFlow']).has(route.method.name)) throw flowdayError('NOT_FOUND');
  },
  onUnexpected: (error) => flowdayError(isStorageError(error) ? 'UNAVAILABLE' : 'INTERNAL'),
});

/** Only same-account bindings can reach this entrypoint; default fetch keeps owner authentication. */
export class FocusEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const context = { env: this.env, db: openDb(this.env.DB, new Meter()), fetcher: fetch, now: () => new Date() };
    const result = await focusApi.handle(request, context, crypto.randomUUID());
    return result?.response ?? focusApi.errorResponse(flowdayError('NOT_FOUND'), crypto.randomUUID());
  }
}
