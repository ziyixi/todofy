import type { MouseEvent, ReactNode } from 'react'
import { navigate, routePath, type Route } from '../router'

/** An in-app link: a real <a href> (new tab, copy link work) that navigates without a reload. */
export function Link({ to, className, children, current }: { to: Route; className?: string; children: ReactNode; current?: boolean }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={routePath(to)} className={className} onClick={onClick} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  )
}
