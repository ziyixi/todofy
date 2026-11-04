import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

// Ratchet: 88.8 KiB gzip measured locally on 2026-11-03, after the three-tab owner console, the request
// counters and the overview descriptor (69.2 KiB on 2026-11-01 with the first owner UI and both descriptors).
export const BUDGET_GZIP_BYTES = 96 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Storage', process.argv[2], BUDGET_GZIP_BYTES)
