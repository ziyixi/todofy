import { describe, expect, it } from 'vitest'
import { JS_BUDGET_GZIP_BYTES, jsBudgetProblem } from './js-budget.mjs'

// The measurement itself is tested with the shared tool (tools/bundle-size/test).
describe("the UI's JavaScript budget", () => {
  it('is a ratchet of 192 KiB gzip', () => {
    expect(JS_BUDGET_GZIP_BYTES).toBe(192 * 1024)
  })

  it('fails over the budget and without JavaScript', () => {
    expect(jsBudgetProblem({ gzip: JS_BUDGET_GZIP_BYTES, files: ['index.js'] })).toBeNull()
    expect(jsBudgetProblem({ gzip: JS_BUDGET_GZIP_BYTES + 1, files: ['index.js'] })).toMatch(/^the UI's JavaScript is .* over its budget/)
    expect(jsBudgetProblem({ gzip: 0, files: [] })).toMatch(/no JavaScript/)
  })
})
