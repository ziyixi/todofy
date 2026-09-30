import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADMIN = fileURLToPath(new URL('../cloudflare-admin.py', import.meta.url))

// cloudflare-admin.py runs <its app root>/cloudflare/node_modules/.bin/wrangler with the Mail Hero token
// and CI=true. A copy of it in a temporary app root runs a stub instead, which records its arguments: no
// real wrangler, token or network is involved. The token is synthetic.
function run(args) {
  const root = mkdtempSync(join(tmpdir(), 'mail-hero-admin-'))
  try {
    mkdirSync(join(root, 'deploy'))
    mkdirSync(join(root, 'cloudflare/node_modules/.bin'), { recursive: true })
    copyFileSync(ADMIN, join(root, 'deploy/cloudflare-admin.py'))
    const marker = join(root, 'ran')
    const stub = join(root, 'cloudflare/node_modules/.bin/wrangler')
    writeFileSync(stub, `#!/bin/sh\nprintf '%s ' "$@" > '${marker}'\n`)
    chmodSync(stub, 0o755)
    const token = join(root, 'token')
    writeFileSync(token, 'synthetic_token_0000000000\n', { mode: 0o600 })
    chmodSync(token, 0o600)
    const result = spawnSync('python3', [join(root, 'deploy/cloudflare-admin.py'), '--token-file', token, 'wrangler', '--', ...args],
      { encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr, ran: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the admin helper refuses every spelling of a deploy of the production config', () => {
  for (const args of [
    ['deploy'],
    ['deploy', '--dry-run'],
    ['--config', '../wrangler.toml', 'deploy'],
    ['-c', '../wrangler.toml', 'deploy'],
    ['--config=../wrangler.toml', 'deploy'],
    ['-e', 'production', 'deploy'],
    ['--cwd', '.', '--config', '../wrangler.toml', 'deploy'],
    ['versions', 'upload'],
    ['--config', '../wrangler.toml', 'versions', 'upload'],
    ['--', 'deploy'],
  ]) {
    const result = run(args)
    assert.equal(result.ran, null, args.join(' '))
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /deploy only through CI or: node \.\.\/deploy\/deploy-vars\.mjs exec/)
  }
})

test('the admin helper still runs every other wrangler command', () => {
  for (const args of [
    ['whoami'],
    ['--config', '../wrangler.toml', 'd1', 'migrations', 'list', 'DB', '--remote'],
    ['-c', '../wrangler.toml', 'versions', 'list'],
    ['deployments', 'list', '--config', '../wrangler.toml'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.ran, args.join(' '))
  }
})
