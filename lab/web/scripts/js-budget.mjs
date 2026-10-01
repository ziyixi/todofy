// The UI's JavaScript budget (check-dist.mjs runs it on every build, so `npm run build` in CI fails over it).
// The page loads every chunk of dist/assets on its first visit, so their gzip total is what the owner's phone
// downloads. A ratchet set on 2026-10-01 at about 1.2 times the measured total (137 KiB gzip: React, TanStack
// Query, the protobuf-es runtime and the embedded lab.ui.v1 descriptors); raise it only in the commit that needs
// it, saying why there.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const JS_BUDGET_GZIP_BYTES = 160 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export function jsSize(assetsDir) {
  let raw = 0
  let gzip = 0
  for (const name of readdirSync(assetsDir).sort()) {
    if (!name.endsWith('.js')) continue
    const bytes = readFileSync(join(assetsDir, name))
    raw += bytes.length
    gzip += gzipSync(bytes, { level: 9 }).length
  }
  return { raw, gzip }
}

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem({ gzip }) {
  return gzip > JS_BUDGET_GZIP_BYTES ? `the UI's JavaScript is ${(gzip / 1024).toFixed(1)} KiB gzip, over its budget of ${(JS_BUDGET_GZIP_BYTES / 1024).toFixed(1)} KiB` : null
}
