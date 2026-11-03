#!/usr/bin/env node
// The Home release's check of the optional PRIVATE_CATALOG secret, with Home's own parsePrivateCatalog: a value the
// Worker would refuse at runtime fails this step instead, before the deploy. A valid value is added to the Worker
// secrets file that deploy-vars.mjs wrote; an empty one adds nothing. Bazel bundles this file into Home's release
// archive (.compiled/tools/private-catalog.mjs), because the release job has no generated proto sources.
//
//   PRIVATE_CATALOG=... node ../.compiled/tools/private-catalog.mjs "$RUNNER_TEMP/home-secrets.json"   (from worker/)
//
// Diagnostics are the fixed PRIVATE_CATALOG_INVALID; no supplied value or secret is ever printed.
import { readFileSync, writeFileSync } from 'node:fs'
import specs from '../../tools/cloud-config/worker-secrets.json' with { type: 'json' }
import { parsePrivateCatalog, PRIVATE_CATALOG_ERROR } from '../worker/src/private-catalog.ts'

/** Home's materialized secrets with the registration added, or unchanged without one. */
function attach(secrets, raw) {
  if (raw === undefined || raw === '') return secrets
  parsePrivateCatalog(raw)
  // Only the file deploy-vars.mjs wrote for Home: its declared names, each a nonempty string.
  const { required, optional } = specs.home
  const valid = secrets !== null && typeof secrets === 'object' && !Array.isArray(secrets)
    && required.every((name) => Object.hasOwn(secrets, name))
    && Object.entries(secrets).every(([name, value]) => (required.includes(name) || optional.includes(name))
      && typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0'))
  if (!valid) throw new Error(PRIVATE_CATALOG_ERROR)
  return { ...secrets, PRIVATE_CATALOG: raw }
}

const [path, ...extra] = process.argv.slice(2)
const raw = process.env.PRIVATE_CATALOG
if (!path || extra.length) {
  console.error('Usage: private-catalog.mjs <secrets file>')
  process.exit(2)
}
try {
  if (raw !== undefined && raw !== '') {
    // Rewriting the owner-only file in place keeps its mode.
    writeFileSync(path, JSON.stringify(attach(JSON.parse(readFileSync(path, 'utf8')), raw), null, 2) + '\n')
    console.log('Private registration added to the Worker secrets file (values not printed).')
  }
} catch {
  console.error(PRIVATE_CATALOG_ERROR)
  process.exitCode = 1
}
