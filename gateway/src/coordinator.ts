import type { Env } from './env.ts';
import { errorResponse, type Context } from './http.ts';

const INSTANCE = 'inbox-v1';
const BASE = 'https://coordinator';

interface CoordinatorCall {
  readonly method: string;
  /** Extra headers; nothing from the client reaches the core unless it is listed here. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ReadableStream | null;
}

/**
 * One request to the TodofyCore object in todofy-core. The request is built from scratch,
 * so client headers (cookies, tokens, x-todofy-*) never reach the object; the internal marker and
 * the request ID always win over `call.headers`.
 */
export function callCoordinator(
  env: Env,
  requestId: string,
  path: string,
  call: CoordinatorCall,
): Promise<Response> {
  const headers = new Headers(call.headers);
  headers.set('x-todofy-internal', '1');
  headers.set('x-todofy-request-id', requestId);
  return env.COORDINATOR.getByName(INSTANCE).fetch(`${BASE}${path}`, {
    method: call.method,
    headers,
    body: call.body ?? null,
  });
}

/** `callCoordinator`, with a failed stub call answered as 503 `unavailable`. */
export async function forward(ctx: Context, path: string, call: CoordinatorCall): Promise<Response> {
  try {
    return await callCoordinator(ctx.env, ctx.requestId, path, call);
  } catch {
    return errorResponse(ctx.requestId, 503, 'unavailable');
  }
}
