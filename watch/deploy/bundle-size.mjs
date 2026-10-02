#!/usr/bin/env node
// The watch Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-01
// at about 1.2 times the measured bundle (101.4 KiB gzip: watch.ui.v1, the protobuf-es runtime, the HTTP runtime of
// proto/ts, packages/edge-auth and the pipeline); the wire profile's rule checker in proto/ts then made it 105.1 KiB,
// and the review fixes (the per-hop etiquette gate, the rows meter and bounds, the confirmation window) 110.1 KiB.
// W3 added the Todofy sink (task-intent-v1's generated code: 117.7 KiB) and the Ops entrypoint (ops.v1's generated
// descriptors and codec: 125.2 KiB), so the budget went from 122 to 140 KiB, about 1.1 times that, on 2026-10-01.
// The review fixes of the sink (status polls, the daily-limit budget, folding into the digest) made it 126.9 KiB.
// Raise it only in the commit that needs it, saying why there. The UI's
// own budget is in ../web/scripts/js-budget.mjs.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/watch-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 140 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The watch app', process.argv[2], BUDGET_GZIP_BYTES)
