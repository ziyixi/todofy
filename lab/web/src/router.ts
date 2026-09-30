/**
 * Path routes (the Worker serves index.html for unknown paths: wrangler.toml `single-page-application`).
 * `/deck/<day>` is also the link Todofy's parent task carries (docs/design.md §9).
 */
import { useSyncExternalStore } from 'react'

export type Route =
  | { readonly view: 'today' }
  | { readonly view: 'deck'; readonly day: string }
  | { readonly view: 'liked' }
  | { readonly view: 'seeds' }
  | { readonly view: 'settings' }

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function parsePath(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '')
  const [head, second] = parts
  if (head === 'deck' && parts.length === 2 && second && DAY.test(second)) return { view: 'deck', day: second }
  if (parts.length === 1 && (head === 'liked' || head === 'seeds' || head === 'settings')) return { view: head }
  return { view: 'today' }
}

export function routePath(route: Route): string {
  return route.view === 'today' ? '/' : route.view === 'deck' ? `/deck/${route.day}` : `/${route.view}`
}

const EVENT = 'lab:navigate'

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener)
  window.addEventListener(EVENT, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(EVENT, listener)
  }
}

const snapshot = () => window.location.pathname

export function useRoute(): Route {
  return parsePath(useSyncExternalStore(subscribe, snapshot, snapshot))
}

export function navigate(route: Route): void {
  const path = routePath(route)
  if (path !== window.location.pathname) window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(EVENT))
  window.scrollTo?.(0, 0)
}
