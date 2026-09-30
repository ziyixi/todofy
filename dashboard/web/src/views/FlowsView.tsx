import type { FlowsResponse, RegistryResponse } from '../../../worker/src/api-v2-types.ts'

/**
 * 业务流程 `#/flows[/<flow-id>]` (docs/design-v2.md §1): flow cards by business group, each a stage
 * chain; the mail flow owns the canary. TODO(v2 web): scaffold only.
 */
export function FlowsView({ registry, flows, focus }: { registry: RegistryResponse; flows: FlowsResponse; focus?: string }) {
  return (
    <section aria-labelledby="view-flows-title" data-flows={registry.flows.length} data-rev={flows.rev} data-focus={focus}>
      <h2 id="view-flows-title">业务流程</h2>
    </section>
  )
}
