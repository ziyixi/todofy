// The UI's JavaScript budget (finish-dist.mjs runs it on every build, so `npm run build` in CI fails over it), measured
// by the shared tools/bundle-size. The page loads every chunk of dist/assets on its first visit, so their gzip total is
// what the owner's phone downloads. A ratchet at about 1.15 times the measured total: 45.2 KiB on 2026-10-06 (no
// framework; the protobuf-es runtime, the embedded mailsort.ui.v1 descriptors, the shared HTTP client and the eight
// views; budget 54), then 57.9 KiB with round 2 (budget 67): d3-sankey's layout with the parts of d3-array, d3-shape
// and d3-path it uses, 2.8 KiB, and about 9 KiB for the 流程 and 导入导出 views, the label tree, the diagram's own
// SVG code and the larger descriptors (import, export, MailFlow). Raise it only in the commit that needs it, saying
// why there.
import { assetsJsSize, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 67 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}
