import inventory from '../src/account-inventory.json';
import opsReadme from '../../../contracts/ops-v1/README.md?raw';
import { describe, expect, it } from 'vitest';
import { MAX_OUTBOUND_PER_TICK, VIEW_BODY_BUDGET } from '../src/api-types.ts';
import type { EntryDef, FlowDef, RegistryDef, ResourceDef } from '../src/registry-types.ts';
import { ICON_KEYS } from '../src/idl.ts';
import {
  REGISTRY,
  entryOfScript,
  flowsOfScript,
  outboundPerRefresh,
  outboundPerTick,
  registryBody,
  registryView,
  resourceByMatch,
} from '../src/registry.ts';
import { validateRegistry } from '../src/registry-check.ts';
import { LINK_ONLY_ENTRY, withLinkOnly } from './v2-fixtures.ts';
import { expectWire, VIEW_SCHEMAS } from './wire-conformance.ts';

/**
 * The signal codes each app documents in contracts/ops-v1/README.md ("Signal codes"), read from the
 * table itself so a new code in the contract fails here until a stage (or app_only_signals) places it.
 */
function contractSignals(): Record<string, string[]> {
  const table = opsReadme.split('Signal codes (severity):')[1] ?? '';
  const row = (label: string): string[] => {
    const line = table.split('\n').find((text) => text.startsWith(`| ${label} |`));
    if (line === undefined) throw new Error(`no "${label}" row in the ops-v1 signal table`);
    // Parentheses hold severities and metric names (`seconds_left`), not signal codes.
    return [...line.replace(/\([^)]*\)/g, '').matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1] as string);
  };
  const every = row('every app');
  return {
    'mail-hero': [...every, ...row('Mail Hero')],
    todofy: [...every, ...row('Todofy')],
    lab: [...every, ...row('Lab')],
    watch: [...every, ...row('watch')],
    fleet: row('Fleet'),
    newsletter: row('Newsletter'),
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };

/** A mutable copy of the registry plus the synthetic link-only entry `link-demo`. */
function copy(): Mutable<RegistryDef> {
  return structuredClone(withLinkOnly()) as Mutable<RegistryDef>;
}

function entry(registry: Mutable<RegistryDef>, id: string): Mutable<EntryDef> {
  const found = registry.entries.find((e) => e.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

/** Drops the workers of an entry (to test the rules that need one). */
function withoutWorkers(registry: Mutable<RegistryDef>, id: string): void {
  registry.workers = registry.workers.filter((worker) => worker.entry !== id);
}

function flow(registry: Mutable<RegistryDef>, id: string): Mutable<FlowDef> {
  const found = registry.flows.find((f) => f.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

describe('the registry', () => {
  it('is valid, and places every signal code the contract documents', () => {
    const known = contractSignals();
    expect(known['mail-hero']).toContain('endpoint_blocked');
    expect(known.todofy).toContain('gemini_budget_80');
    expect(known.lab).toContain('send_unsettled');
    expect(known.watch).toContain('notify_unsettled');
    expect(validateRegistry(REGISTRY, { knownSignals: known })).toEqual([]);
  });

  it('registers the entries of the design, in their groups and order', () => {
    const byGroup = (group: string) => REGISTRY.entries.filter((e) => e.group === group).sort((a, b) => a.order - b.order).map((e) => e.id);
    expect(byGroup('apps')).toEqual(['mail-hero', 'todofy', 'lab', 'flowday', 'links', 'watch', 'fleet']);
    expect(byGroup('sites')).toEqual(['website']);
    expect(byGroup('services')).toEqual(['notion-publish', 'newsletter']);
    expect(byGroup('hidden')).toEqual(['home', 'self-hosted', 'platform-runtime']);
    const status = Object.fromEntries(REGISTRY.entries.map((e) => [e.id, e.status.type]));
    expect(status).toEqual({
      'mail-hero': 'ops_v1',
      todofy: 'ops_v1',
      lab: 'ops_v1',
      flowday: 'public_http',
      links: 'public_http',
      watch: 'ops_v1',
      website: 'public_http',
      'notion-publish': 'ops_v1',
      newsletter: 'ops_v1',
      fleet: 'ops_v1',
      home: 'self',
      'self-hosted': 'none',
      'platform-runtime': 'none',
    });
  });

  it('gives no tile with a health level an accent that reads as a status colour', () => {
    // design-v2 §7: status colours only inside shape + word marks. Rose's chip next to ● 正常 reads as ■ 故障.
    const judged = REGISTRY.entries.filter((e) => e.group !== 'hidden' && e.status.type !== 'none' && e.status.type !== 'link_only');
    expect(judged.map((e) => e.id)).toEqual(expect.arrayContaining(['links', 'watch']));
    for (const e of judged) expect(e.accent, e.id).not.toBe('rose');
    expect(REGISTRY.entries.find((e) => e.id === 'links')?.accent).toBe('slate');
  });

  it('maps scripts to entries and to the flows they take part in (many-to-many)', () => {
    expect(entryOfScript('todofy-core')).toBe('todofy');
    expect(entryOfScript('ziyixi-notion-publish')).toBe('notion-publish');
    expect(entryOfScript('ziyixi-website')).toBe('website');
    expect(entryOfScript('new-worker')).toBeUndefined();
    expect(flowsOfScript('mail-hero')).toEqual(['mail-to-task']);
    expect(flowsOfScript('todofy')).toEqual(['mail-to-task', 'daily-newsletter', 'ops-digest']);
    expect(flowsOfScript('todofy-core')).toEqual(['mail-to-task', 'gtd']);
    expect(flowsOfScript('lab')).toEqual(['paper-radar']);
    expect(flowsOfScript('watch')).toEqual(['web-watch']);
    expect(flowsOfScript('home')).toEqual(['ops-digest']);
    expect(flowsOfScript('ziyixi-notion-publish')).toEqual(['site-publish']);
  });

  it('maps every resource by its GraphQL identifier', () => {
    expect(resourceByMatch('r2', 'mail-hero-store')?.entry).toBe('mail-hero');
    expect(resourceByMatch('r2', 'todofy-backups')?.entry).toBe('todofy');
    expect(resourceByMatch('r2', 'mail-hero-backups')?.id).toBe('mail-hero-backup');
    expect(resourceByMatch('d1', '6c13e4c3-e239-42fb-a7a4-96810fa8d7dc')?.id).toBe('mail-hero-db');
    expect(resourceByMatch('d1', '151c1306-3885-4679-9592-08887b30ae68')?.id).toBe('todofy-db');
    expect(resourceByMatch('d1', 'f20238dc-93a4-4d1a-91c4-c013f01cbdc9')?.id).toBe('lab-db');
    expect(resourceByMatch('do', '55c248f9d82c45f3a89d2de1d719d5db')?.id).toBe('mail-coordinator');
    expect(resourceByMatch('do', 'a013ef9fa45048d4b4f7bfcc641b57ea')?.id).toBe('todofy-core-do');
    expect(resourceByMatch('do', 'acddddf88d624194a68af430fd1a90ff')?.id).toBe('home-state');
    expect(resourceByMatch('do', 'd8b315160669429781ba6229123cb33c')?.id).toBe('lab-state');
    // FlowDay and the links app: their Worker and D1 database, under their tiles (no flow takes part).
    expect(resourceByMatch('d1', '2f8c5331-06ce-4347-8c0a-90fe51c82260')).toMatchObject({ id: 'links-db', entry: 'links' });
    expect(resourceByMatch('d1', 'df104e83-7183-47e3-b2f9-638dc7502c13')).toMatchObject({ id: 'flowday-db', entry: 'flowday' });
    expect(entryOfScript('links')).toBe('links');
    expect(entryOfScript('flowday')).toBe('flowday');
    expect(flowsOfScript('links')).toEqual([]);
    expect(flowsOfScript('flowday')).toEqual([]);
    expect(resourceByMatch('r2', 'someone-elses-bucket')).toBeUndefined();
    // Not an app of the monorepo: the self-hosted servers' backups, named under a hidden entry.
    expect(resourceByMatch('r2', 'vultr-backup')).toMatchObject({ id: 'vps-backup', name: 'VPS 备份', entry: 'self-hosted' });
    expect(REGISTRY.entries.find((e) => e.id === 'self-hosted')).toMatchObject({ group: 'hidden', url: null, status: { type: 'none' } });
    expect(REGISTRY.workers.filter((w) => w.entry === 'self-hosted')).toEqual([]);
    // Fleet's new namespace is recorded in config/resources.toml after its first deploy.
    const unmatched = REGISTRY.resources.filter((r) => r.match === null).map((r) => r.id);
    expect(unmatched.filter((id) => id !== 'fleet-state')).toEqual([]);
    expect(REGISTRY.resources.find((r) => r.id === 'fleet-state')).toMatchObject({
      kind: 'do', entry: 'fleet', script: 'fleet',
    });
    expect(resourceByMatch('do', 'd58e1bdabacb4d14bbba1887f169c8b4')).toMatchObject({ id: 'watch-state', entry: 'watch' });
  });

  it('keeps the tick within the Workers Free subrequest budget', () => {
    // 7 status() + 3 probes (website, FlowDay, links) + 1 GraphQL + 4 setGuard + 2 canary calls + 1 reportOps + 12 drift calls.
    expect(outboundPerTick()).toBe(30);
    expect(outboundPerTick()).toBeLessThanOrEqual(MAX_OUTBOUND_PER_TICK);
    expect(outboundPerRefresh()).toBe(10);
  });

  it('serves a public view without bindings or probe URLs, within its budget', () => {
    const body = registryBody('abc123');
    expect(body).toBe(JSON.stringify(registryView('abc123')));
    expectWire(VIEW_SCHEMAS.registry, body);
    expectWire(VIEW_SCHEMAS.registry, registryView('abc123', withLinkOnly()));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(VIEW_BODY_BUDGET.registry);
    expect(body).not.toContain('MAIL_HERO');
    for (const probe of ['build-info', 'manifest.webmanifest', 'robots.txt', 'content_type', 'outside_access']) expect(body).not.toContain(probe);
    expect(body).not.toContain('GitHub');
    const view = registryView('abc123');
    expect(view.entries.find((e) => e.id === 'flowday')).toMatchObject({ status_type: 'public_http', host: 'flowday.ziyixi.science', access: true, scripts: ['flowday'] });
    expect(view.entries.find((e) => e.id === 'links')).toMatchObject({ url: 'https://s.ziyixi.science/_/', host: 's.ziyixi.science', access: true, scripts: ['links'] });
    const linkOnly = registryView('abc123', withLinkOnly()).entries.find((e) => e.id === LINK_ONLY_ENTRY.id);
    expect(linkOnly).toMatchObject({ status_type: 'link_only', host: 'link-demo.ziyixi.science', scripts: [] });
    expect(linkOnly).not.toHaveProperty('status');
    expect(view.entries.find((e) => e.id === 'todofy')?.scripts).toEqual(['todofy', 'todofy-core']);
    expect(view.workers.find((w) => w.script === 'todofy')?.flows).toEqual(['mail-to-task', 'daily-newsletter', 'ops-digest']);
    for (const icon of view.entries.map((e) => e.icon)) expect(ICON_KEYS).toContain(icon);
  });
});

describe('validateRegistry', () => {
  const problems = (registry: Mutable<RegistryDef>, knownSignals?: Record<string, string[]>) =>
    validateRegistry(registry, knownSignals === undefined ? {} : { knownSignals });

  it('accepts a link-only entry (the synthetic link-demo of these tests)', () => {
    expect(problems(copy())).toEqual([]);
  });

  it('rejects duplicate ids, unknown references and a script in two entries', () => {
    const r = copy();
    r.entries.push({ ...entry(r, 'link-demo'), order: 9 });
    r.workers.push({ script: 'mail-hero', entry: 'todofy', role: '重复' });
    r.workers.push({ script: 'orphan', entry: 'nowhere', role: '未知' });
    const found = problems(r);
    expect(found).toContain('entry link-demo: duplicate id');
    expect(found).toContain('worker mail-hero: belongs to more than one entry');
    expect(found).toContain('worker orphan: unknown entry nowhere');
  });

  it('accepts only https URLs of the owner zone without query, port or userinfo', () => {
    for (const [url, problem] of [
      ['http://link-demo.ziyixi.science/', 'not https'],
      ['https://link-demo.ziyixi.science/x', 'path must be / or a directory ending in /'],
      ['https://link-demo.ziyixi.science/_//', 'path must be / or a directory ending in /'],
      ['https://link-demo.ziyixi.science/?a=1', 'query or fragment'],
      ['https://user@link-demo.ziyixi.science/', 'userinfo'],
      ['https://link-demo.ziyixi.science:8443/', 'explicit port'],
      ['https://example.com/', 'host outside ziyixi.science'],
      ['https://192.0.2.1/', 'host is not a lowercase domain'],
    ] as const) {
      const r = copy();
      entry(r, 'link-demo').url = url;
      expect(problems(r).some((p) => p.startsWith('entry link-demo url') && p.includes(problem)), url).toBe(true);
    }
  });

  it('accepts a directory of the host as a tile link (the links launcher /_/)', () => {
    const r = copy();
    entry(r, 'link-demo').url = 'https://link-demo.ziyixi.science/_/';
    expect(problems(r)).toEqual([]);
  });

  it('refuses anything that looks private', () => {
    for (const text of ['owner@example.com 的站点', '在 10.0.0.2 上', 'localhost 服务', '需要 token', '0123456789abcdef0123456789abcdef']) {
      const r = copy();
      entry(r, 'newsletter').description = text;
      expect(problems(r).some((p) => p.startsWith('privacy:')), text).toBe(true);
    }
  });

  it('accepts real D1 and DO identifiers in `match`, and still refuses them anywhere else (C1)', () => {
    const r = copy();
    const d1 = r.resources.find((res) => res.id === 'mail-hero-db') as { match: string | null; todo?: string };
    const ns = r.resources.find((res) => res.id === 'home-state') as { match: string | null; todo?: string };
    d1.match = '8f14e45f-ceea-467a-9575-0123456789ab';
    delete d1.todo;
    ns.match = 'a'.repeat(32);
    delete ns.todo;
    expect(problems(r)).toEqual([]);
    // The same strings in a description are still an account-like identifier.
    for (const text of ['8f14e45f-ceea-467a-9575-0123456789ab', 'a'.repeat(32)]) {
      const leaked = copy();
      entry(leaked, 'newsletter').description = text;
      expect(problems(leaked)).toContain('privacy: the registry contains a account-like identifier');
    }
    // A malformed match is refused by its format check.
    const bad = copy();
    const badD1 = bad.resources.find((res) => res.id === 'mail-hero-db') as { match: string | null; todo?: string };
    badD1.match = 'not-a-uuid';
    expect(problems(bad)).toContain('resource mail-hero-db: D1 UUID');
  });

  it('checks status sources against kinds, workers and Access', () => {
    const r = copy();
    entry(r, 'link-demo').status = { type: 'public_http', url: 'https://link-demo.ziyixi.science/', expect: [200], enabled: true };
    entry(r, 'newsletter').status = { type: 'analytics', max_idle_hours: 26 };
    const found = problems(r);
    expect(found).toContain('entry link-demo: an Access-protected host cannot be probed publicly');
    expect(found).toContain('entry newsletter: analytics needs a worker');
    // Declaring the path outside Access (and the rest of what that needs) is what allows it.
    const exempt = copy();
    entry(exempt, 'link-demo').status = { type: 'public_http', url: 'https://link-demo.ziyixi.science/robots.txt', expect: [200], content_type: 'text/plain', outside_access: true, enabled: true };
    expect(problems(exempt).filter(problem => !problem.startsWith('budget:'))).toEqual([]);
    const linkOnly = copy();
    entry(linkOnly, 'link-demo').tile_metric = { kind: 'latency' };
    expect(problems(linkOnly)).toContain('entry link-demo: tile_metric latency does not fit status link_only');
  });

  it('allows a probe of an Access-protected host only where the login redirect can never pass as healthy', () => {
    type Probe = Extract<Mutable<EntryDef>['status'], { type: 'public_http' }>;
    const cases: [(probe: Probe) => void, string][] = [
      [(p) => delete p.content_type, 'entry flowday: a probe outside Access needs content_type'],
      [(p) => (p.expect = [200, 302]), 'entry flowday: a probe outside Access expects 2xx only'],
      [(p) => (p.url = 'https://flowday.ziyixi.science/'), 'entry flowday: a probe outside Access cannot be the Access-protected url'],
      [(p) => (p.url = 'https://elsewhere.ziyixi.science/pwa/manifest.webmanifest'), "entry flowday: a probe outside Access is on the entry's own host"],
      [(p) => delete p.outside_access, 'entry flowday: an Access-protected host cannot be probed publicly'],
      [(p) => (p.content_type = 'Application/JSON; charset=utf-8'), 'entry flowday: content_type is not a lowercase media type'],
    ];
    for (const [change, problem] of cases) {
      const r = copy();
      const probe = { ...(entry(r, 'flowday').status as Probe) };
      change(probe);
      entry(r, 'flowday').status = probe;
      expect(problems(r), problem).toContain(problem);
    }
    // A public host never claims to be outside Access, and error_rate needs Workers to judge.
    const site = copy();
    entry(site, 'website').status = { type: 'public_http', url: 'https://www.ziyixi.science/build-info.json', expect: [200], outside_access: true, error_rate: true, enabled: true };
    withoutWorkers(site, 'website');
    const found = problems(site);
    expect(found).toContain('entry website: outside_access is only for an Access-protected host');
    expect(found).toContain('entry website: error_rate needs a worker');
  });

  it('checks stages: entries, workers, holds, notes and each code once per flow', () => {
    const r = copy();
    const mail = flow(r, 'mail-to-task');
    const parse = mail.stages.find((s) => s.id === 'parse');
    const tasks = mail.stages.find((s) => s.id === 'tasks');
    const forward = mail.stages.find((s) => s.id === 'forward');
    if (parse === undefined || tasks === undefined || forward === undefined) throw new Error('stages');
    parse.signals = [...parse.signals, 'endpoint_blocked'];
    tasks.workers = ['mail-hero'];
    tasks.hold_signals = ['not_a_signal_here'];
    delete forward.note;
    flow(r, 'site-publish').stages[1] = { id: 'publish', name: '发布', entry: 'website', signals: ['parse_failed'] };
    const found = problems(r);
    expect(found).toContain('flow mail-to-task: mail-hero:endpoint_blocked claimed twice');
    expect(found).toContain('flow mail-to-task stage tasks: worker mail-hero is not a worker of todofy');
    expect(found).toContain('flow mail-to-task stage tasks: hold signal not_a_signal_here is not one of its signals');
    expect(found).toContain('flow mail-to-task stage forward: an unmonitored stage says why (note)');
    expect(found).toContain('flow site-publish stage publish: signals and counters need an ops_v1 entry');
  });

  it('fails when a documented signal is placed nowhere', () => {
    const known = contractSignals();
    const r = copy();
    const deliver = flow(r, 'mail-to-task').stages.find((s) => s.id === 'deliver');
    if (deliver === undefined) throw new Error('deliver');
    deliver.signals = deliver.signals.filter((code) => code !== 'policy_error');
    expect(problems(r, known)).toContain('entry mail-hero: signal policy_error is claimed by no stage (add it to a stage or app_only_signals)');
    expect(problems(copy(), { ...known, todofy: [...(known.todofy ?? []), 'brand_new_signal'] })).toContain(
      'entry todofy: signal brand_new_signal is claimed by no stage (add it to a stage or app_only_signals)',
    );
  });

  it('checks resources: owners, DO scripts, identifier shapes and TODO notes', () => {
    const r = copy();
    const d1 = r.resources.find((x) => x.id === 'mail-hero-db') as Mutable<ResourceDef>;
    d1.match = 'not-a-uuid';
    const home = r.resources.find((x) => x.id === 'home-state') as Mutable<ResourceDef>;
    home.script = 'todofy';
    // A placeholder without a note on where its identifier comes from is refused.
    const backup = r.resources.find((x) => x.id === 'mail-hero-backup') as Mutable<ResourceDef>;
    backup.match = null;
    delete backup.todo;
    const found = problems(r);
    expect(found).toContain('resource mail-hero-db: D1 UUID');
    expect(found).toContain('resource home-state: script must be a worker of its entry');
    expect(found).toContain('resource mail-hero-backup: a TODO placeholder says where the identifier comes from');
  });

  it('enforces the per-tick outbound budget', () => {
    const r = copy();
    for (let i = 0; i < 25; i++) {
      r.entries.push({ ...entry(r, 'website'), id: `site-${String(i)}`, order: 10 + i });
    }
    expect(problems(r).some((p) => p.startsWith('budget:'))).toBe(true);
  });
});

it('registers every configured account resource, including bootstrap state', () => {
  for (const kind of ['d1', 'do', 'r2'] as const) expect(REGISTRY.resources.filter(r => r.kind === kind).map(r => r.match).sort()).toEqual(inventory[kind]);
  expect(REGISTRY.workers.map(w => w.script).sort()).toEqual(inventory.workers);
});
