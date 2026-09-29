import { useRouteError } from 'react-router'
import { Button, ErrorPanel } from '../components/ui'

/** Last resort for a rendering bug: show what failed instead of a blank page. */
export function RouteError() {
  const error = useRouteError()
  return (
    <main className="route-error">
      <h1>页面出错了</h1>
      <ErrorPanel error={error} />
      <Button variant="primary" onClick={() => window.location.reload()}>
        重新加载
      </Button>
    </main>
  )
}
