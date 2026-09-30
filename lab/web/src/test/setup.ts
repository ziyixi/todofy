import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// A fixed zone east of UTC, so every test proves that times follow the browser's zone, not UTC.
process.env.TZ = 'Asia/Shanghai'

/** Tests flip this to exercise the prefers-reduced-motion path. */
export const motion = { reduced: false }

beforeEach(() => {
  motion.reduced = false
  // jsdom implements neither matchMedia nor scrolling.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? motion.reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
  window.scrollTo = (() => undefined)
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
