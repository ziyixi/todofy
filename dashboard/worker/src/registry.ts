/**
 * The registry (docs/design-v2.md §3): what the dashboard shows, compiled into the Worker. Three
 * independent lists joined by id — entries (tiles), workers and resources (what Cloudflare measures),
 * flows (ordered stages across entries) — so one Worker can serve several flows and one flow can span
 * several Workers. The UI never imports this file: it receives the public view from GetRegistry
 * (`GET /api/v1/registry`), so no hostname enters the UI bundle.
 *
 * Only public DNS names of the owner's zone may appear here; no address, email, token or account
 * identifier (test/registry.test.ts enforces it). The one exception is a D1 database UUID or DO
 * namespace ID in a resource's `match` (format-checked, never served by GetRegistry, `GET /api/v1/registry`), which may be
 * filled in to name that row. Until then they stay `match: null` TODO placeholders: they match nothing,
 * and the account's row stays 未登记 with its raw ID.
 *
 * Adding a Worker (docs/design-v2.md §3.4): it appears in the Cloudflare table on its first request
 * without any change here; add a `workers` row (and an entry, if it is new) to name it, optionally a
 * flow stage and its resources, then run `npm test`.
 *
 * Adding an app's tile (docs/design-v2.md §3): one `entries` row in `apps`, its `workers` rows and its resources.
 * Its status source is `ops_v1` when the app has an Ops entrypoint the dashboard binds (a binding in env.ts and
 * wrangler.toml), else a `public_http` probe of a path its own Worker answers outside Access (`outside_access`,
 * `content_type`). `.github/scripts/test_wrangler_configs.py` fails until every production Worker and D1 database
 * is registered here, and until every production Worker with a Custom Domain maps to an `apps` or `sites` entry
 * whose url is on one of its hosts (only `home` is exempt), so a newly deployed app cannot stay off the dashboard.
 */
import { DRIFT_CALLS_PER_TICK, type EntryGroup, type FlowGroup, type Registry, type RegistryEntry, type Stage, type TileMetricDef } from './api-types.ts';
import type { EntryDef, FlowDef, RegistryDef, ResourceDef, WorkerDef } from './registry-types.ts';

/** Every registry host is this zone or one of its subdomains. */
export const OWNER_ZONE = 'ziyixi.science';

const ENTRY_GROUPS: readonly EntryGroup[] = [
  { id: 'apps', name: '应用', order: 1 },
  { id: 'sites', name: '站点', order: 2 },
  { id: 'services', name: '后台服务', order: 3 },
  { id: 'hidden', name: '平台', order: 9 },
];

const FLOW_GROUPS: readonly FlowGroup[] = [
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
    // FlowDay (flowday/, the Worker `flowday` and its D1 database since the F4 cutover). The whole host is behind the
    // Access app "flowday" except its exact PWA files: the app "flowday-bypass" covers /pwa/* and the Worker serves the
    // manifest itself, as application/manifest+json (flowday/worker/src/assets.ts). So one anonymous GET of the manifest
    // per tick reaches the Worker and its static assets with no D1 read; Access's login redirect can never pass (2xx and
    // the media type are required). F6 may remove "flowday-bypass" (flowday/docs/design.md §11): that change must move
    // this probe first, which test_infra_config.py enforces.
    id: 'flowday',
    name: 'FlowDay',
    description: 'Todoist 时间块、计时与回顾',
    group: 'apps',
    icon: 'calendar-clock',
    accent: 'teal',
    url: 'https://flowday.ziyixi.science/',
    access: true,
    status: {
      type: 'public_http',
      url: 'https://flowday.ziyixi.science/pwa/manifest.webmanifest',
      expect: [200],
      content_type: 'application/manifest+json',
      outside_access: true,
      error_rate: true,
      enabled: true,
    },
    tile_metric: { kind: 'latency' },
    app_only_signals: [],
    order: 5,
  },
  {
    // The short links (links/, s.ziyixi.science, deployed by "Links deploy" since L2). The tile opens the launcher
    // /_/, behind the path-scoped Access app "links"; the rest of the host is public. /robots.txt is the Worker's own
    // constant text/plain answer before any D1 read (links/worker/src/http.ts), so the probe says the Worker is up
    // without touching the database or a key. A short link may go unused for days, so no idle rule.
    id: 'links',
    name: '短链接',
    description: 's.ziyixi.science 短链接与启动器',
    group: 'apps',
    icon: 'link',
    // Not rose: its light and dark tokens sit next to the danger colour, so a healthy tile would read as a failure.
    accent: 'slate',
    url: 'https://s.ziyixi.science/_/',
    access: true,
    status: {
      type: 'public_http',
      url: 'https://s.ziyixi.science/robots.txt',
      expect: [200],
      content_type: 'text/plain',
      outside_access: true,
      error_rate: true,
      enabled: true,
    },
    tile_metric: { kind: 'latency' },
    app_only_signals: [],
    order: 6,
  },
  {
    // The web watches (watch/, watch.ziyixi.science, W2/W3): its Ops entrypoint answers counts only, never a
    // watch's name, URL or page text, so the tile and its flow read ops-v1 like Mail Hero's, Todofy's and Lab's.
    id: 'watch',
    name: '网页监视',
    description: '网页、订阅与接口的变化收件箱',
    group: 'apps',
    icon: 'eye',
    // Not rose (it reads as the danger colour), and not its neighbours' violet or slate in the 3-column grid.
    accent: 'blue',
    url: 'https://watch.ziyixi.science/',
    access: true,
    status: { type: 'ops_v1', binding: 'WATCH', guard: true },
    tile_metric: { kind: 'counter', name: 'changes_new' },
    // The watch app has no maintenance switch; the code is listed for every app in ops-v1 and never raised by it.
    app_only_signals: ['maintenance_mode'],
    order: 7,
  },
  {
    id: 'website',
    name: '个人网站',
    description: 'ziyixi.science，内容来自 Notion',
    group: 'sites',
    icon: 'globe',
    accent: 'violet',
    // www, the canonical host. Both www and the apex are Custom Domains of the site Worker since 2026-10-01
    // and share one certificate that covers no app host (website/docs/architecture.md "Hostnames"); before
    // that Chrome could reuse an apex connection for app subdomains and get Cloudflare's empty 403s.
    url: 'https://www.ziyixi.science/',
    access: false,
    // Q6: one public GET per tick to www's small JSON build file (the apex serves the same file;
    // 200 on 2026-09-29); status code and latency only, the body is never read.
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
  { script: 'flowday', entry: 'flowday', role: '页面、API 与 PWA 文件' },
  { script: 'links', entry: 'links', role: '短链接跳转与启动器' },
  { script: 'watch', entry: 'watch', role: '网页监视与 UI' },
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
  // Created for the links app's first deploy (L2, 2026-10-01).
  { id: 'links-db', kind: 'd1', name: 'links 短链接库', entry: 'links', match: '2f8c5331-06ce-4347-8c0a-90fe51c82260' },
  // FlowDay's database (flowday/wrangler.toml, managed by infra/ since IaC P4).
  { id: 'flowday-db', kind: 'd1', name: 'flowday 主库', entry: 'flowday', match: 'df104e83-7183-47e3-b2f9-638dc7502c13' },
  // Created by the watch app's first deploy (W2, 2026-10-02); id read from the account's Durable Object namespace list.
  { id: 'watch-state', kind: 'do', name: 'WatchState', entry: 'watch', script: 'watch', match: 'd58e1bdabacb4d14bbba1887f169c8b4' },
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
    id: 'web-watch',
    name: '网页监视',
    group: 'content',
    description: '网页、订阅与接口按计划检查，确认的变化进收件箱，每日摘要与紧急变化交给 Todofy 创建任务。',
    order: 3,
    stages: [
      { id: 'source', name: '网站', entry: null, signals: [], note: '被监视的网站在面板之外' },
      { id: 'check', name: '检查', entry: 'watch', signals: ['scheduler_stale', 'watches_broken'], counters: ['fetches_today', 'watches_failing'] },
      { id: 'inbox', name: '变化收件箱', entry: 'watch', signals: [], counters: ['changes_new'] },
      { id: 'send', name: '交给 Todofy', entry: 'watch', signals: ['notify_unsettled'], counters: ['intents_sent_today'] },
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

export const REGISTRY: RegistryDef = {
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

export function entryById(id: string, registry: RegistryDef = REGISTRY): EntryDef | undefined {
  return registry.entries.find((entry) => entry.id === id);
}

/** Script name → entry id, for the Worker table and the quota breakdowns; unknown → undefined (未登记). */
export function entryOfScript(script: string, registry: RegistryDef = REGISTRY): string | undefined {
  return registry.workers.find((worker) => worker.script === script)?.entry;
}

/** The scripts a stage runs on: its `workers`, or all of its entry's workers. */
export function stageScripts(stage: FlowDef['stages'][number], registry: RegistryDef = REGISTRY): readonly string[] {
  if (stage.entry === null) return [];
  return stage.workers ?? registry.workers.filter((worker) => worker.entry === stage.entry).map((worker) => worker.script);
}

/** Flow ids a script takes part in (the Worker table's flow tags), by group order then flow order. */
export function flowsOfScript(script: string, registry: RegistryDef = REGISTRY): string[] {
  const groupOrder = (flow: FlowDef): number => registry.flow_groups.find((group) => group.id === flow.group)?.order ?? 99;
  return [...registry.flows]
    .sort((a, b) => groupOrder(a) - groupOrder(b) || a.order - b.order)
    .filter((flow) => flow.stages.some((stage) => stageScripts(stage, registry).includes(script)))
    .map((flow) => flow.id);
}

/** A GraphQL identifier (databaseId, namespaceId, bucketName) → its registry resource, if mapped. */
export function resourceByMatch(kind: ResourceDef['kind'], id: string, registry: RegistryDef = REGISTRY): ResourceDef | undefined {
  return registry.resources.find((resource) => resource.kind === kind && resource.match !== null && resource.match === id);
}

/**
 * Outbound calls of one tick computed from the registry (design-v2.md §5): status() per ops_v1 entry,
 * one GET per enabled public_http probe, the GraphQL query, setGuard per guarded entry, two canary
 * calls per canary, one reportOps and the drift check's read-only calls (at most DRIFT_CALLS_PER_TICK).
 */
export function outboundPerTick(registry: RegistryDef = REGISTRY): number {
  const ops = registry.entries.filter((entry) => entry.status.type === 'ops_v1');
  const guarded = ops.filter((entry) => entry.status.type === 'ops_v1' && entry.status.guard);
  const canaries = registry.flows.filter((flow) => flow.canary !== null).length;
  return ops.length + probeCount(registry) + 1 + guarded.length + 2 * canaries + 1 + DRIFT_CALLS_PER_TICK;
}

/** Outbound calls of one owner refresh: status() and probes of /home, or the GraphQL of /cloudflare. */
export function outboundPerRefresh(registry: RegistryDef = REGISTRY): number {
  const ops = registry.entries.filter((entry) => entry.status.type === 'ops_v1').length;
  return Math.max(ops + probeCount(registry), 1);
}

function probeCount(registry: RegistryDef): number {
  return registry.entries.filter((entry) => entry.status.type === 'public_http' && entry.status.enabled).length;
}

// ---- the public view --------------------------------------------------------------------------------

function hostOf(url: string | null): string | null {
  return url === null ? null : new URL(url).hostname;
}

/** The resource name of the registry singleton (dashboard.ui.v1.Registry). */
export const REGISTRY_NAME = 'registry';

/**
 * Every object below is written field by field in the IDL's field order (proto/dashboard/ui/v1/registry.proto), not
 * spread from the definitions, so the serialized body is what the wire profile writes whatever order a definition's
 * keys were typed in (test/wire-conformance.test.ts); a key a stage leaves out stays out.
 */
function tileMetricView(metric: TileMetricDef | null): TileMetricDef | null {
  if (metric === null) return null;
  return metric.kind === 'counter' ? { kind: metric.kind, name: metric.name } : { kind: metric.kind };
}

function stageView(stage: Stage): Stage {
  return {
    id: stage.id,
    name: stage.name,
    entry: stage.entry,
    ...(stage.workers === undefined ? {} : { workers: stage.workers }),
    signals: stage.signals,
    ...(stage.hold_signals === undefined ? {} : { hold_signals: stage.hold_signals }),
    ...(stage.counters === undefined ? {} : { counters: stage.counters }),
    ...(stage.analytics === undefined ? {} : { analytics: stage.analytics }),
    ...(stage.note === undefined ? {} : { note: stage.note }),
  };
}

/** The body of GetRegistry; no binding names or probe URLs. */
export function registryView(build: string, registry: RegistryDef = REGISTRY): Registry {
  return {
    name: REGISTRY_NAME,
    build,
    entry_groups: registry.entry_groups.map(({ id, name, order }): EntryGroup => ({ id, name, order })),
    flow_groups: registry.flow_groups.map(({ id, name, order }): FlowGroup => ({ id, name, order })),
    entries: registry.entries.map(
      (entry): RegistryEntry => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        group: entry.group,
        icon: entry.icon,
        accent: entry.accent,
        url: entry.url,
        access: entry.access,
        tile_metric: tileMetricView(entry.tile_metric),
        app_only_signals: entry.app_only_signals,
        order: entry.order,
        status_type: entry.status.type,
        host: hostOf(entry.url),
        scripts: registry.workers.filter((worker) => worker.entry === entry.id).map((worker) => worker.script),
      }),
    ),
    workers: registry.workers.map(({ script, entry, role }) => ({ script, entry, role, flows: flowsOfScript(script, registry) })),
    resources: registry.resources.map(({ id, kind, name, entry, script }) => (script === undefined ? { id, kind, name, entry } : { id, kind, name, entry, script })),
    flows: registry.flows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      group: flow.group,
      description: flow.description,
      order: flow.order,
      stages: flow.stages.map(stageView),
      canary:
        flow.canary === null
          ? null
          : {
              id: flow.canary.id,
              runner: flow.canary.runner,
              stage_map: { delivery: flow.canary.stage_map.delivery, consumer: flow.canary.stage_map.consumer },
              fresh_hours: flow.canary.fresh_hours,
              scope_note: flow.canary.scope_note,
            },
    })),
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
