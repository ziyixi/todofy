#!/usr/bin/env node
// The brief Worker's bundle against its budget and the Workers Free script size limit (3 MiB compressed), measured by
// the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
//
// BUDGET_GZIP_BYTES is the app's ratchet, well below the limit, so that growth is a decision. It was set on 2026-10-10
// at about 1.25 times the measured bundle (272.0 KiB gzip by this script, 285.0 KiB in wrangler's own summary: the
// Anthropic TypeScript SDK, about 114 KiB of it, brief.ui.v1 and ops.v1, the protobuf-es runtime, the HTTP runtime of
// proto/ts, packages/edge-auth and the bundled content config: the registry, the profile and the writing policy).
// Raise it only in the commit that needs it, saying why there.
//
//   node ../deploy/bundle-size.mjs "$RUNNER_TEMP/brief-bundle"     (from worker/, after the dry run's --outdir)
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 340 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('The brief app', process.argv[2], BUDGET_GZIP_BYTES)
