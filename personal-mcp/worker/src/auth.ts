import { createAccessVerifier } from '@ziyixi/edge-auth';
import type { Env } from './env.ts';

const verifier = createAccessVerifier();

export async function authenticate(request: Request, env: Env) {
  // OAuth terminates at Access. Only its signed assertion is accepted here, never a browser cookie.
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return verifier.verify(new Request(request.url, { headers }), {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'missing', cookie: 'first' },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: 'owner@example.org',
      whenNotLocal: 'refuse',
    },
  });
}
