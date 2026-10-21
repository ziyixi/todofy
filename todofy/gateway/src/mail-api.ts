/** The personal integration's private Mail binding. Public fetch never routes these requests. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { HttpTranscoder, PreEncoded, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { MailReadinessService } from '@ziyixi/proto/todofy/ui/v1/mail_ready_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { coordinator } from './coordinator.ts';
import type { Env } from './env.ts';
import { nativeMail } from './plus.ts';
import { API_DOMAIN, isReason, uiError } from './ui.ts';

const readiness = new HttpTranscoder<ShapeOf<typeof MailReadinessService>, Env>(MailReadinessService, {
  async pollMailReady(input, env) {
    let answer;
    try {
      answer = await coordinator(env).mail_ready_poll(JSON.stringify(toWire(MailReadinessService.method.pollMailReady.input, input)));
    } catch { throw uiError('UNAVAILABLE'); }
    if ('error' in answer) {
      if (answer.error === 'CURSOR_RESET_REQUIRED') throw new RpcError(Code.FAILED_PRECONDITION, 'CURSOR_RESET_REQUIRED',
        'Mail readiness cursor is ahead of this database; reset the reader with baseline=true.');
      throw uiError(isReason(answer.error) ? answer.error : 'INTERNAL');
    }
    return new PreEncoded(answer.ok);
  },
}, { domain: API_DOMAIN, maxBodyBytes: 32 * 1024, authorize: () => {} });

export async function mailRequest(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/plus/v1/mailItems:pollReady') return nativeMail(request, env);
  const requestId = crypto.randomUUID();
  const result = await readiness.handle(request, env, requestId);
  return result?.response ?? readiness.errorResponse(uiError('NOT_FOUND'), requestId);
}

export class MailApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return mailRequest(request, this.env);
  }
}
