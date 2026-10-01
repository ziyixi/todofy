#!/usr/bin/env node
// The size of the Worker bundle that `wrangler deploy --dry-run --outdir <dir>` wrote, against two bounds:
//
// - LIMIT_GZIP_BYTES, 3 MiB compressed: the Workers Free script size limit (../docs/design.md §1).
// - BUDGET_GZIP_BYTES: Lab's own budget, a ratchet well below the limit, so that growth is a decision. It was
//   set on 2026-10-01 at about 1.2 times the measured bundle (104.5 KiB gzip with lab.ui.v1, the protobuf-es
//   runtime and the HTTP runtime of proto/ts). Raise it only in the commit that needs it, saying why there.
//
// Static assets (the UI) do not count: Workers Static Assets serves them (the UI's own budget is in
// ../web/scripts/check-dist.mjs). Source maps are not uploaded as code and do not count either.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/lab-bundle"     (from worker/, after the dry run's --outdir)
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export const LIMIT_GZIP_BYTES = 3 * 1024 * 1024
export const BUDGET_GZIP_BYTES = 128 * 1024

/** Raw and gzip bytes of every module wrangler bundled (source maps excluded). */
export function bundleSize(dir) {
  let raw = 0
  let gzip = 0
  const files = []
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(m?js|wasm)$/.test(name)) {
        const bytes = readFileSync(full)
        raw += bytes.length
        gzip += gzipSync(bytes, { level: 9 }).length
        files.push(name)
      }
    }
  }
  walk(dir)
  return { raw, gzip, files }
}

/** The verdict on a measured bundle: null when it fits, else why not. */
export function verdict({ gzip, files }) {
  if (files.length === 0) return 'no bundled module'
  if (gzip > LIMIT_GZIP_BYTES) return 'over the Workers Free script size limit'
  if (gzip > BUDGET_GZIP_BYTES) return "over Lab's bundle budget (raise BUDGET_GZIP_BYTES only on purpose, with the reason)"
  return null
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: bundle-size.mjs <outdir of wrangler deploy --dry-run>')
    process.exit(2)
  }
  const size = bundleSize(dir)
  const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`
  console.log(
    `Worker bundle: ${size.files.length} module(s), ${kib(size.raw)} raw, ${kib(size.gzip)} gzip (budget ${kib(BUDGET_GZIP_BYTES)}, limit ${kib(LIMIT_GZIP_BYTES)} gzip).`,
  )
  const problem = verdict(size)
  if (problem !== null) {
    console.error(`The Worker bundle is ${problem}.`)
    process.exit(1)
  }
}
