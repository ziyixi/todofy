import type { Env } from './types.ts';
import { coordinatorRequest } from './capacity.ts';
import { HttpError, sha256 } from './security.ts';
import { handleBackupArtifactAPI } from './backup-artifacts.ts';

export const BACKUP_PREFIX = '/api/internal/backup';
export function canonicalJSON(value: unknown): string {
  if (value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value as object).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export async function backupStatus(env: Env): Promise<Record<string, any>> {
  const response = await coordinatorRequest(env, '/backup/status');
  if (!response.ok) throw new HttpError(503, 'backup_unavailable', '备份状态暂不可用');
  return response.json();
}
export async function acquireMutationLease(env: Env): Promise<string> {
  const response = await coordinatorRequest(env, '/mutation/begin', {});
  if (!response.ok) throw new HttpError(503, 'backup_in_progress', '备份快照期间暂不接受修改；新邮件仍会归档');
  return (await response.json() as { id: string }).id;
}
export async function releaseMutationLease(env: Env, id: string): Promise<void> {
  const response = await coordinatorRequest(env, '/mutation/end', { id });
  if (!response.ok) throw new Error('mutation_lease_release_failed');
}
export async function withBackupWrite<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  const id = await acquireMutationLease(env);
  try { return await operation(); }
  finally { await releaseMutationLease(env, id); }
}
export const withMutationLease = withBackupWrite;

async function equalSecret(got: string, want: string): Promise<boolean> {
  const a = await sha256(got), b = await sha256(want);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
/** This route uses a dedicated machine credential; the deployment's Access
 * machine policy is additional protection, never a replacement for this check. */
export async function authenticateBackupRequest(request: Request, env: Env): Promise<void> {
  const value = request.headers.get('Authorization') ?? '';
  if (!env.BACKUP_TOKEN || env.BACKUP_TOKEN.length < 32) throw new HttpError(503, 'backup_unconfigured', '备份入口尚未配置');
  if (!value.startsWith('Bearer ') || !await equalSecret(value.slice(7), env.BACKUP_TOKEN)) throw new HttpError(401, 'backup_unauthorized', '备份凭据无效');
}
export async function handleBackupAPI(request: Request, env: Env): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  await authenticateBackupRequest(request, env);
  const url = new URL(request.url), action = url.pathname.slice(BACKUP_PREFIX.length);
  if (action === '/artifacts' || action.startsWith('/artifacts/')) return handleBackupArtifactAPI(request, env);
  if (!/^\/(begin|status|writers|reconcile-writer|control|database-schema|database|objects|object|manifest|finish|cancel)$/.test(action)) return new Response(null, { status: 404, headers });
  if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers });
  if (request.method === 'POST' && Number(request.headers.get('Content-Length') ?? 0) > 16 * 1024) return new Response(null, { status: 413, headers });
  let body: string | undefined;
  if (request.method === 'POST') {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    if (reader) {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 16 * 1024) { await reader.cancel(); return new Response(null, { status: 413, headers }); }
        chunks.push(next.value);
      }
    }
    const raw = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    body = new TextDecoder().decode(raw);
  }
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch(`https://coordinator/backup${action}${url.search}`, {
    method: request.method, headers: { 'Content-Type': 'application/json' },
    body,
  });
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}

export interface BackupReceipt { backup_id: string; manifest_sha256: string; remote_locator: string; verified_at: string }
export async function verifyBackupReceipt(env: Env, receipt: BackupReceipt, mac: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(env.BACKUP_RECEIPT_KEY ?? '') || !/^[0-9a-f]{64}$/i.test(mac)) return false;
  const raw = new Uint8Array(env.BACKUP_RECEIPT_KEY!.match(/../g)!.map(hex => parseInt(hex, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = new Uint8Array(mac.match(/../g)!.map(hex => parseInt(hex, 16)));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(canonicalJSON(receipt)));
}
