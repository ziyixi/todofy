/**
 * Todofy's Mail entry (todofy.mail.v1 MailService, proto/todofy/mail/v1): the mail Todofy summarised and keeps, for a
 * Worker in this account whose service binding names this entrypoint. No public host routes it.
 *
 *   [[services]]  binding = "MAIL"  service = "todofy"  entrypoint = "Mail"  props = { access = "read-write" }
 *
 * `props.access` grants `read` (the GET methods) or `read-write` (also MarkMailConverted and DeleteMailSummaries), the
 * generic model of Tasks' TasksApi: it names no caller. Any other binding, or a write on a `read` binding, is
 * PERMISSION_DENIED before the body is read. Writes answer MAINTENANCE while MAINTENANCE_MODE is on. Every other
 * request is one TodofyCore.mail call (runtime/mail.py) with the rpc's name and the decoded request in wire JSON.
 * TodofyCore writes each answer with the wire profile, so it goes out as it came (PreEncoded); a failed core call is
 * UNAVAILABLE. Todofy makes no task here: Tasks converts a mail itself and then marks it converted.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { HttpTranscoder, PreEncoded, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { MailService, type ErrorReason } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { coordinator, type MailAnswer } from './coordinator.ts';
import { flag, type Env } from './env.ts';
import { newRequestId } from './http.ts';
import { API_DOMAIN, MAINTENANCE_RETRY_AFTER_S } from './ui.ts';

/** Requests are a few hundred bytes; 200 event IDs to delete are about 8 KiB. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * An ErrorInfo reason TodofyCore answers: one of todofy.mail.v1.ErrorReason, or of the common reasons (CommonReason)
 * runtime/mail.py uses.
 */
type Reason = Exclude<keyof typeof ErrorReason, 'UNSPECIFIED'> | 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INTERNAL';

/**
 * Each reason's code (mail_service.proto lists the same) and its developer message. Exhaustive: a new ErrorReason fails
 * the typecheck until it is mapped here.
 */
const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string }>> = {
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such mail' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'Todofy is unavailable or its backup holds the mail; repeat the request' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the mail changed since its etag; read it again' },
  NOT_PENDING: { code: Code.FAILED_PRECONDITION, message: 'the mail no longer awaits a decision' },
  MAINTENANCE: { code: Code.UNAVAILABLE, message: 'maintenance mode: writes wait' },
  CURSOR_RESET_REQUIRED: {
    code: Code.FAILED_PRECONDITION,
    message: 'the readiness cursor is ahead of this database; start again with baseline=true',
  },
};

function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** A reason as its RpcError; one TodofyCore should never answer is INTERNAL. */
function mailError(answered: string, retryAfter: number | null = null): RpcError {
  const reason: Reason = isReason(answered) ? answered : 'INTERNAL';
  const headers: Record<string, string> = retryAfter === null ? {} : { 'retry-after': String(retryAfter) };
  return new RpcError(REASONS[reason].code, reason, REASONS[reason].message, { headers });
}

function handlers(): ServiceHandlers<ShapeOf<typeof MailService>, Env> {
  const result: Record<string, unknown> = {};
  for (const method of MailService.methods) {
    result[method.localName] = async (input: Parameters<typeof toWire>[1], env: Env) => {
      const request = JSON.stringify(toWire(method.input, input));
      let answer: MailAnswer;
      try {
        answer = await coordinator(env).mail(method.name, request);
      } catch {
        throw mailError('UNAVAILABLE');
      }
      if ('error' in answer) throw mailError(answer.error, answer.retry_after);
      return new PreEncoded(answer.ok);
    };
  }
  return result as ServiceHandlers<ShapeOf<typeof MailService>, Env>;
}

/** Built at global scope, so that reading the descriptors' options happens at startup, outside any request's CPU. */
const api = new HttpTranscoder(MailService, handlers(), {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize: (_request, route, env) => {
    if (!route.safe && flag(env, 'MAINTENANCE_MODE')) throw mailError('MAINTENANCE', Number(MAINTENANCE_RETRY_AFTER_S));
  },
});

/** What a binding of `Mail` passes as `props`: the access it grants. */
export interface MailProps {
  readonly access?: unknown;
}

/** One request of a binding that grants ``access``; anything the access does not cover is PERMISSION_DENIED. */
export async function mailRequest(request: Request, env: Env, access: unknown): Promise<Response> {
  const requestId = newRequestId();
  const reads = request.method === 'GET' || request.method === 'HEAD';
  if (access !== 'read-write' && !(access === 'read' && reads)) {
    const refused = new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'this binding does not grant this Mail operation');
    return api.errorResponse(refused, requestId);
  }
  const result = await api.handle(request, env, requestId);
  return result?.response ?? api.errorResponse(mailError('NOT_FOUND'), requestId);
}

export class Mail extends WorkerEntrypoint<Env, MailProps> {
  override fetch(request: Request): Promise<Response> {
    return mailRequest(request, this.env, (this.ctx.props as MailProps | undefined)?.access);
  }
}
