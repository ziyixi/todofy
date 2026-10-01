import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { BUDGET_GZIP_BYTES, LIMIT_GZIP_BYTES, bundleSize, verdict } from '../bundle-size.mjs'

const SCRIPT = fileURLToPath(new URL('../bundle-size.mjs', import.meta.url))

/** A dry-run output directory with these files (incompressible bytes, so gzip size is about the raw size). */
function outdir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-bundle-'))
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), typeof bytes === 'number' ? randomBytes(bytes) : bytes)
  }
  return dir
}

test('the budget is a ratchet below the Workers Free limit', () => {
  assert.equal(LIMIT_GZIP_BYTES, 3 * 1024 * 1024)
  assert.ok(BUDGET_GZIP_BYTES < LIMIT_GZIP_BYTES / 4)
})

test('counts the modules, not source maps or other files', () => {
  const dir = outdir({ 'index.js': 'export default {}\n'.repeat(100), 'index.js.map': 5000, 'README.md': 'x', 'chunks/a.mjs': 10 })
  try {
    const size = bundleSize(dir)
    assert.deepEqual(size.files, ['a.mjs', 'index.js'])
    assert.equal(size.raw, 'export default {}\n'.length * 100 + 10)
    assert.ok(size.gzip < size.raw)
    assert.equal(verdict(size), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails over the budget, over the limit and without a module', () => {
  assert.match(verdict({ gzip: BUDGET_GZIP_BYTES + 1, files: ['index.js'] }) ?? '', /budget/)
  assert.match(verdict({ gzip: LIMIT_GZIP_BYTES + 1, files: ['index.js'] }) ?? '', /limit/)
  assert.match(verdict({ gzip: 0, files: [] }) ?? '', /no bundled module/)
  const dir = outdir({ 'index.js': BUDGET_GZIP_BYTES + 4096 })
  try {
    const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /over Lab's bundle budget/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
