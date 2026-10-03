import type { NodeStatus } from '@ziyixi/proto/platform/runtime/v1/runtime_wire';
import { label, time } from './format.ts';

/** The generic API can add configured workloads without copying a private release DTO into Fleet. */
export function RuntimeView({ runtime }: { runtime: NodeStatus | null | undefined }) {
  if (!runtime) {
    return <p>运行时核验：未知。未收到独立 daemon 的当前状态，不能确认发布成功。</p>;
  }
  return (
    <>
      <p>运行时：{label(runtime.state)} · 核验时间：{time(runtime.observed_at)}</p>
      {runtime.current_release && (
        <article aria-label="当前发布操作">
          <h3>当前发布操作</h3>
          <p>请求：<code>{runtime.current_release.request_id}</code></p>
          <p>阶段：{label(runtime.current_release.phase)}</p>
          <p>最近变更：{time(runtime.current_release.update_time)}</p>
          {runtime.current_release.error_code && (
            <p>错误码：<code>{runtime.current_release.error_code}</code></p>
          )}
          <p>排空、应用或核验进行中不等于发布完成；保持暂停时需要明确处理。</p>
        </article>
      )}
      {runtime.workloads.map((item) => (
        <article key={item.workload_key}>
          <h3>{item.workload_key}</h3>
          <p>
            进程：{label(item.process_state)} · 接收任务：{label(item.admission_state)} ·
            健康：{label(item.health_state)}
          </p>
          <p>发布状态：{label(item.release.state)}</p>
          <p>目标提交：<code>{item.release.desired?.source_sha ?? '未知'}</code></p>
          <p>实际提交：<code>{item.release.actual?.source_sha ?? '未知'}</code></p>
          <p>目标镜像：<code>{item.release.desired?.image_digest ?? '未知'}</code></p>
          <p>实际镜像：<code>{item.release.actual?.image_digest ?? '未知'}</code></p>
          <p>目标请求：<code>{item.release.desired?.request_id ?? '未知'}</code></p>
          <p>实际请求：<code>{item.release.actual?.request_id ?? '未知'}</code></p>
          <p>
            目标 generation：{item.release.desired?.generation ?? '未知'} ·
            已核验 generation：{item.release.observed_generation ?? '未知'}
          </p>
          <p>发布观测时间：{time(item.release.observed_at)}</p>
        </article>
      ))}
      {!runtime.workloads.length && <p>暂无已配置的 workload</p>}
      <p>就绪要求目标提交、实际镜像、最新发布回执一致，并且后台进程已恢复。</p>
    </>
  );
}
