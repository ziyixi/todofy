import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

function subscribe(listener: () => void): () => void {
  const list = media()
  list?.addEventListener?.('change', listener)
  return () => list?.removeEventListener?.('change', listener)
}

const snapshot = () => media()?.matches ?? false

/** `prefers-reduced-motion: reduce`: no tilt, fly-out or spring; cross-fades instead (docs/ux.md §3). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
