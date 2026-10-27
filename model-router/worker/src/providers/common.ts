import type { ProviderContext } from '../types.ts';
import { secretFor } from '../catalog.ts';
import { record } from './usage.ts';

export function apiKey(context: ProviderContext, provider: 'ANTHROPIC' | 'GEMINI'): string | null {
  return secretFor(context.env, provider === 'ANTHROPIC' ? 'anthropic' : 'gemini') || null;
}

export function providerStatus(code: number, message: string, reason?: string, retryAfterSeconds = 0): { code: number; message: string; reason: string; retryAfterSeconds: number } {
  const reasons: Record<number, string> = { 1: 'MODEL_CANCELLED', 3: 'MODEL_INVALID_ANSWER', 4: 'MODEL_TIMEOUT', 7: 'MODEL_AUTH', 8: 'MODEL_QUOTA', 9: 'MODEL_NOT_CONFIGURED', 13: 'MODEL_INVALID_ANSWER', 14: 'MODEL_UNAVAILABLE' };
  return { code, message, reason: reason ?? reasons[code] ?? 'MODEL_UNAVAILABLE', retryAfterSeconds };
}

/** Delta seconds or HTTP-date, with the caller's existing one-day backoff ceiling. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number {
  const text = (value ?? '').trim();
  const seconds = /^[+-]?\d+$/.test(text) ? Number(text) : (Date.parse(text) - nowMs) / 1000;
  return Number.isNaN(seconds) ? 0 : Math.max(0, Math.min(86_400, Math.ceil(seconds)));
}

export function httpError(provider: string, status: number, headers?: Headers): ReturnType<typeof providerStatus> {
  const code = status === 401 || status === 403 ? 7 : status === 429 ? 8 : status === 408 ? 4 : status >= 500 || status === 409 ? 14 : 9;
  return providerStatus(code, `${provider}_http_${String(status)}`, status === 429 ? 'MODEL_RATE_LIMIT' : undefined, parseRetryAfter(headers?.get('retry-after') ?? null));
}

export function parseSchema(value: string): Record<string, unknown> | null {
  if (value === '') return null;
  const parsed = record(JSON.parse(value));
  if (parsed === null) throw new Error('output_schema_invalid');
  return parsed;
}

export function deadlineSignal(context: ProviderContext, capMs = 840_000): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(context.signal.reason);
  if (context.signal.aborted) abort();
  else context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('provider_deadline')), Math.max(0, Math.min(capMs, context.deadlineMs - Date.now())));
  return { signal: controller.signal, clear: () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); } };
}

/** Cap responses before JSON parsing; provider error bodies are never retained or logged. */
export async function readJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) throw new Error('provider_empty_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('provider_response_too_large');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
