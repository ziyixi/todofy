import { RpcError, Code } from '@ziyixi/proto/rpc-status';
export { RpcError, Code };
export function invalid(reason: string, message: string): never { throw new RpcError(Code.INVALID_ARGUMENT, reason, message); }
export function unavailable(reason: string, message: string): never { throw new RpcError(Code.UNAVAILABLE, reason, message); }
export function precondition(reason: string, message: string): never { throw new RpcError(Code.FAILED_PRECONDITION, reason, message); }
export function resourceId(name: string, prefix: string): string {
  const match = new RegExp(`^${prefix}/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`).exec(name);
  if (!match) invalid('INVALID_RESOURCE', `Use ${prefix}/{UUID}.`);
  return match[1]!;
}
export function requestId(value: string): string { return resourceId(`requests/${value}`, 'requests'); }
