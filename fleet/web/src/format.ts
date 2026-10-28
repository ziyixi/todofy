/** Fixed vocabulary only. Observation data never supplies HTML or UI commands. */
const LABELS: Readonly<Record<string, string>> = {
  never_seen: '尚未接入',
  fresh: '观测及时',
  stale: '观测延迟',
  missing: '主机报告已中断',
  active: '运行中',
  running: '运行中',
  accepting: '可接收',
  unsupported: '未支持',
  unhealthy: '异常',
  starting: '启动中',
  stopped: '已停止',
  inactive: '未运行',
  failed: '故障',
  activating: '启动中',
  deactivating: '停止中',
  unknown: '未知',
  ready: '就绪',
  pending: '发布未完成',
  accepted: '请求已登记',
  applying: '正在应用',
  verifying: '正在核验',
  held: '暂停待处理',
  paused: '发布暂停',
  degraded: '需要关注',
  unavailable: '不可用',
  healthy: '进程健康',
  draining: '排空中',
  frozen: '已冻结',
  resumed: '已恢复',
};
export const label = (value: string): string => LABELS[value] ?? value;

/** A systemd unit the observer could not find is not a missing host report. */
export const daemonLabel = (state: string): string => (state === 'missing' ? '未找到' : label(state));

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown';
const TONES: Readonly<Record<string, Tone>> = {
  fresh: 'ok', active: 'ok', running: 'ok', accepting: 'ok', ready: 'ok', healthy: 'ok', clean: 'ok',
  failed: 'bad', unhealthy: 'bad', unavailable: 'bad', missing: 'bad', stopped: 'bad', manual_required: 'bad',
  unknown: 'unknown', never_seen: 'unknown', unsupported: 'unknown',
};
/** Severity of a state word; anything not listed is "needs attention", never silently healthy. */
export const tone = (value: string): Tone => TONES[value] ?? 'warn';
/** Shape that carries the tone beside its word, so state is never colour alone. */
export const SHAPES: Readonly<Record<Tone, string>> = { ok: '●', warn: '▲', bad: '■', unknown: '◆' };

export function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '暂无观测';
}
export function percent(value: number | null | undefined): string {
  return value == null ? '未知' : `${value.toFixed(1)}%`;
}

const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
/** The binary unit a value reads best in: its exponent and divisor. */
export function byteUnit(value: number): { name: string; divisor: number } {
  let exponent = 0;
  while (exponent < BINARY.length - 1 && Math.abs(value) >= 1024 ** (exponent + 1)) exponent += 1;
  return { name: BINARY[exponent] ?? 'B', divisor: 1024 ** exponent };
}
/** Three significant digits at most; whole bytes stay whole. */
function scaled(value: number, divisor: number): string {
  const x = value / divisor;
  if (divisor === 1) return String(Math.round(x));
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
}
export function bytes(value: number | null | undefined): string {
  if (value == null) return '未知';
  const unit = byteUnit(value);
  return `${scaled(value, unit.divisor)} ${unit.name}`;
}
/** "6.00 / 15.6 GiB": both sides in the larger value's unit. */
export function bytesOf(used: number, total: number): string {
  const unit = byteUnit(Math.max(used, total));
  return `${scaled(used, unit.divisor)} / ${scaled(total, unit.divisor)} ${unit.name}`;
}
export function rate(value: number | null | undefined): string {
  return value == null ? '未知' : `${bytes(value)}/s`;
}
export function load(value: number | null | undefined): string {
  return value == null ? '未知' : value.toFixed(2);
}
export function cores(value: number | null | undefined): string {
  if (value == null) return '未知';
  if (value === 0) return '0 核';
  return `${value >= 1 ? value.toFixed(2) : String(Number(value.toPrecision(2)))} 核`;
}

/** "3 天 4 小时", "5 小时 12 分钟", "8 分钟": two units at most. */
export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}
export function ago(value: string | null | undefined, now: number): string {
  if (!value) return '暂无观测';
  const seconds = Math.max(0, (now - Date.parse(value)) / 1000);
  return seconds < 60 ? '刚刚' : `${duration(seconds).split(' ').slice(0, 2).join(' ')}前`;
}
