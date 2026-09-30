import opsReadme from '../../../contracts/ops-v1/README.md?raw';
import { describe, expect, it } from 'vitest';
import { ICON_KEYS, MAX_OUTBOUND_PER_TICK, V2_BODY_BUDGET, type EntryDef, type FlowDef, type Registry, type ResourceDef } from '../src/api-v2-types.ts';
import {
  REGISTRY,
  entryOfScript,
  flowsOfScript,
  outboundPerRefresh,
  outboundPerTick,
  registryBody,
  registryView,
  resourceByMatch,
  validateRegistry,
} from '../src/registry.ts';

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
  const both = row('both');
  return { 'mail-hero': [...both, ...row('Mail Hero')], todofy: [...both, ...row('Todofy')] };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };

function copy(): Mutable<Registry> {
  return structuredClone(REGISTRY) as Mutable<Registry>;
}

function entry(registry: Mutable<Registry>, id: string): Mutable<EntryDef> {
  const found = registry.entries.find((e) => e.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

function flow(registry: Mutable<Registry>, id: string): Mutable<FlowDef> {
  const found = registry.flows.find((f) => f.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

describe('the registry', () => {
  it('is valid, and places every signal code the contract documents', () => {
    const known = contractSignals();
    expect(known['mail-hero']).toContain('endpoint_blocked');
    expect(known.todofy).toContain('gemini_budget_80');
    expect(validateRegistry(REGISTRY, { knownSignals: known })).toEqual([]);
  });

  it('registers the entries of the design, in their groups and order', () => {
    const byGroup = (group: string) => REGISTRY.entries.filter((e) => e.group === group).sort((a, b) => a.order - b.order).map((e) => e.id);
    expect(byGroup('apps')).toEqual(['mail-hero', 'todofy', 'flowday', 'siyuan']);
    expect(byGroup('sites')).toEqual(['website']);
    expect(byGroup('services')).toEqual(['notion-publish', 'newsletter']);
    expect(byGroup('hidden')).toEqual(['home']);
    const status = Object.fromEntries(REGISTRY.entries.map((e) => [e.id, e.status.type]));
    expect(status).toEqual({
      'mail-hero': 'ops_v1',
      todofy: 'ops_v1',
      flowday: 'link_only',
      siyuan: 'link_only',
      website: 'public_http',
      'notion-publish': 'analytics',
      newsletter: 'none',
      home: 'self',
    });
  });

  it('maps scripts to entries and to the flows they take part in (many-to-many)', () => {
    expect(entryOfScript('todofy-core')).toBe('todofy');
    expect(entryOfScript('ziyixi-notion-publish')).toBe('notion-publish');
    expect(entryOfScript('ziyixi-website')).toBe('website');
    expect(entryOfScript('new-worker')).toBeUndefined();
    expect(flowsOfScript('mail-hero')).toEqual(['mail-to-task']);
    expect(flowsOfScript('todofy')).toEqual(['mail-to-task', 'daily-newsletter', 'ops-digest']);
    expect(flowsOfScript('todofy-core')).toEqual(['mail-to-task']);
    expect(flowsOfScript('home')).toEqual(['ops-digest']);
    expect(flowsOfScript('ziyixi-notion-publish')).toEqual(['site-publish']);
  });

  it('maps resources by their GraphQL identifier; TODO placeholders match nothing', () => {
    expect(resourceByMatch('r2', 'mail-hero-store')?.entry).toBe('mail-hero');
    expect(resourceByMatch('r2', 'todofy-backups')?.entry).toBe('todofy');
    expect(resourceByMatch('r2', 'someone-elses-bucket')).toBeUndefined();
    const placeholders = REGISTRY.resources.filter((r) => r.match === null);
    expect(placeholders.map((r) => r.id).sort()).toEqual(['home-state', 'mail-coordinator', 'mail-hero-backup', 'mail-hero-db', 'todofy-core-do', 'todofy-db']);
    for (const r of placeholders) expect(r.todo).toBeTruthy();
  });

  it('keeps the tick within the Workers Free subrequest budget', () => {
    // 2 status() + 1 probe + 1 GraphQL + 2 setGuard + 2 canary calls + 1 reportOps.
    expect(outboundPerTick()).toBe(9);
    expect(outboundPerTick()).toBeLessThanOrEqual(MAX_OUTBOUND_PER_TICK);
    expect(outboundPerRefresh()).toBe(3);
  });

  it('serves a public view without bindings or probe URLs, within its budget', () => {
    const body = registryBody('abc123');
    expect(body).toBe(JSON.stringify(registryView('abc123')));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(V2_BODY_BUDGET.registry);
    expect(body).not.toContain('MAIL_HERO');
    expect(body).not.toContain('build-info');
    expect(body).not.toContain('GitHub');
    const view = registryView('abc123');
    const flowday = view.entries.find((e) => e.id === 'flowday');
    expect(flowday).toMatchObject({ status_type: 'link_only', host: 'flowday.ziyixi.science', scripts: [] });
    expect(view.entries.find((e) => e.id === 'todofy')?.scripts).toEqual(['todofy', 'todofy-core']);
    expect(view.workers.find((w) => w.script === 'todofy')?.flows).toEqual(['mail-to-task', 'daily-newsletter', 'ops-digest']);
    for (const icon of view.entries.map((e) => e.icon)) expect(ICON_KEYS).toContain(icon);
  });
});

describe('validateRegistry', () => {
  const problems = (registry: Mutable<Registry>, knownSignals?: Record<string, string[]>) =>
    validateRegistry(registry, knownSignals === undefined ? {} : { knownSignals });

  it('rejects duplicate ids, unknown references and a script in two entries', () => {
    const r = copy();
    r.entries.push({ ...entry(r, 'flowday'), order: 9 });
    r.workers.push({ script: 'mail-hero', entry: 'todofy', role: '重复' });
    r.workers.push({ script: 'orphan', entry: 'nowhere', role: '未知' });
    const found = problems(r);
    expect(found).toContain('entry flowday: duplicate id');
    expect(found).toContain('worker mail-hero: belongs to more than one entry');
    expect(found).toContain('worker orphan: unknown entry nowhere');
  });

  it('accepts only https URLs of the owner zone without query, port or userinfo', () => {
    for (const [url, problem] of [
      ['http://flowday.ziyixi.science/', 'not https'],
      ['https://flowday.ziyixi.science/x', 'path must be /'],
      ['https://flowday.ziyixi.science/?a=1', 'query or fragment'],
      ['https://user@flowday.ziyixi.science/', 'userinfo'],
      ['https://flowday.ziyixi.science:8443/', 'explicit port'],
      ['https://example.com/', 'host outside ziyixi.science'],
      ['https://192.0.2.1/', 'host is not a lowercase domain'],
    ] as const) {
      const r = copy();
      entry(r, 'flowday').url = url;
      expect(problems(r).some((p) => p.startsWith('entry flowday url') && p.includes(problem)), url).toBe(true);
    }
  });

  it('refuses anything that looks private', () => {
    for (const text of ['owner@example.com 的站点', '在 10.0.0.2 上', 'localhost 服务', '需要 token', '0123456789abcdef0123456789abcdef']) {
      const r = copy();
      entry(r, 'newsletter').description = text;
      expect(problems(r).some((p) => p.startsWith('privacy:')), text).toBe(true);
    }
  });

  it('checks status sources against kinds, workers and Access', () => {
    const r = copy();
    entry(r, 'flowday').status = { type: 'public_http', url: 'https://flowday.ziyixi.science/', expect: [200], enabled: true };
    entry(r, 'newsletter').status = { type: 'analytics', max_idle_hours: 26 };
    entry(r, 'siyuan').tile_metric = { kind: 'latency' };
    const found = problems(r);
    expect(found).toContain('entry flowday: an Access-protected host cannot be probed publicly');
    expect(found).toContain('entry newsletter: analytics needs a worker');
    expect(found).toContain('entry siyuan: tile_metric latency does not fit status link_only');
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
    flow(r, 'site-publish').stages[1] = { id: 'publish', name: '发布', entry: 'notion-publish', signals: ['parse_failed'] };
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
    const backup = r.resources.find((x) => x.id === 'mail-hero-backup') as Mutable<ResourceDef>;
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
