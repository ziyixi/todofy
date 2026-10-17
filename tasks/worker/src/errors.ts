import { Code, RpcError } from '@ziyixi/proto/rpc-status';
export function invalid(message = 'Invalid task input'): never {
  throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', message);
}
export function missing(): never {
  throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Resource does not exist');
}
export function conflict(): never {
  throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'Resource changed; refresh before editing');
}
export function precondition(message: string): never {
  throw new RpcError(Code.FAILED_PRECONDITION, 'PRECONDITION_FAILED', message);
}
export async function storage<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Task storage is temporarily unavailable');
  }
}
