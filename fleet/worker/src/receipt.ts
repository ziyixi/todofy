/** Machine-only HTTP ingress. The exact raw bytes are authenticated before decoding. */
import type { Env } from './env.ts';
import { MAX_REPORT_BYTES, REPORT_KEY_ID, ReceiptError } from './report.ts';
import { OBJECT_NAME } from './state.ts';

const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_report: 400,
  wrong_host: 403,
  report_clock: 400,
  receipt_replay: 409,
};

function reject(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (item) => parseInt(item, 16));
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(MAX_REPORT_BYTES);
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value as Uint8Array;
      if (chunk.length > MAX_REPORT_BYTES - length) {
        await reader.cancel();
        throw new ReceiptError('report_too_large', 413);
      }
      bytes.set(chunk, length);
      length += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, length);
}

/** No owner cookie grants access to this route: its sole identity is the independently scoped HMAC key. */
export async function handleReceipt(request: Request, env: Env, at: number): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return reject('json_required', 415);
  }
  const signature = request.headers.get('x-fleet-signature') ?? '';
  if (request.headers.get('x-fleet-key-id') !== REPORT_KEY_ID || !/^[0-9a-f]{64}$/.test(signature)) {
    return reject('unauthorized', 401);
  }
  const secret = env.REPORT_HMAC_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(secret)) return reject('not_configured', 503);
  try {
    const bytes = await readBody(request);
    if (!bytes) return reject('invalid_report', 400);
    const key = await crypto.subtle.importKey(
      'raw', hexBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    if (!await crypto.subtle.verify('HMAC', key, hexBytes(signature), bytes)) {
      return reject('unauthorized', 401);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return reject('invalid_report', 400);
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const stub = env.FLEET.get(env.FLEET.idFromName(OBJECT_NAME));
    const ack = await stub.accept(text, hash, at);
    return Response.json({ version: 'fleet-receipt-v1', ...ack });
  } catch (error) {
    if (error instanceof ReceiptError) return reject(error.message, error.status);
    const code = error instanceof Error ? error.message : '';
    return reject(code in ERROR_STATUS ? code : 'unavailable', ERROR_STATUS[code] ?? 503);
  }
}
