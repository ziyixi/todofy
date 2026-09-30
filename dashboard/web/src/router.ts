/**
 * Hash routes of the four views (docs/design-v2.md §1). Hash routing needs no Worker change behind
 * Access, and the old section anchors of v1 keep working through LEGACY_ANCHORS.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ViewId } from '../../worker/src/api-v2-types.ts'

export type Route =
  | { readonly view: 'home' }
  | { readonly view: 'flows'; readonly flow?: string }
  | { readonly view: 'cloudflare'; readonly script?: string }
  | { readonly view: 'ops' }

const FLOW_ID = /^[a-z][a-z0-9-]{0,31}$/
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** v1 section anchors → the route that now holds that content. */
export const LEGACY_ANCHORS: Readonly<Record<string, string>> = {
  '#apps': '#/',
  '#app-mail-hero': '#/ops',
  '#app-todofy': '#/ops',
  '#quota': '#/cloudflare',
  '#canary': '#/flows/mail-to-task',
  '#actions': '#/ops',
  '#digest': '#/ops',
}

/** A location hash → its route; anything unknown is 首页. */
export function parseHash(hash: string): Route {
  const legacy = Object.hasOwn(LEGACY_ANCHORS, hash) ? (LEGACY_ANCHORS[hash] as string) : hash
  const parts = legacy.replace(/^#\/?/, '').split('/').filter((part) => part !== '')
  const [view, ...rest] = parts
  if (view === 'flows') {
    const flow = rest.length === 1 && FLOW_ID.test(rest[0] as string) ? rest[0] : undefined
    return flow === undefined ? { view: 'flows' } : { view: 'flows', flow }
  }
  if (view === 'cloudflare') {
    const script = rest.length === 2 && rest[0] === 'worker' && SCRIPT.test(rest[1] as string) ? rest[1] : undefined
    return script === undefined ? { view: 'cloudflare' } : { view: 'cloudflare', script }
  }
  if (view === 'ops') return { view: 'ops' }
  return { view: 'home' }
}

/** The canonical hash of a route. */
export function routeHash(route: Route): string {
  switch (route.view) {
    case 'home':
      return '#/'
    case 'flows':
      return route.flow === undefined ? '#/flows' : `#/flows/${route.flow}`
    case 'cloudflare':
      return route.script === undefined ? '#/cloudflare' : `#/cloudflare/worker/${route.script}`
    case 'ops':
      return '#/ops'
  }
}

/** The tab a route belongs to. */
export function routeView(route: Route): ViewId {
  return route.view
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The current route, following hashchange. A v1 anchor is replaced by its canonical hash in place. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  useEffect(() => {
    if (Object.hasOwn(LEGACY_ANCHORS, hash)) window.history.replaceState(null, '', LEGACY_ANCHORS[hash])
  }, [hash])
  return parseHash(hash)
}
