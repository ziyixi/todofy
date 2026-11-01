import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

// Initial ratchet: 69.2 KiB gzip measured locally on 2026-11-01, with the owner UI and both descriptors.
export const BUDGET_GZIP_BYTES = 84 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Storage', process.argv[2], BUDGET_GZIP_BYTES)
