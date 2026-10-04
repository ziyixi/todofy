/** Shared runtime evidence. A declared target is never treated as the running release. */
import type { HostReport } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import type { NodeStatus, WorkloadStatus } from '@ziyixi/proto/platform/runtime/v1/runtime_wire';

export function workload(report: HostReport, key: string): WorkloadStatus | null {
  return report.runtime?.workloads.find((item) => item.workload_key === key) ?? null;
}

/** Unresolved business results need attention without invalidating healthy process evidence. */
export function runtimeHealthReady(item: WorkloadStatus): boolean {
  return ['healthy', 'unsupported'].includes(item.health_state)
    || (item.health_state === 'degraded' && (item.unknown_count ?? 0) > 0);
}

export function releaseReady(item: WorkloadStatus): boolean {
  const { release } = item;
  const { desired, actual } = release;
  return release.state === 'ready'
    && desired != null
    && actual != null
    && desired.workload_key === actual.workload_key
    && desired.source_sha === actual.source_sha
    && desired.image_digest === actual.image_digest
    && desired.request_id === actual.request_id
    && desired.generation != null
    && actual.generation === desired.generation
    && release.observed_generation === desired.generation
    && item.process_state === 'running'
    && ['accepting', 'unsupported'].includes(item.admission_state)
    && runtimeHealthReady(item);
}

/** Relations not expressible in the generic wire profile: identity and time consistency. */
export function validRuntime(runtime: NodeStatus, host: string, observedAt: number): boolean {
  if (runtime.node_key !== host) return false;
  const keys = runtime.workloads.map((item) => item.workload_key);
  if (new Set(keys).size !== keys.length || keys.join(',') !== [...keys].sort().join(',')) {
    return false;
  }
  const timestamps = [runtime.observed_at];
  if (runtime.reconcile_plan) timestamps.push(runtime.reconcile_plan.observed_at);
  for (const item of runtime.workloads) {
    if (item.name !== `workloads/${item.workload_key}`) return false;
    const { desired, actual } = item.release;
    for (const target of [desired, actual]) {
      if (target && target.workload_key !== item.workload_key) return false;
    }
    timestamps.push(item.observed_at, item.release.observed_at);
  }
  return timestamps.every((timestamp) => {
    const age = observedAt - Date.parse(timestamp);
    return age >= -120_000 && age <= 60_000;
  });
}
