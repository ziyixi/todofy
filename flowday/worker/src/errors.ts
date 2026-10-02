/**
 * The errors of the owner API (proto/flowday/ui/v1/errors.proto): each ErrorInfo reason FlowDay answers, of
 * flowday.ui.v1.ErrorReason or common.errors.v1.CommonReason, with its google.rpc.Code, its developer message and the
 * copy the owner reads (the google.rpc.LocalizedMessage; FlowDay's UI is English). Nothing from a request is ever
 * part of an error.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import type { ErrorReason } from '@ziyixi/proto/flowday/ui/v1/errors_pb';
import { Code, RpcError, type ErrorDetail } from '@ziyixi/proto/rpc-status';

/** An ErrorInfo reason FlowDay answers: its own (flowday.ui.v1.ErrorReason) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

/** ErrorInfo.domain: the API's name (FlowDayUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 'flowday.ziyixi.science';
/** The locale of every LocalizedMessage. */
export const LOCALE = 'en';

/**
 * Each reason's code (errors.proto lists the same), its developer message and the owner's copy. Exhaustive: a new
 * ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly copy: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', copy: 'Not signed in, or the sign-in is no longer valid.' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', copy: 'Cloudflare Access is not fully configured.' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', copy: 'A required secret is not configured.' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', copy: 'The page security token expired. Reload and try again.' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', copy: 'The request is not valid.' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', copy: 'Not found.' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', copy: 'Method not allowed.' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'a dependency failed; repeat the request', copy: 'The service is temporarily unavailable. Try again shortly.' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', copy: 'Something went wrong in FlowDay. Reload the page and try again.' },
  TODOIST_KEY_MISSING: { code: Code.FAILED_PRECONDITION, message: 'no Todoist API key is stored', copy: 'No Todoist API key configured. Add one in Settings.' },
  TODOIST_KEY_UNREADABLE: {
    code: Code.FAILED_PRECONDITION,
    message: 'the stored Todoist API key cannot be opened',
    copy: 'The stored Todoist API key cannot be read. Enter it again in Settings.',
  },
  TODOIST_UNAUTHORIZED: { code: Code.FAILED_PRECONDITION, message: 'Todoist refused the stored API key', copy: 'Todoist rejected the API key. Check it in Settings.' },
  TODOIST_UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'Todoist failed or could not be reached', copy: 'Todoist could not be reached. FlowDay will try again later.' },
  TASK_NOT_DELETED: { code: Code.ALREADY_EXISTS, message: 'the task is not deleted', copy: 'This task is not in the trash.' },
};

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** The RpcError of `reason` (headers: an Allow; httpStatus: 405 where the code's mapping is not the status). */
export function flowdayError(
  reason: Reason,
  details: readonly ErrorDetail[] = [],
  headers: Readonly<Record<string, string>> = {},
  httpStatus?: number,
): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details, headers, ...(httpStatus === undefined ? {} : { httpStatus }) });
}

/** The owner's copy of a reason (google.rpc.LocalizedMessage), for the transcoder's `localize`. */
export function localize(reason: string): { locale: string; message: string } | undefined {
  return isReason(reason) ? { locale: LOCALE, message: REASONS[reason].copy } : undefined;
}
