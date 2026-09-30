/** Reading the Worker's vars (docs/design.md §2); invalid values fall back to safe defaults. */
import type { Env } from './env.ts';

export const DEFAULT_CANARY_UTC_HOUR = 16;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** CANARY_UTC_HOUR as an integer 0–23; anything else is 16. */
export function canaryHour(env: Pick<Env, 'CANARY_UTC_HOUR'>): number {
  const raw = (env.CANARY_UTC_HOUR ?? '').trim();
  if (!/^[0-9]{1,2}$/.test(raw)) return DEFAULT_CANARY_UTC_HOUR;
  const hour = Number(raw);
  return hour <= 23 ? hour : DEFAULT_CANARY_UTC_HOUR;
}

/**
 * CANARY_ENABLED: unset or empty (older configs, local runs) and `true` enable canary starts; `false`
 * disables them. Any other value also disables them: the switch exists to stop canaries (before a
 * Todofy rollback), so a value it cannot read never starts one. deploy/deploy-vars.mjs sends only true/false.
 */
export function canaryEnabled(env: Pick<Env, 'CANARY_ENABLED'>): boolean {
  const raw = (env.CANARY_ENABLED ?? '').trim();
  return raw === '' || raw === 'true';
}

/** The dashboard's own host (lowercase), or null when PUBLIC_HOST is not a plain domain. */
export function publicHost(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = (env.PUBLIC_HOST as string | undefined)?.trim().toLowerCase() ?? '';
  return DOMAIN.test(host) ? host : null;
}

/** `https://<PUBLIC_HOST>/` for the digest's dashboard_url, or null. */
export function dashboardUrl(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = publicHost(env);
  return host === null ? null : `https://${host}/`;
}

export function buildSha(env: Pick<Env, 'BUILD_SHA'>): string {
  const sha = (env.BUILD_SHA ?? '').trim();
  return /^[0-9a-z]{1,40}$/.test(sha) ? sha : 'dev';
}

export function analyticsConfigured(env: Pick<Env, 'CF_ANALYTICS_TOKEN'>): boolean {
  return (env.CF_ANALYTICS_TOKEN ?? '').trim() !== '';
}
