// Finishes and checks the built launcher (dist/, the Worker's assets directory, ../wrangler.toml [assets]):
//
// - copies ../_headers to dist/_headers (the headers of /_/assets/*, which the asset layer serves without the Worker);
// - the layout the Worker and run_worker_first expect: the page at dist/_/index.html, its files under dist/_/assets/,
//   nothing else (a file anywhere else would only be reachable through the Worker, which serves no other file);
// - the same-origin page rules and the Worker's CSP (script-src 'self'): no absolute URL except inert identifiers, no
//   inline script, no data: module, every script and stylesheet under /_/assets/;
// - the JavaScript against its size budget (js-budget.mjs).
import { copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { jsBudgetProblem, jsSize } from './js-budget.mjs'

const web = new URL('../', import.meta.url).pathname
const dist = join(web, 'dist')
copyFileSync(join(web, '_headers'), join(dist, '_headers'))

// Strings that look like URLs but are never requested: the SVG namespace of the inline favicon.
const INERT = [/^http:\/\/www\.w3\.org\/2000\/svg$/]

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const problems = []
for (const path of files(dist)) {
  const name = relative(dist, path)
  if (name !== '_headers' && name !== '_/index.html' && !/^_\/assets\/[^/]+\.(?:js|css)$/.test(name)) problems.push(`${name}: not where the Worker serves the launcher from`)
  if (!/\.(?:html|js|css)$/.test(path)) continue
  const text = readFileSync(path, 'utf8').replaceAll('%2F', '/').replaceAll('%3A', ':')
  for (const match of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
    const url = match[0].replace(/['%].*$/, '')
    if (!INERT.some((pattern) => pattern.test(url))) problems.push(`${name}: ${match[0]}`)
  }
  if (path.endsWith('.html')) {
    for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
      if (!/\bsrc="\/_\/assets\//.test(tag[0])) problems.push(`${name}: inline or foreign script ${tag[0]}`)
    }
    for (const tag of text.matchAll(/<link\b[^>]*rel="(?:stylesheet|modulepreload)"[^>]*>/gi)) {
      if (!/\bhref="\/_\/assets\//.test(tag[0])) problems.push(`${name}: a file outside /_/assets/ ${tag[0]}`)
    }
  }
  if (/data:(?:text|application)\/javascript/i.test(text)) problems.push(`${name}: data: script`)
}

const js = jsSize(join(dist, '_', 'assets'))
const budget = jsBudgetProblem(js)
if (budget !== null) problems.push(budget)

if (problems.length > 0) {
  console.error(`dist/ breaks the launcher's rules:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`dist/ is the launcher's layout and makes no cross-origin references; its JavaScript is ${(js.gzip / 1024).toFixed(1)} KiB gzip (budget in js-budget.mjs).`)
