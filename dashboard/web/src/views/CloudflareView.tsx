import type { CloudflareResponse, RegistryResponse } from '../../../worker/src/api-v2-types.ts'

/**
 * Cloudflare 监控 `#/cloudflare[/worker/<script>]` (docs/design-v2.md §1): the 13 quota rows, the
 * auto-discovered Worker table, D1/DO/R2 resources, the read-only guard. TODO(v2 web): scaffold only.
 */
export function CloudflareView({ registry, cloudflare, focus }: { registry: RegistryResponse; cloudflare: CloudflareResponse; focus?: string }) {
  return (
    <section aria-labelledby="view-cloudflare-title" data-workers={registry.workers.length} data-rev={cloudflare.rev} data-focus={focus}>
      <h2 id="view-cloudflare-title">Cloudflare 监控</h2>
    </section>
  )
}
