#!/usr/bin/env node
// The links Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-01
// at about 1.2 times the measured bundle (67.5 KiB gzip: links.ui.v1, the protobuf-es runtime, the HTTP runtime of
// proto/ts and packages/edge-auth). Raise it only in the commit that needs it, saying why there. 90 KiB since the daily
// backup and the ops-v1 entrypoint brought in the ops-v1 descriptors (81.1 KiB measured, 2026-10-28; 82 KiB before).
// The launcher's own budget is in ../web/scripts/js-budget.mjs.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/links-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 90 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The links app', process.argv[2], BUDGET_GZIP_BYTES)
