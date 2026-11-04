import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

// Ratchet: 94.8 KiB gzip measured locally on 2026-11-04, after the Dropbox space and the object scan (88.8 KiB on
// 2026-11-03 with the three-tab owner console and request counters; 69.2 KiB on 2026-11-01 with the first owner UI).
export const BUDGET_GZIP_BYTES = 96 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Storage', process.argv[2], BUDGET_GZIP_BYTES)
