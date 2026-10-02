#!/usr/bin/env node
// FlowDay's Worker bundle against its budget and the Workers Free script size limit (3 MiB compressed,
// ../../docs/design.md "Free limits"), measured by the shared tools/bundle-size: every module `wrangler deploy --dry-run
// --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is FlowDay's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-02
// at about 1.2 times the measured bundle when the owner API moved to flowday.ui.v1 (114.3 KiB gzip: the protobuf-es
// runtime, the HTTP runtime of proto/ts and the flowday.ui.v1 descriptors added 58.2 KiB to the 56.1 KiB before).
// Raise it only in the commit that needs it, saying why there. The UI's own budget is in ../web/scripts/js-budget.mjs.
//
//   node scripts/bundle-size.mjs <outdir>
import { checkWorkerBundle, isMain } from '../../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 140 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('FlowDay', process.argv[2], BUDGET_GZIP_BYTES)
