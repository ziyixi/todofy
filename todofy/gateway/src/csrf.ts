/** Same-origin JSON owner writes; Access authentication runs before these checks. */
import { verifyCsrf as verify } from '@ziyixi/edge-auth';
import { localDev, variable, type Env } from './env.ts';
import { uiError } from './ui.ts';
function allowedOrigins(env: Env, url: URL): string[] {
  const origins = [`https://${variable(env, 'TODOFY_PUBLIC_HOST').toLowerCase()}`];
  if (localDev(env)) origins.push(`http://${url.host.toLowerCase()}`);
  return origins;
}
export async function verifyCsrf(request: Request, env: Env): Promise<void> {
  if (!(await verify(request, { allowedOrigins: allowedOrigins(env, new URL(request.url)) })).ok) throw uiError('CSRF_FAILED');
}
