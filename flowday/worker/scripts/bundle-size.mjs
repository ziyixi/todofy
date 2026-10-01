#!/usr/bin/env node
// FlowDay's Worker bundle against the Workers Free script size limit (3 MiB compressed, ../../docs/design.md "Free
// limits"), measured by the shared tools/bundle-size: every module `wrangler deploy --dry-run --outdir <dir>` wrote.
// FlowDay's budget is that limit; a ratchet below it (as Lab's) is a decision for FlowDay's own commit.
//
//   node scripts/bundle-size.mjs <outdir>
import { checkWorkerBundle, FREE_LIMIT_GZIP_BYTES, isMain } from '../../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = FREE_LIMIT_GZIP_BYTES

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('FlowDay', process.argv[2], BUDGET_GZIP_BYTES)
