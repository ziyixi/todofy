#!/usr/bin/env node
// The Worker "home"'s bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured
// by the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the dashboard's ratchet, well below the limit, so that growth is a decision. It was set on
// 2026-10-01 at about 1.2 times the measured bundle: 89.5 KiB gzip once ops-v1 moved onto proto/ (the protobuf-es
// runtime, the wire codec with its value rules and ops.v1's descriptors replaced the hand-written schema and
// validate.mjs: +35.2 KiB on 54.3 KiB). Raised on 2026-10-02 to about 1.2 times 116.7 KiB, measured with the production
// dry run when the owner API moved onto dashboard.ui.v1 (92.2 → 116.7 KiB: the shared HTTP transcoder and its path,
// rule and google.rpc.Status code, and the embedded descriptors of dashboard.ui.v1 and google/api, which the route
// table is read from; the views themselves still pass through as HomeState serialized them). Raise it only in the
// commit that needs it, saying why there.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/home-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 140 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The dashboard', process.argv[2], BUDGET_GZIP_BYTES)
