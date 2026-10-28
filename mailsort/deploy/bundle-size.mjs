#!/usr/bin/env node
// The mailsort Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-06
// at about 1.2 times the measured bundle (110.0 KiB gzip: mailsort.ui.v1 and ops.v1, the protobuf-es runtime,
// the HTTP runtime of proto/ts, packages/edge-auth and the pipeline). Raise it only in the commit that needs it, saying
// why there. The UI's own budget is in ../web/scripts/js-budget.mjs.
// 2026-10-11: flat-label consolidation adds the owner API and bounded Gmail work; Linux CI measures 135.1 KiB.
// Use a 140 KiB budget with modest build headroom; the platform limit and CPU/model budgets are unchanged.
// 2026-10-24: fallback provenance, accurate counts and explicit unread recheck bring the bundle to about 141 KiB.
// 148 KiB leaves build headroom; this is a code-size check, not a model or spending budget.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/mailsort-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

// October 26: bounded recent-read intake and its explicit flow outcome measure 150.1 KiB in Linux CI.
// October 27: the retired Workers AI path, rechecks, label consolidation and Codex usage ledger, and the shared
// inference monitor descriptor leaving ops-v1, bring the bundle to 135.8 KiB. Lowered to 138 KiB with the same modest
// build headroom; platform, CPU, model and spending limits are unchanged.
export const BUDGET_GZIP_BYTES = 138 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The mailsort app', process.argv[2], BUDGET_GZIP_BYTES)
