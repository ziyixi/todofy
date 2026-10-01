import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JS_BUDGET_GZIP_BYTES, jsBudgetProblem, jsSize } from './js-budget.mjs'

describe("the UI's JavaScript budget", () => {
  it('sums the gzip size of the JavaScript chunks only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-dist-'))
    try {
      writeFileSync(join(dir, 'index-a.js'), 'const x = 1;\n'.repeat(200))
      writeFileSync(join(dir, 'index-b.css'), randomBytes(50_000))
      const size = jsSize(dir)
      expect(size.raw).toBe('const x = 1;\n'.length * 200)
      expect(size.gzip).toBeLessThan(size.raw)
      expect(jsBudgetProblem(size)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails over the budget', () => {
    expect(jsBudgetProblem({ gzip: JS_BUDGET_GZIP_BYTES })).toBeNull()
    expect(jsBudgetProblem({ gzip: JS_BUDGET_GZIP_BYTES + 1 })).toMatch(/over its budget/)
  })
})
