#!/usr/bin/env node
// Mail Hero's Worker bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is Mail Hero's ratchet, well below the limit, so that growth is a decision. It was set on
// 2026-10-01 at about 1.2 times the measured bundle: 189.0 KiB gzip once ops-v1 moved onto proto/ (the protobuf-es
// runtime, the wire codec with its value rules and ops.v1's descriptors: +40.4 KiB on 148.6 KiB). Raised on 2026-10-02
// to about 1.2 times the bundle of the owner API on mailhero.ui.v2: 193.3 -> 228.3 KiB gzip (the shared transcoder and
// its path, rule, page-token and field-mask modules, mailhero.ui.v2's descriptors and google/api's, the handlers that
// map D1 rows to its messages, and the error copy). Raise it only in the commit that needs it, saying why there.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/mail-hero-bundle"     (from cloudflare/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 274 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Mail Hero', process.argv[2], BUDGET_GZIP_BYTES)
