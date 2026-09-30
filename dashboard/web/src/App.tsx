import type { OverviewResponse } from '../../worker/src/api-types.ts'

/** Scaffold: the build step replaces this with the overview page (docs/design.md §8). */
export function App({ overview }: { overview?: OverviewResponse | null }) {
  return (
    <main>
      <h1>运维面板</h1>
      <p>{overview ? overview.overall.level : '加载中'}</p>
    </main>
  )
}
