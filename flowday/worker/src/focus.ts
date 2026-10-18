/** Private service-binding surface for Todofy's authenticated extension gateway. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { FlowDayUiService } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { HttpTranscoder, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { handlers, type ApiContext } from './api.ts';
import { Meter, isStorageError, openDb } from './db.ts';
import type { Env } from './env.ts';
import { API_DOMAIN, flowdayError, localize } from './errors.ts';
import { MAX_BODY_BYTES } from './limits.ts';

/** What Tasks' Plan and Focus call through Todofy; the gateway allows the same (todofy/gateway/src/plus.ts). */
const FOCUS_METHODS = new Set(['ListTasks', 'GetFlow', 'UpdateFlow', 'RolloverFlow', 'GetTimerSession', 'CommandTimer']);

const focusApi = new HttpTranscoder<ShapeOf<typeof FlowDayUiService>, ApiContext>(FlowDayUiService, {
  ...handlers,
  async updateFlow(request, context) {
    if (request.updateMask?.paths.join(',') !== 'task_ids') throw flowdayError('BAD_REQUEST');
    return handlers.updateFlow(request, context);
  },
}, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  localize,
  authorize(_request, route) {
    if (!FOCUS_METHODS.has(route.method.name)) throw flowdayError('NOT_FOUND');
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

/** Native Tasks must never synchronize against the legacy Todoist source during a staged deployment. */
export class NativeFocusEntrypoint extends FocusEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    if (!this.env.TASKS) {
      return focusApi.errorResponse(flowdayError('TASKS_UNAVAILABLE'), crypto.randomUUID());
    }
    return super.fetch(request);
  }
}
