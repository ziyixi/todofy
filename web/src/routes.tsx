import { Navigate, type RouteObject } from 'react-router'
import { Shell } from './components/Shell'
import { AttentionPage } from './pages/AttentionPage'
import { BudgetPage } from './pages/BudgetPage'
import { DigestPage } from './pages/DigestPage'
import { EventDetailPage } from './pages/EventDetailPage'
import { EventsPage } from './pages/EventsPage'
import { HealthPage } from './pages/HealthPage'
import { MorePage } from './pages/MorePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { RemindersPage } from './pages/RemindersPage'
import { RouteError } from './pages/RouteError'
import { SetupPage } from './pages/SetupPage'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/attention" replace /> },
      { path: 'attention', element: <AttentionPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'events/:eventId', element: <EventDetailPage /> },
      { path: 'digest', element: <DigestPage /> },
      { path: 'reminders', element: <RemindersPage /> },
      { path: 'budget', element: <BudgetPage /> },
      { path: 'health', element: <HealthPage /> },
      { path: 'setup', element: <SetupPage /> },
      { path: 'more', element: <MorePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
