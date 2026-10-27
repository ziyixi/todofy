import { asciiLowerCase, createAccessVerifier, verifyCsrf } from '@ziyixi/edge-auth';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
const verifier = createAccessVerifier();
export function authenticate(request: Request, env: Env) {
  return verifier.verify(request, {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: 600000, refreshCooldownMs: 60000 },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: asciiLowerCase((env.ACCESS_OWNER ?? '').trim()),
      whenNotLocal: 'refuse',
    },
  });
}
export async function checkCsrf(request: Request, env: Env, bypassed: boolean): Promise<void> {
  const origins = [`https://${env.PUBLIC_HOST}`];
  if (bypassed) origins.push(new URL(request.url).origin);
  const result = await verifyCsrf(request, {
    allowedOrigins: origins,
  });
  if (!result.ok) throw new RpcError(Code.PERMISSION_DENIED, 'CSRF_FAILED', 'Refresh the page before making changes');
}
