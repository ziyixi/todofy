/**
 * 论文雷达: 今日 (deck → summary → done), 已喜欢, 种子, 设置 (docs/ux.md, docs/design.md §8). Phone first:
 * one column, the deck fills the screen with the action bar in thumb reach.
 */
import { Heart, Layers, Settings, Sprout } from 'lucide-react'
import type { ReactNode } from 'react'
import { FeedbackProvider } from './components/Feedback'
import { Link } from './components/Link'
import { useRoute, type Route } from './router'
import { LikedView } from './views/Liked'
import { SeedsView } from './views/Seeds'
import { SettingsView } from './views/Settings'
import { TodayView } from './views/Today'

const NAV: readonly { readonly route: Route; readonly label: string; readonly icon: ReactNode }[] = [
  { route: { view: 'today' }, label: '今日', icon: <Layers size={18} aria-hidden="true" /> },
  { route: { view: 'liked' }, label: '已喜欢', icon: <Heart size={18} aria-hidden="true" /> },
  { route: { view: 'seeds' }, label: '种子', icon: <Sprout size={18} aria-hidden="true" /> },
  { route: { view: 'settings' }, label: '设置', icon: <Settings size={18} aria-hidden="true" /> },
]

function View({ route }: { route: Route }) {
  switch (route.view) {
    case 'today':
      return <TodayView />
    case 'deck':
      return <TodayView day={route.day} />
    case 'liked':
      return <LikedView />
    case 'seeds':
      return <SeedsView />
    case 'settings':
      return <SettingsView />
  }
}

export function App() {
  const route = useRoute()
  const active = route.view === 'deck' ? 'today' : route.view
  return (
    <FeedbackProvider>
      <div className="shell">
        <header className="topbar">
          <Link to={{ view: 'today' }} className="brand">
            论文雷达
          </Link>
          <nav aria-label="主导航" className="nav">
            {NAV.map((item) => (
              <Link key={item.label} to={item.route} className="nav-link" current={item.route.view === active}>
                {item.icon}
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
        </header>
        <main id="main" tabIndex={-1} className={`main main-${route.view}`}>
          <View route={route} />
        </main>
      </div>
    </FeedbackProvider>
  )
}
