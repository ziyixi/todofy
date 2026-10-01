#!/usr/bin/env node
// The watch Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-01
// at about 1.2 times the measured bundle (101.4 KiB gzip: watch.ui.v1, the protobuf-es runtime, the HTTP runtime of
// proto/ts, packages/edge-auth and the pipeline); the wire profile's rule checker in proto/ts then made it 105.1 KiB. Raise it only in the commit that needs it, saying why there. The UI's
// own budget is in ../web/scripts/js-budget.mjs.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/watch-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 122 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The watch app', process.argv[2], BUDGET_GZIP_BYTES)
