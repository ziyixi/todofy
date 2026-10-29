import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs'

// A ratchet set at about 1.2 times the measured bundle: 61.9 KiB gzip on 2026-10-29 (edge-auth, the shared transcoder
// and the embedded newsletter.ui.v1 descriptors; the Worker holds no data). Raise it only in the commit that needs it,
// saying why there.
export const BUDGET_GZIP_BYTES = 76 * 1024

if (isMain(import.meta.url)) process.exitCode = checkWorkerBundle('Newsletter console', process.argv[2], BUDGET_GZIP_BYTES)
