/** Same-origin JSON mutation checks. Authentication runs in the app before this helper. */
export const CSRF_HEADER = 'X-CSRF-Token';
export const CSRF_TOKEN = '1';
export const CSRF_MAX_TOKEN_CHARS = 1024;

export interface CsrfPolicy { readonly allowedOrigins: readonly string[] }
export type CsrfFailure = 'origin' | 'token' | 'content_type';
export type CsrfResult = { readonly ok: true } | { readonly ok: false; readonly failure: CsrfFailure };

/** No body reads, cookies or secrets. Nonempty legacy headers remain accepted for cached clients. */
export function verifyCsrf(request: Request, policy: CsrfPolicy): Promise<CsrfResult> {
  const origin = request.headers.get('origin');
  const token = request.headers.get(CSRF_HEADER)?.trim() ?? '';
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  let failure: CsrfFailure | undefined;
  if (!origin || origin === 'null' || !policy.allowedOrigins.includes(origin)) failure = 'origin';
  else if (!token || token.length > CSRF_MAX_TOKEN_CHARS) failure = 'token';
  else if (mediaType !== 'application/json') failure = 'content_type';
  return Promise.resolve(failure ? { ok: false, failure } : { ok: true });
}
