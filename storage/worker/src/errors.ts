import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status';
import { DOMAIN } from './env.ts';

export function failure(code: Code, reason: string, httpStatus?: number): RpcError {
  return new RpcError(code, reason, 'Storage request failed.', httpStatus === undefined ? {} : { httpStatus });
}

export function badRequest(): never {
  throw failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
}

export function errorResponse(error: unknown, requestId: string, head = false): Response {
  const problem = error instanceof RpcError ? error : failure(Code.INTERNAL, 'INTERNAL');
  return new Response(head ? null : JSON.stringify(statusBody(problem, { domain: DOMAIN, requestId })), {
    status: problem.httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...problem.headers },
  });
}

export async function readJson(response: Response | Request, limit = 65536): Promise<unknown> {
  if (response.body === null) badRequest();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) badRequest();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RpcError) throw error;
    return badRequest();
  } finally {
    reader.releaseLock();
  }
}
