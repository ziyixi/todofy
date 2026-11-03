#!/usr/bin/env node
// Home validates the catalogue generated from its selected private source before deployment. The file replaces any
// older value in the secrets map. The optional environment input remains available to standalone callers.
// Bazel bundles this script with Home's parser into the checked release archive.
//
//   node ../.compiled/tools/private-catalog.mjs "$RUNNER_TEMP/home-secrets.json" "$RUNNER_TEMP/private-catalog.json"
//
// Diagnostics are the fixed PRIVATE_CATALOG_INVALID; no supplied value or secret is ever printed.
import { readFileSync, writeFileSync } from 'node:fs'
import specs from '../../tools/cloud-config/worker-secrets.json' with { type: 'json' }
import { parsePrivateCatalog, PRIVATE_CATALOG_ERROR } from '../worker/src/private-catalog.ts'

/** Home's materialized secrets with the registration added, or null when there is none to add. */
function attach(secrets, raw) {
  if (raw === undefined || raw === '') {
    if (secrets?.PRIVATE_CATALOG !== undefined) parsePrivateCatalog(secrets.PRIVATE_CATALOG)
    return null
  }
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

const [path, catalogPath, ...extra] = process.argv.slice(2)
if (!path || extra.length) {
  console.error('Usage: private-catalog.mjs <secrets file> [catalogue file]')
  process.exit(2)
}
try {
  const raw = catalogPath === undefined ? process.env.PRIVATE_CATALOG : readFileSync(catalogPath, 'utf8')
  if (catalogPath !== undefined && !raw) throw new Error(PRIVATE_CATALOG_ERROR)
  const secrets = attach(JSON.parse(readFileSync(path, 'utf8')), raw)
  if (secrets) {
    // Rewriting the owner-only file in place keeps its mode.
    writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n')
    console.log('Private registration added to the Worker secrets file (values not printed).')
  }
} catch {
  console.error(PRIVATE_CATALOG_ERROR)
  process.exitCode = 1
}
