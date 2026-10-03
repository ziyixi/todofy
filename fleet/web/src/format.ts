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
export function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '暂无观测';
}
export function percent(value: number | null | undefined): string {
  return value == null ? '未知' : `${value.toFixed(1)}%`;
}
