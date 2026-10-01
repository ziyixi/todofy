#!/usr/bin/env node
// Lab's Worker bundle against its budget and the Workers Free script size limit (3 MiB compressed, ../docs/design.md
// §1), measured by the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is Lab's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-01 at
// about 1.2 times the measured bundle (104.5 KiB gzip with lab.ui.v1, the protobuf-es runtime and the HTTP runtime of
// proto/ts). Raise it only in the commit that needs it, saying why there. The UI's own budget is in
// ../web/scripts/js-budget.mjs.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/lab-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 128 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Lab', process.argv[2], BUDGET_GZIP_BYTES)
