import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

beforeEach(() => window.history.replaceState(null, '', '/#/overview'))
afterEach(() => cleanup())
