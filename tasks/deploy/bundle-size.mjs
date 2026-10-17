#!/usr/bin/env node
import { checkWorkerBundle, isMain } from '../../tools/bundle-size/bundle-size.mjs';

// Initial native API + chrono/rrule bundle: 109.07 KiB gzip on 2026-10-17, with 20% growth allowance.
export const BUDGET_GZIP_BYTES = 132 * 1024;

if (isMain(import.meta.url)) {
  process.exitCode = checkWorkerBundle('Tasks', process.argv[2], BUDGET_GZIP_BYTES);
}
