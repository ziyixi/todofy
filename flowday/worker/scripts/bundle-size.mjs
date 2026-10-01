#!/usr/bin/env node
// The size of the Worker bundle that `wrangler deploy --dry-run --outdir <dir>` wrote, against the 3 MiB
// compressed (gzip) budget: the Workers Free script size limit as this repository's FlowDay design states it
// (../../docs/design.md "Free limits"). Static assets do not count; they are served by Workers Static Assets.
//
//   node scripts/bundle-size.mjs <outdir>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const BUDGET_GZIP_BYTES = 3 * 1024 * 1024

/** Raw and gzip bytes of every module wrangler bundled (source maps excluded). */
export function bundleSize(dir) {
  let raw = 0
  let gzip = 0
  const files = []
  const walk = (path) => {
    for (const name of readdirSync(path)) {
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: bundle-size.mjs <outdir of wrangler deploy --dry-run>')
    process.exit(2)
  }
  const { raw, gzip, files } = bundleSize(dir)
  if (files.length === 0) {
    console.error(`No bundled module in ${dir}.`)
    process.exit(1)
  }
  const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`
  console.log(`Worker bundle: ${files.length} module(s), ${kib(raw)} raw, ${kib(gzip)} gzip (budget ${kib(BUDGET_GZIP_BYTES)} gzip).`)
  if (gzip > BUDGET_GZIP_BYTES) {
    console.error('The Worker bundle is over its compressed size budget.')
    process.exit(1)
  }
}
