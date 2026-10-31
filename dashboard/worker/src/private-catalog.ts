/** Optional private registration. Values stay in Home's secret and the authenticated owner API. */
import { RegistrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb';
import { fromWire } from '@ziyixi/proto/wire-json';
import { DESIRED, type DesiredState } from './drift.ts';
import { validateRegistry } from './registry-check.ts';
import { OWNER_ZONE, REGISTRY, registryView } from './registry.ts';
import type { RegistryDef } from './registry-types.ts';

export const PRIVATE_CATALOG_MAX_BYTES = 32_768;
export const PRIVATE_CATALOG_ERROR = 'PRIVATE_CATALOG_INVALID';

export interface PrivateCatalog {
  readonly registry: Pick<RegistryDef, 'entries' | 'workers' | 'resources'>;
  readonly desired: DesiredState;
}

export interface HomeCatalog {
  readonly registry: RegistryDef;
  readonly desired: DesiredState;
}

function requireCatalog(valid: boolean): asserts valid {
  if (!valid) throw new Error(PRIVATE_CATALOG_ERROR);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  requireCatalog(record(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
}

function strings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && item.length <= 256)
    && new Set(value).size === value.length;
}

function ownerHost(host: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9-]+$/.test(host)
    && (host === OWNER_ZONE || host.endsWith(`.${OWNER_ZONE}`));
}

/** Validates the attachment before merging; diagnostics never contain supplied values. */
export function parsePrivateCatalog(raw: string): PrivateCatalog {
  try {
    requireCatalog(new TextEncoder().encode(raw).byteLength <= PRIVATE_CATALOG_MAX_BYTES);
    const value: unknown = JSON.parse(raw);
    fields(value, ['registry', 'desired']);
    fields(value.registry, ['entries', 'workers', 'resources']);
    const registration = value.registry;
    requireCatalog(Array.isArray(registration.entries) && registration.entries.length <= 8
      && Array.isArray(registration.workers) && registration.workers.length <= 8
      && Array.isArray(registration.resources) && registration.resources.length <= 24);
    for (const entry of registration.entries) {
      fields(entry, ['id', 'name', 'description', 'group', 'icon', 'accent', 'url', 'access', 'status', 'tile_metric', 'app_only_signals', 'order']);
      requireCatalog(typeof entry.id === 'string' && typeof entry.access === 'boolean' && Number.isInteger(entry.order));
      fields(entry.status, ['type'], ['enabled', 'url', 'expect', 'content_type', 'outside_access', 'error_rate']);
      const status = entry.status;
      requireCatalog(status.type === 'public_http' || status.type === 'link_only');
      if (status.type === 'link_only') requireCatalog(Object.keys(status).length === 1);
      else {
        requireCatalog(typeof status.enabled === 'boolean' && typeof status.url === 'string' && Array.isArray(status.expect));
        requireCatalog(status.outside_access === undefined || status.outside_access === true);
        requireCatalog(status.error_rate === undefined || status.error_rate === true);
      }
      requireCatalog(!REGISTRY.entries.some((publicEntry) => publicEntry.id === entry.id));
    }
    const entryIds = new Set(registration.entries.map((entry: Record<string, unknown>) => entry.id));
    for (const worker of registration.workers) {
      fields(worker, ['script', 'entry', 'role']);
      requireCatalog(entryIds.has(worker.entry) && !REGISTRY.workers.some((publicWorker) => publicWorker.script === worker.script));
    }
    for (const resource of registration.resources) {
      fields(resource, ['id', 'kind', 'name', 'entry', 'match'], ['script']);
      requireCatalog(entryIds.has(resource.entry) && resource.match !== null && ['d1', 'do', 'r2'].includes(String(resource.kind)));
      requireCatalog(!REGISTRY.resources.some((publicResource) => publicResource.id === resource.id
        || (publicResource.kind === resource.kind && publicResource.match === resource.match)));
    }
    fields(value.desired, ['version', 'zones', 'workers']);
    const desired = value.desired;
    requireCatalog(desired.version === DESIRED.version && strings(desired.zones, 1) && desired.zones.length === 1
      && desired.zones[0] === OWNER_ZONE && record(desired.workers));
    const scripts = registration.workers.map((worker: Record<string, unknown>) => worker.script);
    requireCatalog(Object.keys(desired.workers).length === scripts.length
      && Object.keys(desired.workers).every((script) => scripts.includes(script) && !Object.hasOwn(DESIRED.workers, script)));
    const publicHosts = new Set(Object.values(DESIRED.workers).flatMap((worker) => worker.custom_domains));
    const supplementalHosts: string[] = [];
    const supplementalRoutes: string[] = [];
    for (const worker of Object.values(desired.workers)) {
      fields(worker, ['config', 'workers_dev', 'preview_urls', 'custom_domains', 'routes', 'crons', 'bindings', 'personal']);
      requireCatalog(typeof worker.config === 'string' && /^[a-zA-Z0-9_./-]{1,256}$/.test(worker.config)
        && !worker.config.startsWith('/') && !worker.config.split('/').includes('..'));
      requireCatalog(worker.workers_dev === false && worker.preview_urls === false);
      requireCatalog(strings(worker.custom_domains, 8) && worker.custom_domains.every((host) => ownerHost(host) && !publicHosts.has(host)));
      requireCatalog(strings(worker.routes, 8) && worker.routes.every((route) => {
        const [host] = route.split('/');
        return host !== undefined && ownerHost(host) && !publicHosts.has(host)
          && /^[a-z0-9.-]+\/[a-z0-9._/*-]*$/.test(route);
      }));
      requireCatalog(strings(worker.crons, 10) && worker.crons.every((cron) => /^[0-9*,/ -]{9,128}$/.test(cron)));
      requireCatalog(strings(worker.personal, 100) && Array.isArray(worker.bindings) && worker.bindings.length <= 100);
      const names: string[] = [];
      for (const binding of worker.bindings) {
        fields(binding, ['name', 'type', 'source'], ['optional']);
        requireCatalog(typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(binding.name)
          && typeof binding.type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(binding.type)
          && ['config', 'deploy', 'manual'].includes(String(binding.source))
          && (binding.optional === undefined || typeof binding.optional === 'boolean'));
        names.push(binding.name);
      }
      requireCatalog(new Set(names).size === names.length && worker.personal.every((name) => names.includes(name)));
      supplementalHosts.push(...worker.custom_domains);
      supplementalRoutes.push(...worker.routes);
    }
    requireCatalog(new Set(supplementalHosts).size === supplementalHosts.length
      && new Set(supplementalRoutes).size === supplementalRoutes.length);
    const catalog = value as unknown as PrivateCatalog;
    const registry = mergeRegistry(catalog.registry);
    requireCatalog(validateRegistry(registry).length === 0);
    // Validate every owner-visible value against the existing IDL before any projection can expose it.
    requireCatalog(fromWire(RegistrySchema, registryView('dev', registry)).unrecognized.length === 0);
    return catalog;
  } catch {
    throw new Error(PRIVATE_CATALOG_ERROR);
  }
}

function mergeRegistry(extra: PrivateCatalog['registry']): RegistryDef {
  return { ...REGISTRY, entries: [...REGISTRY.entries, ...extra.entries], workers: [...REGISTRY.workers, ...extra.workers],
    resources: [...REGISTRY.resources, ...extra.resources] };
}

let cachedRaw: string | undefined;
let cachedCatalog: HomeCatalog | undefined;

/** Empty means the public catalog. A malformed nonempty attachment always refuses configuration. */
export function homeCatalog(raw?: string): HomeCatalog {
  if (raw === undefined || raw === '') return { registry: REGISTRY, desired: DESIRED };
  if (raw === cachedRaw && cachedCatalog !== undefined) return cachedCatalog;
  const extra = parsePrivateCatalog(raw);
  const catalog = { registry: mergeRegistry(extra.registry), desired: { ...DESIRED, workers: { ...DESIRED.workers, ...extra.desired.workers } } };
  cachedRaw = raw;
  cachedCatalog = catalog;
  return catalog;
}
