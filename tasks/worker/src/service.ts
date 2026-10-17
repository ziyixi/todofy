import { PreEncoded } from '@ziyixi/proto/http-transcoder';
import { TasksUiService } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, type ApiContext } from './api.ts';
import { api } from './http.ts';
import type { Env } from './env.ts';

/** Python consumes generated messages through this existing RPC-shaped binding boundary. */
export async function serviceCall(method: string, body: string, env: Env): Promise<{ status: number; body: string }> {
  const requestId = crypto.randomUUID();
  try {
    if (typeof method !== 'string' || typeof body !== 'string' || new TextEncoder().encode(body).length > 65536) {
      throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'Invalid service request');
    }
    const descriptor = TasksUiService.methods.find((candidate) => candidate.name === method);
    if (!descriptor) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Unknown Tasks method');
    const input = fromWire(descriptor.input, JSON.parse(body), {
      strict: true,
    }).message;
    const context: ApiContext = {
      env,
      now: Date.now(),
      owner: 'todofy',
      bypassed: false,
      internal: true,
    };
    // The descriptor validates the message before this reflective dispatch to the generated handler map.
    const handler = handlers[descriptor.localName as keyof typeof handlers];
    const output = await handler(input as never, context);
    if (output instanceof PreEncoded)
      throw new RpcError(Code.INTERNAL, 'INTERNAL', 'Unexpected encoded service response');
    return {
      status: 200,
      body: JSON.stringify(toWire(descriptor.output, output)),
    };
  } catch (error) {
    const failure =
      error instanceof RpcError
        ? error
        : error instanceof WireJsonError || error instanceof SyntaxError
          ? new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'Invalid service message')
          : new RpcError(Code.INTERNAL, 'INTERNAL', 'Unexpected Tasks service error');
    const response = api.errorResponse(failure, requestId);
    return { status: response.status, body: await response.text() };
  }
}
