// The UI's JavaScript budget (check-export.mjs runs it after every build, so the build step of CI fails over it),
// measured by the shared tools/bundle-size. The page loads every chunk of out/_next/static/chunks on its first visit,
// so their gzip total is what the owner's devices download. A ratchet set on 2026-10-02 at about 1.2 times the measured
// total when the UI moved to flowday.ui.v1 (398.9 KiB gzip: Next.js and React, the protobuf-es runtime, the shared HTTP
// client and the embedded flowday.ui.v1 descriptors, which added 36.1 KiB to the 362.8 KiB before); raise it only in
// the commit that needs it, saying why there.
import { assetsJsSize, uiProblem } from "../../../tools/bundle-size/bundle-size.mjs";

export const JS_BUDGET_GZIP_BYTES = 480 * 1024;

/** Raw and gzip bytes of every .js file directly in `chunksDir`. */
export const jsSize = assetsJsSize;

/** null when the total fits the budget, else the problem. */
export function jsBudgetProblem(size) {
  const problem = uiProblem(size, JS_BUDGET_GZIP_BYTES);
  return problem === null ? null : `the UI's JavaScript is ${problem}`;
}
