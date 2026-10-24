import type { ReconcilePlan } from '@ziyixi/proto/platform/runtime/v1/runtime_wire';
import { ACTIONS_RECONCILE_URL, REBUILD_DOC_URL } from './deployment.ts';
import { time } from './format.ts';

const STATES: Readonly<Record<ReconcilePlan['state'], string>> = {
  clean: '配置一致', repairable: '可以修复', manual_required: '需要人工处理', unavailable: '无法完成检查',
};
const REASONS: Readonly<Record<string, string>> = {
  NO_ACCEPTED_RELEASE: '还没有已接受的发布。请先完成首次发布。',
  RELEASE_IN_PROGRESS: '当前发布尚未完成。请查看上面的阶段和错误。',
  BUSINESS_PAUSED: 'Newsletter 已暂停。修复会保留暂停状态，请先确认是否恢复原发布。',
  RUNTIME_OWNERSHIP_CONFLICT: '有字段由其他部署工具管理。需要核对字段归属，不能自动覆盖。',
  RUNTIME_COMPARISON_UNAVAILABLE: '无法读取完整的集群或任务入口状态，请检查 daemon 和 Tunnel。',
  RUNTIME_SOURCE_MISMATCH: 'daemon 的实际版本与发布账本不一致，请使用固定安装包恢复入口。',
  RUNTIME_FIELDS_CHANGED: '运行配置与已接受的版本有差异。',
  RUNTIME_RESOURCE_MISSING: '缺少一个已声明的运行资源。',
};

export function ReconcileView({ plan }: { plan: ReconcilePlan | null | undefined }) {
  return (
    <article aria-label="配置对账">
      <h3>配置对账</h3>
      {plan ? <>
        <p>{STATES[plan.state]} · 检查时间：{time(plan.observed_at)}</p>
        {plan.base_release && <p>核对发布：<code>{plan.base_release}</code></p>}
        {plan.reason_code && <p>{REASONS[plan.reason_code] ?? plan.reason_code}</p>}
        {plan.changes.length > 0 && <ul>{plan.changes.map((change) => (
          <li key={change.resource_key}><code>{change.resource_key}</code>：{REASONS[change.reason_code] ?? change.reason_code}</li>
        ))}</ul>}
        {plan.state === 'clean' && <p>当前无需修复，不会重启服务。</p>}
        {plan.state === 'repairable' && <p>在 GitHub 运行 repair，修复当前已接受的版本；Actions 会核对实际运行结果。</p>}
      </> : <p>尚未收到配置检查结果，不能确认运行配置与代码一致。</p>}
      <p><a href={ACTIONS_RECONCILE_URL}>打开 GitHub 检查／修复</a> · <a href={REBUILD_DOC_URL}>daemon 或宿主不可达时的恢复步骤</a></p>
    </article>
  );
}
