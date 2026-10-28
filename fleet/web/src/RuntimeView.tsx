import type { NodeStatus } from '@ziyixi/proto/platform/runtime/v1/runtime_wire';
import { label, time } from './format.ts';
import { Mark } from './Mark.tsx';
import { ReconcileView } from './ReconcileView.tsx';

/** Desired beside actual, with a mismatch said in words. */
function Compare({ name, desired, actual, actualName = '实际' }: {
  name: string; desired: string | number | undefined; actual: string | number | undefined; actualName?: string;
}) {
  const differs = desired !== undefined && actual !== undefined && desired !== actual;
  return (
    <div className="compare-row">
      <dt>{name}{differs && <span className="mark warn"><span aria-hidden="true"> ▲ </span>不一致</span>}</dt>
      <dd><span className="side">目标</span><code>{desired ?? '未知'}</code></dd>
      <dd><span className="side">{actualName}</span><code>{actual ?? '未知'}</code></dd>
    </div>
  );
}

/** The generic API can add configured workloads without copying a private release DTO into Fleet. */
export function RuntimeView({ runtime }: { runtime: NodeStatus | null | undefined }) {
  if (!runtime) {
    return <p>运行时核验：未知。未收到独立 daemon 的当前状态，不能确认发布成功。</p>;
  }
  return (
    <>
      <p>运行时：<Mark state={runtime.state} /> · 核验时间：{time(runtime.observed_at)}</p>
      <ReconcileView plan={runtime.reconcile_plan} />
      {runtime.current_release && (
        <article aria-label="当前发布操作">
          <h3>当前发布操作</h3>
          <p>请求：<code>{runtime.current_release.request_id}</code></p>
          <p>阶段：<Mark state={runtime.current_release.phase} /></p>
          <p>最近变更：{time(runtime.current_release.update_time)}</p>
          {runtime.current_release.error_code && (
            <p>错误码：<code>{runtime.current_release.error_code}</code></p>
          )}
          <p className="muted">排空、应用或核验进行中不等于发布完成；保持暂停时需要明确处理。</p>
        </article>
      )}
      {runtime.workloads.map((item) => {
        const { desired, actual } = item.release;
        return (
          <article key={item.workload_key} aria-label={`workload ${item.workload_key}`}>
            <h3>{item.workload_key} <Mark state={item.release.state} /></h3>
            <p>
              进程：{label(item.process_state)} · 接收任务：{label(item.admission_state)} ·
              健康：{label(item.health_state)}
            </p>
            <dl className="compare">
              <Compare name="提交" desired={desired?.source_sha} actual={actual?.source_sha} />
              <Compare name="镜像" desired={desired?.image_digest} actual={actual?.image_digest} />
              <Compare name="请求" desired={desired?.request_id} actual={actual?.request_id} />
              <Compare name="generation" desired={desired?.generation} actual={item.release.observed_generation} actualName="已核验" />
            </dl>
            <p className="muted">发布观测时间：{time(item.release.observed_at)}</p>
          </article>
        );
      })}
      {!runtime.workloads.length && <p>暂无已配置的 workload</p>}
      <p className="muted">就绪要求目标提交、实际镜像、最新发布回执一致，并且后台进程已恢复。</p>
    </>
  );
}
