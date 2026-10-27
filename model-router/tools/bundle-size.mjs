import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

export const BUDGET_GZIP_BYTES = 256 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Model Router', process.argv[2], BUDGET_GZIP_BYTES)
