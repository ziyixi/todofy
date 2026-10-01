import { afterEach, vi } from 'vitest'

// A fixed zone east of UTC, so the tests prove that times follow the browser's zone, not UTC.
process.env.TZ = 'Asia/Shanghai'

afterEach(() => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
