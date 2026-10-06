import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { FREE_LIMIT_GZIP_BYTES } from '../../../tools/bundle-size/bundle-size.mjs'
import { BUDGET_GZIP_BYTES } from '../bundle-size.mjs'

const SCRIPT = fileURLToPath(new URL('../bundle-size.mjs', import.meta.url))

/** Runs the script CI runs on a dry-run directory holding one module of `bytes` incompressible bytes. */
function run(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'mailsort-bundle-'))
  try {
    writeFileSync(join(dir, 'index.js'), randomBytes(bytes))
    return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("mailsort's budget is a ratchet well below the Workers Free limit", () => {
  assert.equal(BUDGET_GZIP_BYTES, 135 * 1024)
  assert.ok(BUDGET_GZIP_BYTES < FREE_LIMIT_GZIP_BYTES / 4)
})

test('the script passes a bundle within the budget and fails one over it', () => {
  const fits = run(BUDGET_GZIP_BYTES / 2)
  assert.equal(fits.status, 0, fits.stderr)
  assert.match(fits.stdout, /^The mailsort app's Worker bundle: 1 module\(s\), .*\(budget 150\.0 KiB, limit 3072\.0 KiB gzip\)\.$/m)
  const over = run(BUDGET_GZIP_BYTES + 4096)
  assert.equal(over.status, 1)
  assert.match(over.stderr, /^The mailsort app's Worker bundle is over its bundle budget/m)
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2)
})
