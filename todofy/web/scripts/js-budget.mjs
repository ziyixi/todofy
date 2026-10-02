// The UI's JavaScript budget (`npm run build` runs this file after vite, so a build over it fails in CI), measured by
// the shared tools/bundle-size. The page loads every chunk of ../uiassets/dist/assets on its first visit, so their gzip
// total is what the owner's phone downloads. A ratchet set on 2026-10-02 at about 1.2 times the measured total (172.3
// KiB gzip: React, TanStack Query, the protobuf-es runtime, the embedded todofy.ui.v1 descriptors and the shared HTTP
// client; 131.9 KiB before todofy.ui.v1); raise it only in the commit that needs it, saying why there.
import { assetsJsSize, isMain, kib, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 208 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}

if (isMain(import.meta.url)) {
  const size = jsSize(new URL('../../uiassets/dist/assets/', import.meta.url).pathname)
  const problem = jsBudgetProblem(size)
  if (problem !== null) {
    console.error(problem)
    process.exitCode = 1
  } else {
    console.log(`The UI's JavaScript is ${kib(size.gzip)} gzip (budget ${kib(JS_BUDGET_GZIP_BYTES)}, scripts/js-budget.mjs).`)
  }
}
