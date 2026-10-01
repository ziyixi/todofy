// The UI's JavaScript budget (check-dist.mjs runs it on every build, so `npm run build` in CI fails over it), measured
// by the shared tools/bundle-size. The page loads every chunk of dist/assets on its first visit, so their gzip total is
// what the owner's phone downloads. A ratchet set on 2026-10-01 at about 1.2 times the measured total (137 KiB gzip:
// React, TanStack Query, the protobuf-es runtime and the embedded lab.ui.v1 descriptors); raise it only in the commit
// that needs it, saying why there.
import { assetsJsSize, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 160 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}
