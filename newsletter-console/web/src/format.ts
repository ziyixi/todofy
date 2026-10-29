/**
 * The console's fixed vocabulary and number formats. Every state is a shape and a word (colour only reinforces them),
 * with Fleet's and Home's words where they show the same thing. A code this table does not know is shown as it is,
 * with ▲ (needs attention), never as healthy. Newsletter's text never supplies markup here: these are labels only.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'none';
/** ● normal · ▲ needs attention · ■ failed or not sent · ◆ unconfirmed or in progress · ○ no record. */
export const SHAPES: Readonly<Record<Tone, string>> = { ok: '●', warn: '▲', bad: '■', unknown: '◆', none: '○' };

export interface Word {
  readonly label: string;
  readonly tone: Tone;
}

function lookup(table: Readonly<Record<string, Word>>, code: string | undefined, absent: Word): Word {
  if (code === undefined || code === '') return absent;
  return table[code] ?? { label: code, tone: 'warn' };
}

const NOT_RECORDED: Word = { label: '无记录', tone: 'none' };

const RUN_STATES: Readonly<Record<string, Word>> = {
  queued: { label: '排队中', tone: 'unknown' },
  running: { label: '运行中', tone: 'unknown' },
  ready: { label: '已生成', tone: 'ok' },
  blocked: { label: '已停止', tone: 'bad' },
  failed: { label: '出错', tone: 'bad' },
};
export const runState = (state: string | undefined): Word => lookup(RUN_STATES, state, NOT_RECORDED);

/** Fleet's and Home's delivery words (fleet/web/src/HostReportView.tsx). */
const DELIVERY_STATES: Readonly<Record<string, Word>> = {
  not_requested: { label: '未投递', tone: 'warn' },
  submitting: { label: '正在提交', tone: 'unknown' },
  simulated: { label: '模拟投递，未发出邮件', tone: 'warn' },
  provider_accepted: { label: '邮件服务已接收', tone: 'ok' },
  rejected: { label: '邮件服务拒绝', tone: 'bad' },
  unknown: { label: '结果尚未确认', tone: 'unknown' },
};
export const deliveryState = (state: string | undefined): Word => lookup(DELIVERY_STATES, state, { label: '无期刊', tone: 'none' });

const NODE_STATES: Readonly<Record<string, Word>> = {
  pending: { label: '未开始', tone: 'none' },
  running: { label: '运行中', tone: 'unknown' },
  succeeded: { label: '完成', tone: 'ok' },
  skipped: { label: '跳过', tone: 'none' },
  failed: { label: '失败', tone: 'bad' },
  unknown: { label: '待核对', tone: 'unknown' },
};
export function nodeState(state: string | undefined, degraded = false): Word {
  const word = lookup(NODE_STATES, state, NOT_RECORDED);
  return degraded && state === 'succeeded' ? { label: '部分失败', tone: 'warn' } : word;
}

/** The workflow's node types in Chinese, in the daily graph's order (newsletter/content-config/workflow.yaml). */
const NODE_NAMES: Readonly<Record<string, string>> = {
  history: '历史',
  api_feed: '订阅源',
  discovery: '搜集',
  deduplicate: '候选',
  selection: '选题',
  story_plan: '规划',
  story_brief: '简讯',
  story_deep: '深读',
  publish: '发布',
};
const NODE_IDS: Readonly<Record<string, string>> = {
  history: '历史', feeds: '订阅源', discovery: '搜集', candidates: '候选', selection: '选题', story_plan: '规划',
  briefs: '简讯', deep: '深读', publish: '发布',
};
/** A node's name: by its type, else by its ID, else the ID as it is. */
export const nodeName = (node: { readonly type?: string; readonly node_id?: string }): string =>
  NODE_NAMES[node.type ?? ''] ?? NODE_IDS[node.node_id ?? ''] ?? node.node_id ?? '未命名节点';
export const nodeNameById = (id: string | undefined): string => NODE_IDS[id ?? ''] ?? id ?? '未命名节点';

const FAILURE_KINDS: Readonly<Record<string, string>> = {
  node_budget: '超出节点预算',
  run_deadline: '超出运行期限',
  interrupted: '被中断',
  model_error: '模型服务出错',
  no_findings: '模型没有找到内容',
  nothing_publishable: '没有可发布内容',
  storage: 'Newsletter 存储出错',
  other: '其他错误',
};
export const failureKind = (kind: string | undefined, code?: string): string =>
  FAILURE_KINDS[kind ?? ''] ?? code ?? kind ?? '原因未记录';

/** A run's stop code (Run.stop_reason) in words, or null for a code this table does not know. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  no_publishable_content: '没有可发布内容',
  workflow_storage: 'Newsletter 存储出错',
  workflow_deadline: '超出运行期限',
};
export const stopReason = (code: string | undefined): string | null => STOP_REASONS[code ?? ''] ?? null;

const TRIGGERS: Readonly<Record<string, string>> = { scheduled: '每日', replay: '重放', manual: '手动' };
export const trigger = (value: string | undefined): string => TRIGGERS[value ?? ''] ?? value ?? '未记录';

const PURPOSES: Readonly<Record<string, string>> = {
  discovery: '搜集', selection: '选题', writer: '撰写', reviewer: '审校', repair_writer: '修订', repair_reviewer: '复审',
};
export const purpose = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : PURPOSES[value] ?? value;

const CALL_STATES: Readonly<Record<string, Word>> = {
  running: { label: '进行中', tone: 'unknown' },
  completed: { label: '完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
};
export const callState = (state: string | undefined): Word => lookup(CALL_STATES, state, NOT_RECORDED);

const DEPENDENCY_NAMES: Readonly<Record<string, { name: string; note: string }>> = {
  feeds: { name: '订阅源 HTTP', note: '研究员读取的订阅源' },
  model_router: { name: 'Model Router', note: '每一次模型调用' },
  todofy: { name: 'Todofy 个人事项', note: '可选，仅你可见' },
  mail: { name: '邮件服务', note: '投递每日简报' },
  notion_backup: { name: 'Notion 备份', note: '异步副本，写在记录之后' },
};
export const dependency = (kind: string | undefined) =>
  DEPENDENCY_NAMES[kind ?? ''] ?? { name: kind ?? '未命名接口', note: '' };

const DEPENDENCY_STATES: Readonly<Record<string, Word>> = {
  ok: { label: '正常', tone: 'ok' },
  attention: { label: '需要关注', tone: 'warn' },
  failed: { label: '失败', tone: 'bad' },
  unknown: { label: '待核对', tone: 'unknown' },
  disabled: { label: '未启用', tone: 'none' },
};
export const dependencyState = (state: string | undefined): Word => lookup(DEPENDENCY_STATES, state, NOT_RECORDED);

const REPLICA_STATES: Readonly<Record<string, Word>> = {
  disabled: { label: '未启用', tone: 'none' },
  not_started: { label: '尚未备份', tone: 'none' },
  syncing: { label: '同步中', tone: 'unknown' },
  synced: { label: '已同步', tone: 'ok' },
  outdated: { label: '副本较旧', tone: 'warn' },
  retrying: { label: '等待重试', tone: 'warn' },
  unknown: { label: '待核对', tone: 'unknown' },
  conflict: { label: '有冲突', tone: 'bad' },
};
export const replicaState = (state: string | undefined): Word => lookup(REPLICA_STATES, state, NOT_RECORDED);

/** Fleet's configuration states and words (fleet/web/src/NewsletterConfigView.tsx), so both pages say the same. */
const CONFIG_STATES: Readonly<Record<string, Word & { readonly guidance: string }>> = {
  current: { label: '与上次检查目标一致', tone: 'ok', guidance: '自动检查继续运行；此处未核对检查之后的新发布。' },
  pending: { label: '等待激活', tone: 'unknown', guidance: '生效配置与上次检查目标或固定版本不同，请等待下一次检查并核对结果。' },
  failed: { label: '配置检查失败', tone: 'warn', guidance: '请按错误码检查配置同步；本次失败不代表每日投递失败。' },
  stale: { label: '配置检查延迟', tone: 'warn', guidance: '超过 30 分钟没有检查，请核对配置同步进程。' },
  pinned: { label: '固定版本', tone: 'unknown', guidance: '当前配置符合固定版本，自动更新暂不跟随远端发布。' },
  unobserved: { label: '尚未取得完整配置观测', tone: 'unknown', guidance: '请等待配置同步与观察器报告；旧版报告不包含这些字段。' },
};
export const configState = (state: string | undefined) =>
  CONFIG_STATES[state ?? ''] ?? { label: state ?? '尚未取得完整配置观测', tone: 'warn' as Tone, guidance: '' };

/** Fleet's words for the deployment gate. */
const DRAIN_STATES: Readonly<Record<string, Word>> = {
  active: { label: '可接收', tone: 'ok' },
  draining: { label: '排空中', tone: 'warn' },
  frozen: { label: '已冻结', tone: 'warn' },
};
export const drainState = (state: string | undefined): Word => lookup(DRAIN_STATES, state, { label: '未知', tone: 'unknown' });

/** Fleet's names of the unknown-record categories. */
export const UNKNOWN_CATEGORIES: Readonly<Record<string, string>> = {
  interrupted_activities: '运行中断', packets: '采编记录', workflow_attempts: '工作流步骤',
  notion_entities: 'Notion 创建', notion_versions: 'Notion 更新', delivery: '邮件投递',
};

// ---- Dates, times and numbers -------------------------------------------------------------------------------------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** An issue date (YYYY-MM-DD, the service's calendar day) as 10月28日; never shifted into another time zone. */
export function issueDate(value: string | undefined, withWeekday = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return value ?? '日期未记录';
  const [, year, month, day] = match;
  const text = `${String(Number(month))}月${String(Number(day))}日`;
  if (!withWeekday) return text;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  return `${text} ${WEEKDAYS[weekday] ?? ''}`;
}

/** The day of month and weekday of an issue date, for the day strip. */
export function stripDay(value: string | undefined): { day: string; weekday: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return { day: '?', weekday: '' };
  const [, year, month, day] = match;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  return { day: String(Number(day)), weekday: (WEEKDAYS[weekday] ?? '').slice(1) };
}

/** A month (YYYY-MM) as 2026年10月. */
export function month(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  return match ? `${match[1] ?? ''}年${String(Number(match[2]))}月` : value ?? '';
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const clockSeconds = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTime = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** A time in the browser's time zone: 07:00, or 10月28日 07:00 with the date. */
export function time(value: string | number | undefined, withDate = false, withSeconds = false): string {
  if (value === undefined || value === '') return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return (withDate ? dateTime : withSeconds ? clockSeconds : clock).format(date);
}

/** Seconds between two times, or undefined when either is missing. */
export function seconds(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** A duration: 0.4 秒, 58 秒, 1 分 28 秒, 1 小时 2 分. */
export function duration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '未记录';
  if (value < 10) return `${(Math.round(value * 10) / 10).toString()} 秒`;
  const total = Math.round(value);
  if (total < 60) return `${String(total)} 秒`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${String(hours)} 小时${minutes > 0 ? ` ${String(minutes)} 分` : ''}`;
  return `${String(minutes)} 分${rest > 0 ? ` ${String(rest)} 秒` : ''}`;
}

/** Whole seconds, for budgets and elapsed times compared with them: 161 秒. */
export const wholeSeconds = (value: number | undefined): string =>
  value === undefined ? '未记录' : `${String(Math.round(value))} 秒`;

const grouped = new Intl.NumberFormat('zh-CN');
/** A count: 5,400, or 21.8 万 from ten thousand on. */
export function count(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '未记录';
  if (Math.abs(value) >= 10_000) return `${(Math.round(value / 1000) / 10).toString()} 万`;
  return grouped.format(Math.round(value));
}

/** A cost estimate in millionths of a dollar: $0.0057. Not a bill. */
export function microUsd(value: number | undefined): string | null {
  if (value === undefined) return null;
  const dollars = value / 1_000_000;
  return `$${dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}

/** The first seven characters of a commit SHA or digest; `packaged` and other words as they are. */
export const short = (value: string | undefined): string =>
  value === undefined || value === '' ? '未记录' : /^[0-9a-f]{12,}$/.test(value) ? value.slice(0, 7) : value;

/** The ID part of a resource name (runs/<id> → <id>). */
export const idOf = (name: string | undefined): string => (name ?? '').split('/').pop() ?? '';

/** Only http and https URLs become links; anything else is not followed. */
export function webUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
