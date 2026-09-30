import type { HomeResponse, RegistryResponse } from '../../../worker/src/api-v2-types.ts'

/**
 * 首页 `#/` (docs/design-v2.md §1): launcher tiles grouped 应用 / 站点 / 后台服务 with their level,
 * one line per flow, the four mini quota bars. TODO(v2 web): scaffold only.
 */
export function HomeView({ registry, home }: { registry: RegistryResponse; home: HomeResponse }) {
  return (
    <section aria-labelledby="view-home-title" data-entries={registry.entries.length} data-rev={home.rev}>
      <h2 id="view-home-title">首页</h2>
    </section>
  )
}
