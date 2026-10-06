// A deploy never removes the owner's Gmail grant (../../docs/design.md §10): `wrangler deploy --secrets-file` uploads the
// file's secrets and asks the API to keep every other secret binding (keep_bindings: secret_text, secret_key). This test
// pins that behaviour in the wrangler the deploy runs (worker/node_modules), so an upgrade that changes it fails here
// before it can reach production. (The config declares no [secrets] required list: wrangler-config.test.mjs; every
// mailsort deploy step passes --secrets-file: .github/scripts/test_wrangler_configs.py.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(new URL('../../worker/package.json', import.meta.url))
const cli = readFileSync(join(dirname(require.resolve('wrangler/package.json')), 'wrangler-dist', 'cli.js'), 'utf8')
const version = JSON.parse(readFileSync(require.resolve('wrangler/package.json'), 'utf8')).version

test(`wrangler ${version}: --secrets-file keeps the secrets the file does not name`, () => {
  // The deploy's worker metadata: a secrets file turns keepSecrets on ...
  assert.match(cli, /keepSecrets: keepVars \|\| !!props\.secretsFile/)
  // ... and keepSecrets sends keep_bindings for both secret kinds.
  assert.match(cli, /if \(keepSecrets\) \{\s*keep_bindings \?\?= \[\];\s*keep_bindings\.push\("secret_text", "secret_key"\);/)
  // The file's entries become secret_text bindings (replacing only those names).
  assert.match(cli, /for \(const \[secretName, secretValue\] of Object\.entries\(\s*secretsResult\.content\s*\)\) \{\s*bindings\[secretName\] = \{\s*type: "secret_text",/)
})

