import { DECK_SIZE } from '../../worker/src/api-types.ts'

/** Scaffold: the views (今日 deck → summary → done, 已喜欢, 种子, 设置) land here (docs/ux.md, docs/design.md §8). */
export function App() {
  return (
    <main>
      <h1>论文雷达</h1>
      <p>每天 {DECK_SIZE} 张卡片，右滑喜欢，左滑不喜欢。建设中。</p>
    </main>
  )
}
