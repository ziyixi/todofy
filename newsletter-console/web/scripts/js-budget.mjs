// The UI's JavaScript budget, measured by the shared tools/bundle-size: `npm run build` runs it on the built assets
// (../dist/assets), so a build over the budget fails in CI. The page loads every chunk of the assets on its first
// visit, so their gzip total is what the owner's phone downloads. A ratchet set at about 1.2 times the measured total:
// 114.0 KiB gzip on 2026-10-29 for the shell (React, TanStack Query, the protobuf-es runtime, the embedded
// newsletter.ui.v1 descriptors and the shared HTTP client). Raise it only in the commit that needs it (the console's
// views), saying why there.
import { fileURLToPath } from 'node:url'
import { assetsJsSize, isMain, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 140 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}

if (isMain(import.meta.url)) {
  const size = jsSize(fileURLToPath(new URL('../dist/assets/', import.meta.url)))
  const problem = jsBudgetProblem(size)
  if (problem !== null) {
    console.error(`Newsletter console UI: ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`Newsletter console UI JavaScript: ${(size.gzip / 1024).toFixed(1)} KiB gzip in ${size.files.length} file(s) (budget ${JS_BUDGET_GZIP_BYTES / 1024} KiB).`)
  }
}
