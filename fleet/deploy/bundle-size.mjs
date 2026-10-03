import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 112 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Fleet', process.argv[2], BUDGET_GZIP_BYTES)
