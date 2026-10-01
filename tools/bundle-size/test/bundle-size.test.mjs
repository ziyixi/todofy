// node --test tools/bundle-size/test/*.test.mjs (the Changes job). Synthetic directories only.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  FREE_LIMIT_GZIP_BYTES,
  assetsJsSize,
  checkWorkerBundle,
  uiProblem,
  workerBundleSize,
  workerProblem,
} from '../bundle-size.mjs'

/** A directory with these files (a number is that many incompressible bytes, so gzip is about the raw size). */
function directory(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), typeof bytes === 'number' ? randomBytes(bytes) : bytes)
  }
  return dir
}

function withDirectory(files, check) {
  const dir = directory(files)
  try {
    check(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs `check` with console.log and console.error captured. */
function captured(check) {
  const lines = { log: [], error: [] }
  const saved = { log: console.log, error: console.error }
  console.log = (line) => lines.log.push(line)
  console.error = (line) => lines.error.push(line)
  try {
    return { result: check(), ...lines }
  } finally {
    Object.assign(console, saved)
  }
}

test('a Worker bundle counts every module, recursively, but no source map or other file', () => {
  withDirectory({ 'index.js': 'export default {}\n'.repeat(100), 'index.js.map': 5000, 'README.md': 'x', 'chunks/a.mjs': 10, 'b.wasm': 3 }, (dir) => {
    const size = workerBundleSize(dir)
    assert.deepEqual(size.files, ['b.wasm', 'a.mjs', 'index.js'])
    assert.equal(size.raw, 'export default {}\n'.length * 100 + 10 + 3)
    assert.ok(size.gzip > 0 && size.gzip < size.raw)
  })
})

test('a UI counts the JavaScript directly in its assets directory only', () => {
  withDirectory({ 'index-a.js': 'const x = 1;\n'.repeat(200), 'index-b.css': 50_000, 'nested/c.js': 50_000 }, (dir) => {
    const size = assetsJsSize(dir)
    assert.deepEqual(size.files, ['index-a.js'])
    assert.equal(size.raw, 'const x = 1;\n'.length * 200)
    assert.ok(size.gzip < size.raw)
  })
})

test('a Worker fails over its budget, over the Free limit and without a module', () => {
  const budget = 100 * 1024
  assert.equal(workerProblem({ gzip: budget, files: ['index.js'] }, budget), null)
  assert.match(workerProblem({ gzip: budget + 1, files: ['index.js'] }, budget) ?? '', /budget/)
  // The limit holds whatever an app's budget says.
  assert.match(workerProblem({ gzip: FREE_LIMIT_GZIP_BYTES + 1, files: ['index.js'] }, 2 * FREE_LIMIT_GZIP_BYTES) ?? '', /limit/)
  assert.match(workerProblem({ gzip: 0, files: [] }, budget) ?? '', /no bundled module/)
})

test('a UI fails over its budget and without JavaScript', () => {
  assert.equal(uiProblem({ gzip: 10, files: ['a.js'] }, 10), null)
  assert.match(uiProblem({ gzip: 11, files: ['a.js'] }, 10) ?? '', /over its budget/)
  assert.match(uiProblem({ gzip: 0, files: [] }, 10) ?? '', /no JavaScript/)
})

test('the check prints the sizes and exits 0, 1 over the budget, 2 without a directory', () => {
  withDirectory({ 'index.js': 4096 }, (dir) => {
    const fits = captured(() => checkWorkerBundle('App', dir, 64 * 1024))
    assert.equal(fits.result, 0)
    assert.match(fits.log.join('\n'), /^App's Worker bundle: 1 module\(s\), 4\.0 KiB raw, .* gzip \(budget 64\.0 KiB, limit 3072\.0 KiB gzip\)\.$/)
    const over = captured(() => checkWorkerBundle('App', dir, 1024))
    assert.equal(over.result, 1)
    assert.match(over.error.join('\n'), /^App's Worker bundle is over its bundle budget/)
  })
  assert.equal(captured(() => checkWorkerBundle('App', undefined, 1024)).result, 2)
})
