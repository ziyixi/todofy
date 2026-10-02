#!/usr/bin/env node
// The gateway Worker "todofy"'s bundle against its budget and the Workers Free script size limit (3 MiB compressed),
// measured by the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote for
// gateway/wrangler.toml. todofy-core (Python, vendored by pywrangler) is not measured here.
//
// BUDGET_GZIP_BYTES is the gateway's ratchet, well below the limit, so that growth is a decision. It was set on
// 2026-10-02 at about 1.2 times the measured bundle (71.7 KiB gzip: the transcoder of todofy.ui.v1 with the protobuf-es
// runtime, the generated descriptors and the HTTP runtime of proto/ts, and packages/edge-auth; 11.8 KiB before
// todofy.ui.v1, docs/gateway-contract.md §8). Raise it only in the commit that needs it, saying why there. The UI's
// own budget is in ../web/scripts/js-budget.mjs.
//
//   node deploy/bundle-size.mjs "$RUNNER_TEMP/todofy-gateway-bundle"     (from todofy/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 86 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle("Todofy's gateway", process.argv[2], BUDGET_GZIP_BYTES)
