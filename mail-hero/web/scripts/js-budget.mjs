// The UI's JavaScript budget, measured by the shared tools/bundle-size: `npm run build` runs it on the built assets
// (../uiassets/dist/assets), so a build over the budget fails in CI. The page loads every chunk of the assets on its
// first visit, so their gzip total is what the owner's browser downloads. A ratchet set on 2026-10-02 at about 1.2
// times the measured total once the UI called mailhero.ui.v2 through the shared typed client: 162 KiB gzip (React,
// TanStack Query, React Router, the icons, the protobuf-es runtime and the embedded mailhero.ui.v2 descriptors; the
// hand-written client before it was 121 KiB). Raise it only in the commit that needs it, saying why there.
import { fileURLToPath } from 'node:url'
import { assetsJsSize, isMain, uiProblem } from '../../../tools/bundle-size/bundle-size.mjs'

export const JS_BUDGET_GZIP_BYTES = 195 * 1024

/** Raw and gzip bytes of every .js file directly in `assetsDir`. */
export const jsSize = assetsJsSize

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES)
  return problem === null ? null : `the UI's JavaScript is ${problem}`
}

if (isMain(import.meta.url)) {
  const size = jsSize(fileURLToPath(new URL('../../uiassets/dist/assets/', import.meta.url)))
  const problem = jsBudgetProblem(size)
  if (problem !== null) {
    console.error(`Mail Hero's UI: ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`Mail Hero's UI JavaScript: ${(size.gzip / 1024).toFixed(1)} KiB gzip in ${size.files.length} file(s) (budget ${JS_BUDGET_GZIP_BYTES / 1024} KiB).`)
  }
}
