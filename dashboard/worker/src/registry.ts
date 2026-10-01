/**
 * The registry (docs/design-v2.md §3): what the dashboard shows, compiled into the Worker. Three
 * independent lists joined by id — entries (tiles), workers and resources (what Cloudflare measures),
 * flows (ordered stages across entries) — so one Worker can serve several flows and one flow can span
 * several Workers. The UI never imports this file: it receives the public view from
 * `GET /api/v2/registry`, so no hostname enters the UI bundle.
 *
 * Only public DNS names of the owner's zone may appear here; no address, email, token or account
 * identifier (test/registry.test.ts enforces it). The one exception is a D1 database UUID or DO
 * namespace ID in a resource's `match` (format-checked, never served by /api/v2/registry), which may be
 * filled in to name that row. Until then they stay `match: null` TODO placeholders: they match nothing,
 * and the account's row stays 未登记 with its raw ID.
 *
 * Adding a Worker (docs/design-v2.md §3.4): it appears in the Cloudflare table on its first request
 * without any change here; add a `workers` row (and an entry, if it is new) to name it, optionally a
 * flow stage and its resources, then run `npm test`.
 */
import {
  ACCENTS,
  API_V2_VERSION,
  ICON_KEYS,
  MAX_OUTBOUND_PER_REFRESH,
  MAX_OUTBOUND_PER_TICK,
  type EntryDef,
  type EntryGroupId,
  type FlowDef,
  type FlowGroupId,
  type GroupDef,
  type Registry,
  type RegistryResponse,
  type ResourceDef,
  type WorkerDef,
} from './api-v2-types.ts';

/** Every registry host is this zone or one of its subdomains. */
export const OWNER_ZONE = 'ziyixi.science';

const ENTRY_GROUPS: readonly GroupDef<EntryGroupId>[] = [
  { id: 'apps', name: '应用', order: 1 },
  { id: 'sites', name: '站点', order: 2 },
  { id: 'services', name: '后台服务', order: 3 },
  { id: 'hidden', name: '平台', order: 9 },
];

const FLOW_GROUPS: readonly GroupDef<FlowGroupId>[] = [
  { id: 'mail', name: '邮件与任务', order: 1 },
  { id: 'content', name: '内容与发布', order: 2 },
  { id: 'research', name: '研究', order: 3 },
  { id: 'platform', name: '平台', order: 4 },
];

const ENTRIES: readonly EntryDef[] = [
  {
    id: 'mail-hero',
    name: 'Mail Hero',
    description: '固定地址收件、归档与 webhook 投递',
    group: 'apps',
    icon: 'mail',
    accent: 'blue',
    url: 'https://mail-hero.ziyixi.science/',
    access: true,
    status: { type: 'ops_v1', binding: 'MAIL_HERO', guard: true },
    tile_metric: { kind: 'counter', name: 'ingest_today_messages' },
    app_only_signals: ['backup_stale', 'backup_active'],
    order: 1,
  },
  {
    id: 'todofy',
    name: 'Todofy',
    description: '邮件摘要、Todoist 任务与每日提醒',
    group: 'apps',
    icon: 'list-checks',
    accent: 'green',
    url: 'https://todofy.ziyixi.science/',
    access: true,
    status: { type: 'ops_v1', binding: 'TODOFY', guard: true },
    tile_metric: { kind: 'counter', name: 'received_24h' },
    app_only_signals: ['backup_stale', 'backup_failed', 'backup_disabled', 'backup_active'],
    order: 2,
  },
  {
    id: 'lab',
    name: '论文雷达',
    description: 'arXiv 每日推荐，划卡片挑论文',
    group: 'apps',
    icon: 'flask-conical',
    accent: 'violet',
    url: 'https://lab.ziyixi.science/',
    access: true,
    status: { type: 'ops_v1', binding: 'LAB', guard: true },
    tile_metric: { kind: 'counter', name: 'liked_7d' },
    // Lab has no maintenance switch; the code is listed for every app in ops-v1 and never raised by Lab.
    app_only_signals: ['maintenance_mode'],
    // After the synthetic link-only test entry's order 3 (test/v2-fixtures.ts).
    order: 4,
  },
  {
    id: 'website',
    name: '个人网站',
    description: 'ziyixi.science，内容来自 Notion',
    group: 'sites',
    icon: 'globe',
    accent: 'violet',
    // www, not the apex: Chrome reuses an apex connection for other subdomains when the certificate it got
    // covered them, and Cloudflare answers those requests 403 once the apex's certificate changes (each new
    // Workers custom domain's certificate also lists the apex). The apex only redirects to www anyway.
    url: 'https://www.ziyixi.science/',
    access: false,
    // Q6: one public GET per tick. The apex answers 308 to www, so the probe asks www's small JSON
    // build file directly (200 on 2026-09-29); status code and latency only, the body is never read.
    // Set enabled: false to show 未接入 instead. The site's own Worker (website/, `ziyixi-website`) is
    // assets-only: asset requests are not Worker invocations, so analytics cannot judge it and the
    // probe stays its status source (build-info.json is in the static export too, website/docs).
    status: { type: 'public_http', url: 'https://www.ziyixi.science/build-info.json', expect: [200], enabled: true },
    tile_metric: { kind: 'latency' },
    app_only_signals: [],
    order: 1,
  },
  {
    id: 'notion-publish',
    name: 'Notion 发布',
    description: '把 Notion 内容发布到网站',
    group: 'services',
    icon: 'upload-cloud',
    accent: 'slate',
    url: null,
    access: false,
    // Q13 default: no request for 26 h → 需关注 (its real schedule is still to be confirmed).
    status: { type: 'analytics', max_idle_hours: 26 },
    tile_metric: { kind: 'last_active' },
    app_only_signals: [],
    order: 1,
  },
  {
    id: 'newsletter',
    name: 'Newsletter',
    description: '家中服务器；每日读取 Todofy 报告写入 Notion',
    group: 'services',
    icon: 'newspaper',
    accent: 'amber',
    url: null,
    access: false,
    // Q7: 未接入 until Todofy offers a "last fetched" counter (a later, separate change).
    status: { type: 'none' },
    tile_metric: null,
    app_only_signals: [],
    order: 2,
  },
  {
    id: 'home',
    name: '个人控制台',
    description: '本页面：巡检、用量、金丝雀与摘要',
    group: 'hidden',
    icon: 'gauge',
    accent: 'slate',
    // Q11: no tile; it has a row in the Cloudflare table and tick_stale still reaches the strip.
    url: null,
    access: true,
    status: { type: 'self' },
    tile_metric: null,
    app_only_signals: [],
    order: 1,
  },
  {
    // Not a monorepo app: the self-hosted VPS and home server keep their backups in the account's R2
    // (bucket vultr-backup). A resource needs an entry, so this hidden one exists only to name that
    // bucket's row; no tile, no Worker, nothing probed.
    id: 'self-hosted',
    name: '自托管服务器',
    description: 'VPS 与家中服务器；只登记其 R2 备份桶，无磁贴',
    group: 'hidden',
    icon: 'server',
    accent: 'slate',
    url: null,
    access: false,
    status: { type: 'none' },
    tile_metric: null,
    app_only_signals: [],
    order: 2,
  },
];

const WORKERS: readonly WorkerDef[] = [
  { script: 'mail-hero', entry: 'mail-hero', role: '收件、投递与 UI' },
  { script: 'todofy', entry: 'todofy', role: '网关与 UI' },
  { script: 'todofy-core', entry: 'todofy', role: '处理核心（TodofyCore）' },
  { script: 'home', entry: 'home', role: '本面板' },
  { script: 'lab', entry: 'lab', role: '论文雷达与 UI' },
  { script: 'ziyixi-notion-publish', entry: 'notion-publish', role: '发布 Worker' },
  // website/wrangler.toml: static assets only, so it shows up in the table only if it ever runs code.
  { script: 'ziyixi-website', entry: 'website', role: '静态网站（仅静态资源）' },
];

const RESOURCES: readonly ResourceDef[] = [
  { id: 'mail-hero-db', kind: 'd1', name: 'mail-hero 主库', entry: 'mail-hero', match: '6c13e4c3-e239-42fb-a7a4-96810fa8d7dc' },
  { id: 'todofy-db', kind: 'd1', name: 'todofy 主库', entry: 'todofy', match: '151c1306-3885-4679-9592-08887b30ae68' },
  { id: 'mail-coordinator', kind: 'do', name: 'MailCoordinator', entry: 'mail-hero', script: 'mail-hero', match: '55c248f9d82c45f3a89d2de1d719d5db' },
  // Defined in todofy-core; the gateway `todofy` binds it by script_name.
  { id: 'todofy-core-do', kind: 'do', name: 'TodofyCore', entry: 'todofy', script: 'todofy-core', match: 'a013ef9fa45048d4b4f7bfcc641b57ea' },
  { id: 'home-state', kind: 'do', name: 'HomeState', entry: 'home', script: 'home', match: 'acddddf88d624194a68af430fd1a90ff' },
  { id: 'lab-db', kind: 'd1', name: 'lab 论文库', entry: 'lab', match: 'f20238dc-93a4-4d1a-91c4-c013f01cbdc9' },
  // Created by Lab's first deploy (2026-09-30).
  { id: 'lab-state', kind: 'do', name: 'LabState', entry: 'lab', script: 'lab', match: 'd8b315160669429781ba6229123cb33c' },
  // IDs read from the account's D1, Durable Object namespace and R2 bucket lists (2026-09-30).
  { id: 'mail-hero-store', kind: 'r2', name: 'mail-hero 邮件存储', entry: 'mail-hero', match: 'mail-hero-store' },
  { id: 'mail-hero-backup', kind: 'r2', name: 'mail-hero 备份', entry: 'mail-hero', match: 'mail-hero-backups' },
  { id: 'todofy-backups', kind: 'r2', name: 'todofy 备份', entry: 'todofy', match: 'todofy-backups' },
  // The self-hosted servers' backups (~790 MB on 2026-09-30), outside this repository.
  { id: 'vps-backup', kind: 'r2', name: 'VPS 备份', entry: 'self-hosted', match: 'vultr-backup' },
];

const FLOWS: readonly FlowDef[] = [
  {
    id: 'mail-to-task',
    name: '邮件 → 任务',
    group: 'mail',
    description: '来源邮箱转发的邮件经 Mail Hero 保存、解析、投递给 Todofy，生成摘要与 Todoist 任务。',
    order: 1,
    stages: [
      { id: 'forward', name: '来源转发', entry: null, signals: [], note: '来源邮箱的转发在面板之外' },
      {
        id: 'ingest',
        name: '收件与保存',
        entry: 'mail-hero',
        analytics: true,
        signals: ['maintenance_mode', 'ingest_quota_80', 'capacity_70', 'capacity_85', 'capacity_95'],
        counters: ['ingest_today_messages', 'capacity_used_bytes'],
      },
      {
        id: 'parse',
        name: '解析',
        entry: 'mail-hero',
        signals: ['parse_failed', 'pending_stale'],
        counters: ['jobs_pending', 'oldest_pending_age_seconds'],
      },
      {
        id: 'deliver',
        name: 'Webhook 投递',
        entry: 'mail-hero',
        signals: ['endpoint_blocked', 'endpoint_paused', 'delivery_failed', 'policy_error', 'force_send_paused', 'send_paused', 'forwarding_off'],
        hold_signals: ['endpoint_paused', 'force_send_paused', 'send_paused', 'forwarding_off'],
        counters: ['delivery_failed', 'blocked_waiting'],
      },
      {
        id: 'consume',
        name: 'Todofy 摘要',
        entry: 'todofy',
        workers: ['todofy', 'todofy-core'],
        analytics: true,
        signals: ['maintenance_mode', 'processing_paused', 'gemini_budget_80', 'gemini_budget_95', 'due_backlog'],
        hold_signals: ['processing_paused'],
        counters: ['received_24h', 'gemini_calls', 'active_events'],
      },
      {
        id: 'tasks',
        name: 'Todoist 与提醒',
        entry: 'todofy',
        workers: ['todofy-core'],
        signals: ['todoist_paused', 'todoist_blocked', 'attention', 'reminder_failed', 'reminder_disabled'],
        hold_signals: ['todoist_paused', 'reminder_disabled'],
        counters: ['attention_events', 'todoist_window_calls'],
      },
    ],
    canary: {
      id: 'mail-todofy',
      runner: 'mail_todofy_v1',
      stage_map: { delivery: 'deliver', consumer: 'consume' },
      fresh_hours: 30,
      scope_note: '由 Mail Hero 直接创建合成邮件，验证投递与 Todofy 处理；不经过来源转发、收件和解析，也不创建 Todoist 任务。',
    },
  },
  {
    // docs: todofy/docs/gtd-features.md §9. The GTD loop over what Todofy already measures: mail
    // arrives (收集), the daily Todoist snapshot counts the inbox, overdue work and still-open mail
    // tasks, and the Sunday review task closes the week. 理清 and 组织 stay manual in Todoist.
    id: 'gtd',
    name: 'GTD 循环',
    group: 'mail',
    description: '邮件成为 Todoist 任务后，每日快照计数、每周日生成回顾任务；理清与组织在 Todoist 中手动完成。',
    order: 2,
    stages: [
      { id: 'capture', name: '收集', entry: 'todofy', workers: ['todofy-core'], signals: [], counters: ['received_24h'] },
      {
        id: 'clarify',
        name: '理清',
        entry: 'todofy',
        workers: ['todofy-core'],
        signals: [],
        counters: ['inbox_open', 'inbox_oldest_days'],
        note: '标题仍是邮件主题；理清靠人工',
      },
      {
        id: 'organize',
        name: '组织',
        entry: 'todofy',
        workers: ['todofy-core'],
        signals: [],
        counters: ['overdue', 'carryover_open'],
        note: '在 Todoist 中手动整理',
      },
      {
        id: 'reflect',
        name: '回顾',
        entry: 'todofy',
        workers: ['todofy-core'],
        signals: ['review_overdue', 'gtd_snapshot_stale'],
        counters: ['review_age_days', 'completed_7d'],
      },
      { id: 'engage', name: '执行', entry: null, signals: [], note: '在 Todoist 中完成，面板之外' },
    ],
    canary: null,
  },
  {
    id: 'site-publish',
    name: '网站发布',
    group: 'content',
    description: 'Notion 内容经发布 Worker 上线到个人网站。',
    order: 1,
    stages: [
      { id: 'source', name: 'Notion', entry: null, signals: [], note: '内容源在面板之外' },
      { id: 'publish', name: '发布', entry: 'notion-publish', analytics: true, signals: [] },
      { id: 'serve', name: '网站可用', entry: 'website', signals: [] },
    ],
    canary: null,
  },
  {
    id: 'daily-newsletter',
    name: '每日 Newsletter',
    group: 'content',
    description: '家中服务器每天读取 Todofy 报告并写入 Notion。',
    order: 2,
    stages: [
      { id: 'report', name: 'Todofy 报告', entry: 'todofy', workers: ['todofy'], signals: [] },
      { id: 'fetch', name: '读取报告', entry: 'newsletter', signals: [], note: '等 Todofy 提供“最近读取时间”计数后接入' },
      { id: 'write', name: '写入 Notion', entry: null, signals: [], note: '在家中服务器和 Notion 上，面板看不到' },
    ],
    canary: null,
  },
  {
    id: 'paper-radar',
    name: '论文雷达',
    group: 'research',
    description: 'arXiv 每日公告经向量排序和中文简介做成卡片，喜欢的论文确认后交给 Todofy 创建任务。',
    order: 1,
    stages: [
      { id: 'source', name: 'arXiv', entry: null, signals: [], note: '公开 RSS，每天抓取一次' },
      { id: 'fetch', name: '抓取', entry: 'lab', analytics: true, signals: ['feed_stale'], counters: ['ingested_24h'] },
      { id: 'rank', name: '排序与简介', entry: 'lab', signals: ['neuron_cap_hit'], counters: ['ranked_24h', 'neurons_today'] },
      { id: 'deck', name: '卡片', entry: 'lab', signals: [], counters: ['liked_7d'] },
      { id: 'send', name: '交给 Todofy', entry: 'lab', signals: ['send_unsettled'] },
    ],
    canary: null,
  },
  {
    id: 'ops-digest',
    name: '运维摘要',
    group: 'platform',
    description: '面板汇总告警，经 Todofy 每日提醒送达。',
    order: 1,
    stages: [
      { id: 'collect', name: '巡检', entry: 'home', signals: [] },
      { id: 'report', name: '提交摘要', entry: 'todofy', workers: ['todofy'], signals: [] },
      {
        id: 'remind',
        name: '每日提醒',
        entry: 'todofy',
        workers: ['todofy'],
        signals: ['reminder_failed', 'reminder_disabled'],
        hold_signals: ['reminder_disabled'],
      },
    ],
    canary: null,
  },
];

export const REGISTRY: Registry = {
  entry_groups: ENTRY_GROUPS,
  flow_groups: FLOW_GROUPS,
  entries: ENTRIES,
  workers: WORKERS,
  resources: RESOURCES,
  flows: FLOWS,
};

/**
 * Signals every ops_v1 entry may emit that belong to the platform rather than a stage: reachability
 * (`status_unavailable`) and the guard (`guard_shed`), shown on the tile and in 操作与记录.
 */
export const PLATFORM_SIGNALS: readonly string[] = ['status_unavailable', 'guard_shed'];

// ---- lookups ----------------------------------------------------------------------------------------

export function entryById(id: string, registry: Registry = REGISTRY): EntryDef | undefined {
  return registry.entries.find((entry) => entry.id === id);
}

/** Script name → entry id, for the Worker table and the quota breakdowns; unknown → undefined (未登记). */
export function entryOfScript(script: string, registry: Registry = REGISTRY): string | undefined {
  return registry.workers.find((worker) => worker.script === script)?.entry;
}

/** The scripts a stage runs on: its `workers`, or all of its entry's workers. */
export function stageScripts(stage: FlowDef['stages'][number], registry: Registry = REGISTRY): readonly string[] {
  if (stage.entry === null) return [];
  return stage.workers ?? registry.workers.filter((worker) => worker.entry === stage.entry).map((worker) => worker.script);
}

/** Flow ids a script takes part in (the Worker table's flow tags), by group order then flow order. */
export function flowsOfScript(script: string, registry: Registry = REGISTRY): string[] {
  const groupOrder = (flow: FlowDef): number => registry.flow_groups.find((group) => group.id === flow.group)?.order ?? 99;
  return [...registry.flows]
    .sort((a, b) => groupOrder(a) - groupOrder(b) || a.order - b.order)
    .filter((flow) => flow.stages.some((stage) => stageScripts(stage, registry).includes(script)))
    .map((flow) => flow.id);
}

/** A GraphQL identifier (databaseId, namespaceId, bucketName) → its registry resource, if mapped. */
export function resourceByMatch(kind: ResourceDef['kind'], id: string, registry: Registry = REGISTRY): ResourceDef | undefined {
  return registry.resources.find((resource) => resource.kind === kind && resource.match !== null && resource.match === id);
}

/**
 * Outbound calls of one tick computed from the registry (design-v2.md §5): status() per ops_v1 entry,
 * one GET per enabled public_http probe, the GraphQL query, setGuard per guarded entry, two canary
 * calls per canary and one reportOps.
 */
export function outboundPerTick(registry: Registry = REGISTRY): number {
  const ops = registry.entries.filter((entry) => entry.status.type === 'ops_v1');
  const guarded = ops.filter((entry) => entry.status.type === 'ops_v1' && entry.status.guard);
  const canaries = registry.flows.filter((flow) => flow.canary !== null).length;
  return ops.length + probeCount(registry) + 1 + guarded.length + 2 * canaries + 1;
}

/** Outbound calls of one owner refresh: status() and probes of /home, or the GraphQL of /cloudflare. */
export function outboundPerRefresh(registry: Registry = REGISTRY): number {
  const ops = registry.entries.filter((entry) => entry.status.type === 'ops_v1').length;
  return Math.max(ops + probeCount(registry), 1);
}

function probeCount(registry: Registry): number {
  return registry.entries.filter((entry) => entry.status.type === 'public_http' && entry.status.enabled).length;
}

// ---- the public view --------------------------------------------------------------------------------

function hostOf(url: string | null): string | null {
  return url === null ? null : new URL(url).hostname;
}

/** The body of GET /api/v2/registry; no binding names or probe URLs. */
export function registryView(build: string, registry: Registry = REGISTRY): RegistryResponse {
  return {
    version: API_V2_VERSION,
    build,
    entry_groups: registry.entry_groups,
    flow_groups: registry.flow_groups,
    entries: registry.entries.map(({ status, ...entry }) => ({
      ...entry,
      status_type: status.type,
      host: hostOf(entry.url),
      scripts: registry.workers.filter((worker) => worker.entry === entry.id).map((worker) => worker.script),
    })),
    workers: registry.workers.map((worker) => ({ ...worker, flows: flowsOfScript(worker.script, registry) })),
    resources: registry.resources.map(({ id, kind, name, entry, script }) => (script === undefined ? { id, kind, name, entry } : { id, kind, name, entry, script })),
    flows: registry.flows,
  };
}

const serialized = new Map<string, string>();

/** registryView serialized once per build per isolate (the handler only passes the string through). */
export function registryBody(build: string): string {
  let body = serialized.get(build);
  if (body === undefined) {
    body = JSON.stringify(registryView(build));
    serialized.set(build, body);
  }
  return body;
}

// ---- validation (test/registry.test.ts) ----------------------------------------------------------------

const ENTRY_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const STAGE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
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
    for (const code of entry.app_only_signals) add(CODE.test(code), `${where}: app_only_signals code ${code}`);
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
        (metric.kind === 'counter' && status.type === 'ops_v1' && CODE.test(metric.name)) ||
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
      for (const code of [...signals, ...(stage.counters ?? [])]) add(CODE.test(code), `${at}: code ${code}`);
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
