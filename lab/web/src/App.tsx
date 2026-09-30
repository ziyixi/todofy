import { TODAY_LIMIT } from '../../worker/src/api-types.ts'

/** Scaffold: the views (今日, 已保存, 种子, 设置) and keyboard triage land here (docs/design.md §7). */
export function App() {
  return (
    <main>
      <h1>论文雷达</h1>
      <p>每日前 {TODAY_LIMIT} 篇，建设中。</p>
    </main>
  )
}
