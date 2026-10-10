#!/usr/bin/env node
// The recall Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-10
// at about 1.2 times the measured bundle (102.8 KiB gzip: recall.ui.v1, recall.ingest.v1, recall.archive.v1 and ops.v1,
// the protobuf-es runtime, the HTTP runtime of proto/ts, packages/edge-auth, the shared scrubber, denylist and
// segmenter). Raise it only in the commit that needs it, saying why there. The UI's own budget is in
// ../web/scripts/js-budget.mjs.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/recall-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 125 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The recall app', process.argv[2], BUDGET_GZIP_BYTES)
