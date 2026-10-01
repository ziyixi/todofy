// The UI's JavaScript budget (finish-dist.mjs runs it on every build, so `npm run build` in CI fails over it), measured
// by the shared tools/bundle-size. The page loads every chunk of dist/assets on its first visit, so their gzip total is
// what the owner's phone downloads. A ratchet set at about 1.2 times the measured total (46.1 KiB on 2026-10-01, 48.8 KiB with the wire profile's rule checker; no framework: the protobuf-es
// runtime, the embedded watch.ui.v1 descriptors, the shared HTTP client and the views); raise it only in the commit
// that needs it, saying why there.
import { assetsJsSize, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 56 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}
