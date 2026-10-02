// Bundle sizes against budgets, shared by the apps' CI (node --test tools/bundle-size/test/*.test.mjs in the Changes
// job). Build tooling only: an app's own script imports it by relative path, and no Worker bundles it.
//
// - A Worker: every module `wrangler deploy --dry-run --outdir <dir>` wrote (.js, .mjs, .wasm; source maps are not
//   uploaded as code), gzip-compressed, against FREE_LIMIT_GZIP_BYTES (the Workers Free script size limit, 3 MiB
//   compressed) and the app's own budget. Static assets do not count: Workers Static Assets serves them.
// - A UI: every .js file of the built assets directory, gzip-compressed (what a browser downloads on the first visit
//   when the page loads every chunk), against the app's own budget.
//
// Each app keeps its budgets as documented constants next to its CI command: its Worker's in
// <app>/deploy/bundle-size.mjs (FlowDay: flowday/worker/scripts/bundle-size.mjs) and its UI's in
// <app>/web/scripts/js-budget.mjs, for Lab, Mail Hero, Todofy, the dashboard, FlowDay, the links app and the watch
// app. A budget is a ratchet: set at about 1.2 times the measured size, so that growth is a decision, and raised
// only in the commit that needs it, saying why there. An app adopting proto/'s HTTP runtime adds about 27 KiB gzip
// to its Worker and 36 KiB gzip to its UI (proto/README.md "Cost"), which its budgets must make room for in that
// commit.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

/** The Workers Free script size limit, compressed (every app's docs/design.md "Free limits"). */
export const FREE_LIMIT_GZIP_BYTES = 3 * 1024 * 1024

/** The gzip size of some bytes, at the level the measurements use. */
function gzipSize(bytes) {
  return gzipSync(bytes, { level: 9 }).length
}

/** Raw and gzip bytes of every module wrangler bundled into `dir` (recursively; source maps excluded), with names. */
export function workerBundleSize(dir) {
  let raw = 0
  let gzip = 0
  const files = []
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(m?js|wasm)$/.test(name)) {
        const bytes = readFileSync(full)
        raw += bytes.length
        gzip += gzipSize(bytes)
        files.push(name)
      }
    }
  }
  walk(dir)
  return { raw, gzip, files }
}

/** Raw and gzip bytes of every .js file directly in a UI's built assets directory, with names. */
export function assetsJsSize(dir) {
  let raw = 0
  let gzip = 0
  const files = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.js')) continue
    const bytes = readFileSync(join(dir, name))
    raw += bytes.length
    gzip += gzipSize(bytes)
    files.push(name)
  }
  return { raw, gzip, files }
}

/** `bytes` as KiB with one decimal. */
export function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

/** The verdict on a measured Worker bundle: null when it fits, else why not. */
export function workerProblem({ gzip, files }, budgetGzipBytes) {
  if (files.length === 0) return 'no bundled module'
  if (gzip > FREE_LIMIT_GZIP_BYTES) return 'over the Workers Free script size limit'
  if (gzip > budgetGzipBytes) return 'over its bundle budget (raise the budget only on purpose, with the reason)'
  return null
}

/** The verdict on a UI's measured JavaScript: null when it fits, else why not. */
export function uiProblem({ gzip, files }, budgetGzipBytes) {
  if (files.length === 0) return 'no JavaScript in the built assets'
  if (gzip > budgetGzipBytes) return `${kib(gzip)} gzip, over its budget of ${kib(budgetGzipBytes)} (raise it only on purpose, with the reason)`
  return null
}

/**
 * Measures the dry run's output directory `dir` of the Worker of `app` and prints the result: 0 when it fits
 * `budgetGzipBytes` and the Free limit, 1 when it does not, 2 without a directory (usage).
 */
export function checkWorkerBundle(app, dir, budgetGzipBytes) {
  if (!dir) {
    console.error('Usage: bundle-size.mjs <outdir of wrangler deploy --dry-run>')
    return 2
  }
  const size = workerBundleSize(dir)
  console.log(
    `${app}'s Worker bundle: ${size.files.length} module(s), ${kib(size.raw)} raw, ${kib(size.gzip)} gzip ` +
      `(budget ${kib(budgetGzipBytes)}, limit ${kib(FREE_LIMIT_GZIP_BYTES)} gzip).`,
  )
  const problem = workerProblem(size, budgetGzipBytes)
  if (problem === null) return 0
  console.error(`${app}'s Worker bundle is ${problem}.`)
  return 1
}

/** Whether the module at `url` (an importer's import.meta.url) is the script Node was started with. */
export function isMain(url) {
  return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === url
}
