import type { WorkloadInventory } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { Mark } from './Mark.tsx';

/** Discovery readiness is independent of the runtime daemon's release evidence. */
export function WorkloadInventoryView({ inventory }: { inventory: WorkloadInventory | null | undefined }) {
  if (!inventory) return <p className="muted">未知：此报告未提供工作负载就绪观测。</p>;
  if (inventory.state === 'unavailable') return <p className="muted">未知：本次未能读取工作负载清单。</p>;
  const workloads = inventory.workloads ?? [];
  return (
    <>
      {inventory.state === 'truncated' ? <p className="muted">清单不完整：已达到观测上限，其余工作负载状态未知。</p> : null}
      {workloads.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>工作负载</th><th>状态</th><th>就绪 / 期望</th><th>重启次数</th><th>就绪探针</th></tr></thead>
            <tbody>
              {workloads.map((item) => (
                <tr key={item.workload_key}>
                  <th scope="row"><code>{item.workload_key}</code></th>
                  <td><Mark state={item.state} /></td>
                  <td>{item.ready_count ?? '?'} / {item.desired_count ?? '?'}</td>
                  <td>{item.restart_count ?? '未知'}</td>
                  <td>{item.readiness_probe ? '已声明就绪探针' : '未声明就绪探针'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : inventory.state === 'observed' ? <p className="muted">本次未发现声明监控的工作负载。</p> : null}
      <p className="muted">Kubernetes 就绪观测不证明发布版本或业务处理成功。</p>
    </>
  );
}
