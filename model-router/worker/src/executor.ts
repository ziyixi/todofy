/** Private VPS heartbeats stay within Router; every public call returns final JSON. */
import { createHttpClient } from '@ziyixi/proto/http-client';
import { ModelService } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { Env } from './types.ts';
import { unavailable, precondition } from './errors.ts';

export async function finalResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) unavailable('MODEL_EXECUTOR_INVALID_RESPONSE', 'Model executor returned no result.');
  let buffer = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
      if (buffer.length > 16 * 1024 * 1024)
        unavailable('MODEL_EXECUTOR_INVALID_RESPONSE', 'Model executor response exceeded its limit.');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event === 'result') return new Response(data, { headers: { 'content-type': 'application/json' } });
        if (event === 'error')
          return new Response(data, { status: 503, headers: { 'content-type': 'application/json' } });
        if (event !== 'ready' && event !== 'heartbeat' && event !== undefined)
          unavailable('MODEL_EXECUTOR_INVALID_RESPONSE', 'Model executor returned an unknown event.');
      }
    }
    unavailable('MODEL_EXECUTOR_INTERRUPTED', 'Model executor disconnected before its final result.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function executorClient(env: Env, app: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const origin = env.CODEX_EXECUTOR_ORIGIN;
  if (!origin || !env.CODEX_ACCESS_CLIENT_ID || !env.CODEX_ACCESS_CLIENT_SECRET)
    precondition('MODEL_NOT_CONFIGURED', 'The model executor connection is not configured.');
  return createHttpClient(ModelService, async (call) => {
    const path = call.url.replace(/^\/api\/model\/v1\//, '/api/codex/v1/model/');
    const response = await fetcher(new URL(path, origin), {
      method: call.httpMethod,
      redirect: 'manual',
      signal: signal ?? null,
      headers: {
        'user-agent': 'todofy-model-router/1.0',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-inference-caller': app,
        ...(env.CODEX_ACCESS_CLIENT_ID ? { 'CF-Access-Client-Id': env.CODEX_ACCESS_CLIENT_ID } : {}),
        ...(env.CODEX_ACCESS_CLIENT_SECRET ? { 'CF-Access-Client-Secret': env.CODEX_ACCESS_CLIENT_SECRET } : {}),
      },
      ...(call.body === undefined ? {} : { body: call.body }),
    }).catch(() => unavailable('MODEL_EXECUTOR_UNAVAILABLE', 'The model executor could not be reached.'));
    return finalResponse(response);
  });
}
