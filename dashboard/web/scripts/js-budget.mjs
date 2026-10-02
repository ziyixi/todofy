// The UI's JavaScript budget (check-dist.mjs runs it on every build, so `npm run build` in CI fails over it), measured
// by the shared tools/bundle-size. The page loads every chunk of dist/assets on its first visit, so their gzip total is
// what the owner's phone downloads. A ratchet set on 2026-10-02 at about 1.2 times the measured total when the UI moved
// onto dashboard.ui.v1's typed client (157.9 KiB gzip, 112.7 before: React, TanStack Query, lucide's icons, and now the
// protobuf-es runtime, the wire codec, the HTTP client and the embedded descriptors of dashboard.ui.v1, ops.v1 and
// google/api); raise it only in the commit that needs it, saying why there.
import { assetsJsSize, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 192 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}
