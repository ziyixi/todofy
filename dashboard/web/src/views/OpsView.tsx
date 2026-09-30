import type { OpsResponse, RegistryResponse } from '../../../worker/src/api-v2-types.ts'

/**
 * 操作与记录 `#/ops` (docs/design-v2.md §1): guard and canary actions (confirmation texts unchanged),
 * the digest, full ops-v1 details per app, build and time zone. TODO(v2 web): scaffold only.
 */
export function OpsView({ registry, ops }: { registry: RegistryResponse; ops: OpsResponse }) {
  return (
    <section aria-labelledby="view-ops-title" data-entries={registry.entries.length} data-rev={ops.rev}>
      <h2 id="view-ops-title">操作与记录</h2>
    </section>
  )
}
