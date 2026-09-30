import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// A fixed zone east of UTC, so every test proves that times follow the browser's zone, not UTC.
process.env.TZ = 'Asia/Shanghai'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
