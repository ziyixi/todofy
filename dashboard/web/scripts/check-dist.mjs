// Checks the built UI (dist/) against the page rules of docs/design.md §8 and the Worker's CSP
// (script-src 'self'): no absolute URL except inert identifiers, no inline script, no data: modules; and the
// JavaScript against its size budget (js-budget.mjs).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsBudgetProblem, jsSize } from './js-budget.mjs'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

// Strings that look like URLs but are never requested: XML namespace identifiers (React DOM, SVG)
// and React's production error-decoder link, which only appears inside thrown error messages.
const INERT = [/^http:\/\/www\.w3\.org\/(?:1998\/Math\/MathML|1999\/xlink|2000\/svg|XML\/1998\/namespace)$/, /^https:\/\/react\.dev\/errors\/$/]

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const problems = []
for (const path of files(dist)) {
  if (!/\.(?:html|js|css|svg|json|txt)$/.test(path)) continue
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
    if (!INERT.some((pattern) => pattern.test(match[0]))) problems.push(`${relative(dist, path)}: ${match[0]}`)
  }
  if (path.endsWith('.html')) {
    for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
      if (!/\bsrc="\/assets\//.test(tag[0])) problems.push(`${relative(dist, path)}: inline or foreign script ${tag[0]}`)
    }
    if (/<link\b[^>]*href="(?!\/)/i.test(text)) problems.push(`${relative(dist, path)}: link to a non-root path`)
  }
  if (/data:(?:text|application)\/javascript/i.test(text)) problems.push(`${relative(dist, path)}: data: script`)
}

const js = jsSize(join(dist, 'assets'))
const budget = jsBudgetProblem(js)
if (budget !== null) problems.push(budget)

if (problems.length) {
  console.error(`dist/ breaks the same-origin page rules:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`dist/ makes no cross-origin references; its JavaScript is ${(js.gzip / 1024).toFixed(1)} KiB gzip (budget in js-budget.mjs).`)
