/**
 * The registry's validation (test/registry.test.ts): every problem of a registry as one line each. Kept apart from
 * registry.ts, which the UI's tests import as data, because it checks the ops-v1 codes the registry names with the
 * contract's own `Code` format (the IDL through ops-client.ts), and the UI has no business importing that.
 */
import { ACCENTS, ICON_KEYS, MAX_OUTBOUND_PER_REFRESH, MAX_OUTBOUND_PER_TICK, type Registry } from './api-v2-types.ts';
import { isOpsCode } from './ops-client.ts';
import { OWNER_ZONE, PLATFORM_SIGNALS, outboundPerRefresh, outboundPerTick, stageScripts } from './registry.ts';

const ENTRY_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const STAGE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BINDING = /^[A-Z][A-Z0-9_]{1,31}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** What must never appear anywhere in the registry (privacy rule). */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['IPv6 address', /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i],
  ['localhost', /localhost/i],
  ['credential word', /token|secret|password|passwd|api[_-]?key|key=/i],
  ['account-like identifier', /\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
];

function httpsProblems(where: string, value: string, pathRule: 'root' | 'path'): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${where}: not a URL`];
  }
  const problems: string[] = [];
  if (url.protocol !== 'https:') problems.push(`${where}: not https`);
  if (url.username !== '' || url.password !== '') problems.push(`${where}: userinfo`);
  if (url.port !== '') problems.push(`${where}: explicit port`);
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) problems.push(`${where}: query or fragment`);
  if (!HOST.test(url.hostname)) problems.push(`${where}: host is not a lowercase domain`);
  if (url.hostname !== OWNER_ZONE && !url.hostname.endsWith(`.${OWNER_ZONE}`)) problems.push(`${where}: host outside ${OWNER_ZONE}`);
  if (pathRule === 'root' && url.pathname !== '/') problems.push(`${where}: path must be /`);
  if (pathRule === 'path' && !/^\/[a-z0-9._/-]*$/.test(url.pathname)) problems.push(`${where}: path`);
  if (url.href !== value) problems.push(`${where}: not in canonical form (${url.href})`);
  return problems;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const value of values) (seen.has(value) ? dup : seen).add(value);
  return [...dup];
}

export interface ValidationOptions {
  /** Every signal code each ops_v1 entry is known to emit (contracts/ops-v1/README.md "Signal codes"). */
  readonly knownSignals?: Readonly<Record<string, readonly string[]>>;
}

/** Every problem of `registry` as one line each; empty when it is valid. */
export function validateRegistry(registry: Registry, options: ValidationOptions = {}): string[] {
  const problems: string[] = [];
  const add = (condition: boolean, problem: string): void => {
    if (!condition) problems.push(problem);
  };

  // Groups.
  for (const [kind, groups] of [['entry group', registry.entry_groups], ['flow group', registry.flow_groups]] as const) {
    for (const id of duplicates(groups.map((g) => g.id))) problems.push(`${kind} ${id}: duplicate id`);
    for (const group of groups) add(group.name.length >= 1 && group.name.length <= 12, `${kind} ${group.id}: name length`);
  }
  const entryGroups = new Set<string>(registry.entry_groups.map((g) => g.id));
  const flowGroups = new Set<string>(registry.flow_groups.map((g) => g.id));

  // Entries.
  const entries = new Map(registry.entries.map((entry) => [entry.id, entry]));
  for (const id of duplicates(registry.entries.map((e) => e.id))) problems.push(`entry ${id}: duplicate id`);
  for (const group of entryGroups) {
    const orders = registry.entries.filter((e) => e.group === group).map((e) => String(e.order));
    for (const order of duplicates(orders)) problems.push(`entry group ${group}: duplicate order ${order}`);
  }
  const bindings: string[] = [];
  for (const entry of registry.entries) {
    const where = `entry ${entry.id}`;
    const scripts = registry.workers.filter((w) => w.entry === entry.id);
    add(ENTRY_ID.test(entry.id), `${where}: id pattern`);
    add(entry.name.length >= 1 && entry.name.length <= 16, `${where}: name length`);
    add(entry.description.length >= 1 && entry.description.length <= 40, `${where}: description length`);
    add(entryGroups.has(entry.group), `${where}: unknown group ${entry.group}`);
    add((ICON_KEYS as readonly string[]).includes(entry.icon), `${where}: unknown icon ${entry.icon}`);
    add((ACCENTS as readonly string[]).includes(entry.accent), `${where}: unknown accent ${entry.accent}`);
    if (entry.url !== null) problems.push(...httpsProblems(`${where} url`, entry.url, 'root'));
    // A launcher tile opens something; only background services and the hidden group may lack a URL.
    if (entry.group === 'apps' || entry.group === 'sites') add(entry.url !== null, `${where}: a tile needs a url`);
    for (const code of entry.app_only_signals) add(isOpsCode(code), `${where}: app_only_signals code ${code}`);
    const status = entry.status;
    switch (status.type) {
      case 'ops_v1':
        bindings.push(status.binding);
        // The type allows only the two bindings env.ts declares; the pattern guards a future widening.
        add(BINDING.test(status.binding), `${where}: binding name`);
        add(scripts.length > 0, `${where}: ops_v1 needs a worker`);
        break;
      case 'public_http':
        problems.push(...httpsProblems(`${where} probe`, status.url, 'path'));
        add(!entry.access, `${where}: an Access-protected host cannot be probed publicly`);
        add(status.expect.length > 0 && status.expect.every((code) => Number.isInteger(code) && code >= 200 && code <= 399), `${where}: expect`);
        break;
      case 'analytics':
        add(scripts.length > 0, `${where}: analytics needs a worker`);
        add(Number.isInteger(status.max_idle_hours) && status.max_idle_hours >= 1 && status.max_idle_hours <= 24 * 14, `${where}: max_idle_hours`);
        break;
      case 'link_only':
        add(entry.url !== null, `${where}: link_only needs a url`);
        break;
      case 'self':
        add(entry.group === 'hidden', `${where}: self belongs to the hidden group`);
        break;
      case 'none':
        break;
    }
    if (status.type !== 'ops_v1') add(entry.app_only_signals.length === 0, `${where}: signals need an ops_v1 status`);
    const metric = entry.tile_metric;
    if (metric !== null) {
      const fits =
        (metric.kind === 'counter' && status.type === 'ops_v1' && isOpsCode(metric.name)) ||
        (metric.kind === 'latency' && status.type === 'public_http') ||
        (metric.kind === 'last_active' && scripts.length > 0);
      add(fits, `${where}: tile_metric ${metric.kind} does not fit status ${status.type}`);
    }
  }
  for (const binding of duplicates(bindings)) problems.push(`binding ${binding}: used twice`);

  // Workers.
  for (const script of duplicates(registry.workers.map((w) => w.script))) problems.push(`worker ${script}: belongs to more than one entry`);
  for (const worker of registry.workers) {
    add(SCRIPT.test(worker.script), `worker ${worker.script}: script pattern`);
    add(entries.has(worker.entry), `worker ${worker.script}: unknown entry ${worker.entry}`);
    add(worker.role.length >= 1 && worker.role.length <= 24, `worker ${worker.script}: role length`);
  }
  const scriptEntry = new Map(registry.workers.map((w) => [w.script, w.entry]));

  // Resources.
  for (const id of duplicates(registry.resources.map((r) => r.id))) problems.push(`resource ${id}: duplicate id`);
  for (const match of duplicates(registry.resources.filter((r) => r.match !== null).map((r) => `${r.kind}:${r.match ?? ''}`))) {
    problems.push(`resource match ${match}: used twice`);
  }
  for (const resource of registry.resources) {
    const where = `resource ${resource.id}`;
    add(RESOURCE_ID.test(resource.id), `${where}: id pattern`);
    add(entries.has(resource.entry), `${where}: unknown entry ${resource.entry}`);
    add(resource.name.length >= 1 && resource.name.length <= 32, `${where}: name length`);
    if (resource.kind === 'do') {
      add(resource.script !== undefined && scriptEntry.get(resource.script) === resource.entry, `${where}: script must be a worker of its entry`);
    } else {
      add(resource.script === undefined, `${where}: only a DO names a script`);
    }
    if (resource.match === null) {
      add(resource.todo !== undefined && resource.todo.length > 0, `${where}: a TODO placeholder says where the identifier comes from`);
    } else if (resource.kind === 'r2') {
      add(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(resource.match), `${where}: bucket name`);
    } else if (resource.kind === 'd1') {
      add(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resource.match), `${where}: D1 UUID`);
    } else {
      add(/^[0-9a-f]{32}$/.test(resource.match), `${where}: namespace ID`);
    }
  }

  // Flows.
  for (const id of duplicates(registry.flows.map((f) => f.id))) problems.push(`flow ${id}: duplicate id`);
  const claimed = new Map<string, Set<string>>();
  for (const flow of registry.flows) {
    const where = `flow ${flow.id}`;
    add(ENTRY_ID.test(flow.id), `${where}: id pattern`);
    add(flowGroups.has(flow.group), `${where}: unknown group ${flow.group}`);
    add(flow.name.length >= 1 && flow.name.length <= 16, `${where}: name length`);
    add(flow.stages.length >= 2 && flow.stages.length <= 8, `${where}: 2 to 8 stages`);
    for (const id of duplicates(flow.stages.map((s) => s.id))) problems.push(`${where}: duplicate stage ${id}`);
    const inFlow = new Set<string>();
    for (const stage of flow.stages) {
      const at = `${where} stage ${stage.id}`;
      add(STAGE_ID.test(stage.id), `${at}: id pattern`);
      add(stage.name.length >= 1 && stage.name.length <= 12, `${at}: name length`);
      const entry = stage.entry === null ? null : entries.get(stage.entry);
      if (stage.entry !== null) add(entry !== undefined, `${at}: unknown entry ${stage.entry}`);
      const signals = stage.signals;
      const ops = entry?.status.type === 'ops_v1';
      if (!ops) {
        add(signals.length === 0 && (stage.counters ?? []).length === 0 && (stage.hold_signals ?? []).length === 0, `${at}: signals and counters need an ops_v1 entry`);
      }
      if (stage.entry === null || entry?.status.type === 'none' || entry?.status.type === 'link_only') {
        add(stage.note !== undefined && stage.note.length > 0, `${at}: an unmonitored stage says why (note)`);
      }
      for (const code of [...signals, ...(stage.counters ?? [])]) add(isOpsCode(code), `${at}: code ${code}`);
      for (const code of stage.hold_signals ?? []) add(signals.includes(code), `${at}: hold signal ${code} is not one of its signals`);
      for (const code of signals) {
        const key = `${stage.entry ?? ''}:${code}`;
        add(!inFlow.has(key), `${where}: ${key} claimed twice`);
        inFlow.add(key);
        if (stage.entry !== null) {
          const set = claimed.get(stage.entry) ?? new Set<string>();
          set.add(code);
          claimed.set(stage.entry, set);
        }
      }
      if (stage.workers !== undefined) {
        add(stage.entry !== null && stage.workers.length > 0, `${at}: workers need an entry`);
        for (const script of stage.workers) add(scriptEntry.get(script) === stage.entry, `${at}: worker ${script} is not a worker of ${stage.entry ?? 'null'}`);
      }
      if (stage.analytics === true) add(stageScripts(stage, registry).length > 0, `${at}: analytics needs workers`);
    }
    if (flow.canary !== null) {
      const ids = flow.stages.map((s) => s.id);
      add(ids.includes(flow.canary.stage_map.delivery) && ids.includes(flow.canary.stage_map.consumer), `${where}: canary stage_map`);
      add(flow.canary.fresh_hours >= 1 && flow.canary.fresh_hours <= 72, `${where}: canary fresh_hours`);
      add(flow.canary.scope_note.length > 0, `${where}: canary scope_note`);
    }
  }
  for (const id of duplicates(registry.flows.filter((f) => f.canary !== null).map((f) => f.canary?.id ?? ''))) problems.push(`canary ${id}: bound twice`);

  // Every known signal of an ops_v1 entry is placed: a stage, the entry's detail, or the platform.
  for (const [entryId, codes] of Object.entries(options.knownSignals ?? {})) {
    const entry = entries.get(entryId);
    if (entry === undefined) {
      problems.push(`knownSignals: unknown entry ${entryId}`);
      continue;
    }
    for (const code of codes) {
      const placed = claimed.get(entryId)?.has(code) === true || entry.app_only_signals.includes(code) || PLATFORM_SIGNALS.includes(code);
      add(placed, `entry ${entryId}: signal ${code} is claimed by no stage (add it to a stage or app_only_signals)`);
    }
  }
  for (const entry of registry.entries) {
    for (const code of entry.app_only_signals) add(claimed.get(entry.id)?.has(code) !== true, `entry ${entry.id}: ${code} is both app-only and claimed`);
  }

  // Budgets (Workers Free: 50 subrequests per invocation).
  add(outboundPerTick(registry) <= MAX_OUTBOUND_PER_TICK, `budget: ${String(outboundPerTick(registry))} outbound calls per tick > ${String(MAX_OUTBOUND_PER_TICK)}`);
  add(outboundPerRefresh(registry) <= MAX_OUTBOUND_PER_REFRESH, `budget: outbound calls per refresh > ${String(MAX_OUTBOUND_PER_REFRESH)}`);

  // Privacy: nothing that looks like an address, a credential or an account identifier. A D1 or DO
  // resource's `match` is such an identifier by design (checked by its format above, never served:
  // the public registry drops `match`), so only that field is left out of the scan.
  const scanned = { ...registry, resources: registry.resources.map((resource) => (resource.kind === 'r2' ? resource : { ...resource, match: null })) };
  const text = JSON.stringify(scanned);
  for (const [name, pattern] of FORBIDDEN) add(!pattern.test(text), `privacy: the registry contains a ${name}`);

  return problems;
}
