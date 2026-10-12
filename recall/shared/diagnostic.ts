/** Display names for the closed diagnostic vocabulary, shared by extension settings and owner settings. */
import type { CaptureDiagnosticStep } from '../../proto/ts/recall/ingest/v1/diagnostic_wire.ts';

export const DIAGNOSTIC_STAGE_LABELS: Readonly<Record<string, string>> = {
  open_test_page: '打开测试页', active_tabs: '读取活动标签', tab_lookup: '读取标签信息',
  probe_injection: '注入页面脚本', probe_reply: '读取页面回复', probe_context: '核对页面可见性',
  focus_target: '选择前台网页', capture_reply: '读取正文回复', screenshot: '读取截图',
  capture_store: '保存采集结果', alarm_setup: '设置分钟检查',
};

export const DIAGNOSTIC_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '等待回调', returned: '已返回', failed: '失败', skipped: '已跳过',
};

const SELECTION_LABELS = { test_page: '测试页', extension_page: '扩展设置页', other_page: '其他网页', none: '无标签' };
const VISIBILITY_LABELS = { visible: '可见', hidden: '不可见', unknown: '未知' };
const SENDER_LABELS = { same: '本扩展', missing: '未提供', null: 'null', foreign: '其他扩展', unknown: '未知' };

/** Fixed metadata only; API return shapes stay explicit for diagnosis. */
export function diagnosticStepSummary(step: CaptureDiagnosticStep): string {
  const parts = [DIAGNOSTIC_STAGE_LABELS[step.stage] ?? step.stage, DIAGNOSTIC_STATE_LABELS[step.state] ?? step.state];
  if (step.result !== undefined) parts.push(`结果 ${step.result}`);
  if (step.stage === 'active_tabs') parts.push(`匹配 ${String(step.count ?? 0)} 个`);
  if (step.selection !== undefined) parts.push(`选择 ${SELECTION_LABELS[step.selection]}`);
  if (step.visibility !== undefined) parts.push(`页面 ${VISIBILITY_LABELS[step.visibility]}`);
  if (step.stored_visibility !== undefined) parts.push(`记忆状态 ${VISIBILITY_LABELS[step.stored_visibility]}`);
  if (step.sender_identity !== undefined) parts.push(`消息身份 ${SENDER_LABELS[step.sender_identity]}`);
  return parts.join(' · ');
}
