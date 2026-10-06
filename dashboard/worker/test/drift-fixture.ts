/**
 * A fake Cloudflare API for the drift check (unit and workerd tests): it answers the read-only paths
 * drift.ts calls with a live state built from a desired state (by default the bundled
 * src/drift-desired.json), optionally changed, and the account audit log (empty unless given). Every id is
 * synthetic, and every plain_text binding and audit actor carries SENTINEL_VALUE, so the tests can prove that
 * no value is kept.
 */
import type { DesiredState } from '../src/drift.ts';

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const SYNTHETIC_ACCOUNT = '0'.repeat(32);
export const SYNTHETIC_ZONE = 'f'.repeat(32);
/** A value no response field may carry into a document, a view or a log. */
export const SENTINEL_VALUE = 'synthetic-plain-text-value-should-never-be-kept';

export interface LiveTweaks {
  /** Workers that exist live but not in the desired state, and desired ones that are gone. */
  readonly extraScripts?: readonly string[];
  readonly dropScripts?: readonly string[];
  readonly extraDomains?: readonly { readonly hostname: string; readonly service: string }[];
  readonly dropDomains?: readonly string[];
  readonly routes?: readonly { readonly pattern: string; readonly script?: string }[];
  /** Script -> its live crons (replacing the desired ones). */
  readonly crons?: Readonly<Record<string, readonly string[]>>;
  /** Script -> binding -> live type, or null to remove the binding. */
  readonly bindings?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  readonly workersDev?: Readonly<Record<string, boolean>>;
  /** Audit log entries, as `{context, action, product, type}`; the fake answers them whatever the query asks. */
  readonly audit?: readonly AuditEntry[];
  /** Answers a matching path with this HTTP status instead. */
  readonly fail?: { readonly path: RegExp; readonly status: number };
}

export interface AuditEntry {
  readonly context: string;
  readonly action: string;
  readonly product?: string;
  readonly type?: string;
}

/** One audit log entry of the API's shape; the actor's address, IP and token name are the sentinel. */
export function auditEntry(entry: AuditEntry, index = 0): unknown {
  return {
    id: index.toString(16).padStart(32, '9'),
    account: { id: SYNTHETIC_ACCOUNT, name: SENTINEL_VALUE },
    action: { description: SENTINEL_VALUE, result: 'success', time: '2026-09-30T01:00:00Z', type: entry.action },
    actor: { id: 'a'.repeat(32), context: entry.context, email: `${SENTINEL_VALUE}@example.com`, ip_address: '192.0.2.1', token_id: 'b'.repeat(32), token_name: SENTINEL_VALUE, type: 'user' },
    raw: { cf_ray_id: 'c'.repeat(16), method: 'POST', status_code: 200, uri: `/${SENTINEL_VALUE}`, user_agent: SENTINEL_VALUE },
    resource: { id: SENTINEL_VALUE, product: entry.product ?? '', request: { value: SENTINEL_VALUE }, response: {}, scope: 'accounts', type: entry.type ?? null },
  };
}

const envelope = (result: unknown): Response => Response.json({ success: true, errors: [], messages: [], result });

/** The answer of the fake API to one GET, or null when `url` is not one of its paths. */
export function fakeCloudflare(url: string, tweaks: LiveTweaks, desired: DesiredState): Response | null {
  if (!url.startsWith(`${CF_API}/`)) return null;
  const path = url.slice(CF_API.length);
  if (tweaks.fail?.path.test(path) === true) return Response.json({ success: false, errors: [{ code: 10000, message: 'synthetic' }] }, { status: tweaks.fail.status });
  const dropped = new Set(tweaks.dropScripts ?? []);
  const scripts = [...Object.keys(desired.workers).filter((name) => !dropped.has(name)), ...(tweaks.extraScripts ?? [])];
  const account = `/accounts/${SYNTHETIC_ACCOUNT}/workers`;
  if (path === `${account}/scripts`) {
    return envelope(scripts.map((id, i) => ({ id, tag: i.toString(16).padStart(32, 'a'), etag: 'synthetic', handlers: ['fetch'], usage_model: 'standard' })));
  }
  if (path === `${account}/domains`) {
    const dropDomains = new Set(tweaks.dropDomains ?? []);
    const domains = Object.entries(desired.workers).flatMap(([service, worker]) => worker.custom_domains.map((hostname) => ({ hostname, service })));
    return envelope(
      [...domains.filter((d) => !dropDomains.has(d.hostname)), ...(tweaks.extraDomains ?? [])].map((d, i) => ({
        id: i.toString(16).padStart(32, 'b'),
        hostname: d.hostname,
        service: d.service,
        environment: 'production',
        zone_id: SYNTHETIC_ZONE,
        zone_name: desired.zones[0] ?? 'example.com',
        cert_id: 'c'.repeat(32),
      })),
    );
  }
  if (path.startsWith(`/accounts/${SYNTHETIC_ACCOUNT}/logs/audit?`)) {
    return envelope((tweaks.audit ?? []).map((entry, i) => auditEntry(entry, i)));
  }
  if (path === `/zones/${SYNTHETIC_ZONE}/workers/routes`) {
    return envelope((tweaks.routes ?? []).map((route, i) => ({ id: i.toString(16).padStart(32, 'd'), pattern: route.pattern, ...(route.script === undefined ? {} : { script: route.script }) })));
  }
  const match = new RegExp(`^${account}/scripts/([a-z0-9_-]+)/(schedules|settings|subdomain)$`).exec(path);
  const script = match?.[1];
  const worker = script === undefined || !scripts.includes(script) ? undefined : desired.workers[script];
  if (match === null || script === undefined) return null;
  if (match[2] === 'schedules') {
    const crons = tweaks.crons?.[script] ?? worker?.crons ?? [];
    return envelope({ schedules: crons.map((cron) => ({ cron, created_on: '2026-09-01T00:00:00Z', modified_on: '2026-09-01T00:00:00Z' })) });
  }
  if (match[2] === 'subdomain') {
    return envelope({ enabled: tweaks.workersDev?.[script] ?? worker?.workers_dev ?? false, previews_enabled: worker?.preview_urls ?? false });
  }
  const types = new Map((worker?.bindings ?? []).map((b) => [b.name, b.optional === true ? null : b.type]));
  // A personal value (a wrapper --var of a personal kind) lives as a secret: the wanted end state.
  if (worker !== undefined) for (const name of worker.personal) if (types.get(name) != null) types.set(name, 'secret_text');
  for (const [name, type] of Object.entries(tweaks.bindings?.[script] ?? {})) types.set(name, type);
  const bindings = [...types].flatMap(([name, type]) =>
    type === null ? [] : [type === 'plain_text' ? { name, type, text: SENTINEL_VALUE } : type === 'secret_text' ? { name, type } : { name, type, id: 'e'.repeat(32) }],
  );
  return envelope({ bindings, compatibility_date: '2026-09-08', compatibility_flags: [], usage_model: 'standard', tags: [], tail_consumers: [], logpush: false, placement: {} });
}
