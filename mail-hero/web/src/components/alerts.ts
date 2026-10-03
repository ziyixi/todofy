import { ActiveAlert_Severity, type ActiveAlert } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'

const labels: Record<string, string> = {
  capacity_70: '应用容量已达 70%', capacity_85: '应用容量已达 85%', capacity_95: '应用容量已达 95%',
  backup_stale: '已校验备份超过 36 小时未成功', pending_stale: '邮件处理积压超过 1 小时', parse_failed: '有邮件解析失败',
  endpoint_blocked: '投递目标被阻断，自动投递已停止', endpoint_paused: '投递目标已暂停',
  delivery_failed: '有投递已停止，需要处理', policy_error: '有邮件因策略读取失败只归档、未转发',
}

// Unknown codes from a newer Worker stay visible as their raw code.
export function alertLabel(code: string): string { return labels[code] || code }
export function isEndpointAlert(code: string): boolean { return code.startsWith('endpoint_') }
export function attentionAlerts(active?: readonly ActiveAlert[]): ActiveAlert[] {
  return (active || []).filter(alert => alert.severity === ActiveAlert_Severity.CRITICAL || alert.severity === ActiveAlert_Severity.WARNING)
}
export function isCritical(alert: ActiveAlert): boolean { return alert.severity === ActiveAlert_Severity.CRITICAL }
