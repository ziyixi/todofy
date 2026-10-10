// The owner's token script (../mint-tokens.mjs) with a fake wrangler, pbcopy and Keychain in a temporary home: the
// tokens' shape and digests (as the Worker compares them), the exact wrangler commands with each digest on stdin, the
// export token in a 0600 env file or the Keychain, the ingest token on the clipboard and the clipboard cleared, the
// rotation into _PREVIOUS and the retirement, the revocation of a leaked token, the refusals that change nothing, and
// no token value in any output.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG, digestOf, keychainCommand, KEYCHAIN_SERVICE, main, newToken, parseArgs, readState, secretName, WORKER, wranglerArgs } from '../mint-tokens.mjs'

/** A deterministic source of "random" bytes: each call fills 32 bytes with the next counter value. */
function counter() {
  let n = 0
  return (size) => {
    n += 1
    return Buffer.alloc(size, n)
  }
}

/** main() in a temporary home with fakes for every process it starts. */
async function runMain(argv, { home, platform = 'darwin', fail = {}, wranglerInstalled = true, random = counter() } = {}) {
  const calls = { wrangler: [], pbcopy: [], security: [], asked: 0, logs: [], errors: [] }
  const deps = {
    home,
    platform,
    random,
    wranglerInstalled: () => wranglerInstalled,
    spawnSync: (command, args, options) => {
      if (command === 'npx') {
        calls.wrangler.push({ args, input: options.input, cwd: options.cwd })
        return { status: fail.wrangler === args[4] ? 1 : 0 }
      }
      if (command === 'pbcopy') {
        calls.pbcopy.push(options.input)
        return { status: fail.pbcopy === true ? 1 : 0 }
      }
      if (command === 'security') {
        calls.security.push({ args, input: options.input })
        return { status: fail.security === true ? 1 : 0 }
      }
      throw new Error(`unexpected command ${command}`)
    },
    ask: async () => {
      calls.asked += 1
      return ''
    },
    log: (line) => calls.logs.push(line),
    error: (line) => calls.errors.push(line),
  }
  const code = await main(argv, deps)
  return { code, calls }
}

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-mint-'))
    try {
      await fn(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const statePath = (home) => join(home, '.config', 'recall', 'token-digests.json')
const envPath = (home) => join(home, 'recall-sync.env')

/** No token value (its random part) appears in anything the script printed. */
function assertNothingPrinted(calls, tokens) {
  const printed = [...calls.logs, ...calls.errors].join('\n')
  for (const token of tokens) assert.ok(!printed.includes(token.slice(-20)), 'printed a token')
}

test('a token is its prefix and 32 random bytes in base64url; the Worker compares the SHA-256 hex of its UTF-8', () => {
  const token = newToken('ingest', () => Buffer.alloc(32, 255))
  assert.equal(token, `recall_ingest_${'_'.repeat(42)}8`)
  assert.match(newToken('export'), /^recall_export_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(newToken('export'), newToken('export'))
  assert.equal(digestOf(token), createHash('sha256').update(new TextEncoder().encode(token)).digest('hex'))
  assert.throws(() => newToken('owner'))
})

test('the secrets and the commands: exactly the four digest names, through the pinned wrangler with the committed config', () => {
  assert.deepEqual(['ingest', 'export'].flatMap((route) => [secretName(route), secretName(route, true)]), [
    'INGEST_TOKEN_SHA256', 'INGEST_TOKEN_SHA256_PREVIOUS', 'EXPORT_TOKEN_SHA256', 'EXPORT_TOKEN_SHA256_PREVIOUS',
  ])
  assert.deepEqual(wranglerArgs('put', 'INGEST_TOKEN_SHA256'), ['--no-install', 'wrangler', 'secret', 'put', 'INGEST_TOKEN_SHA256', '--config', CONFIG])
  assert.throws(() => wranglerArgs('put', 'CSRF_SIGNING_KEY'))
  assert.throws(() => wranglerArgs('list', 'INGEST_TOKEN_SHA256'))
  assert.ok(CONFIG.endsWith('recall/wrangler.toml'))
  assert.ok(WORKER.endsWith('recall/worker/'))
  assert.equal(keychainCommand('recall_export_abc-_9'), `add-generic-password -U -a recall -s ${KEYCHAIN_SERVICE} -w recall_export_abc-_9\n`)
  assert.throws(() => keychainCommand('recall_export_a b'))
  assert.throws(() => keychainCommand('recall_ingest_abc'))
})

test('the command line', () => {
  assert.deepEqual(parseArgs([]).options, { action: 'mint', route: null, keychain: false, envFile: null, dryRun: false })
  assert.deepEqual(parseArgs(['--rotate', 'export', '--keychain']).options, { action: 'rotate', route: 'export', keychain: true, envFile: null, dryRun: false })
  assert.equal(parseArgs(['--retire', 'ingest', '--dry-run']).options.dryRun, true)
  assert.deepEqual(parseArgs(['--revoke', 'export', '--env-file', 'x']).options, { action: 'revoke', route: 'export', keychain: false, envFile: 'x', dryRun: false })
  for (const argv of [['--rotate'], ['--rotate', 'owner'], ['--rotate', 'ingest', '--retire', 'export'], ['--rotate', 'ingest', '--keychain'], ['--retire', 'export', '--env-file', 'x'], ['--revoke', 'ingest', '--keychain'], ['--revoke', 'ingest', '--rotate', 'export'], ['--keychain', '--env-file', 'x'], ['--env-file'], ['--token', 'x']]) {
    assert.ok(parseArgs(argv).problem !== undefined, argv.join(' '))
  }
})

test('the first mint: both digests put on stdin, the export token in a 0600 env file, the ingest token on the clipboard then cleared', withHome(async (home) => {
  const { code, calls } = await runMain([], { home })
  assert.equal(code, 0, calls.errors.join('\n'))
  const env = readFileSync(envPath(home), 'utf8')
  assert.match(env, /^RECALL_EXPORT_TOKEN=recall_export_[A-Za-z0-9_-]{43}\n$/)
  assert.equal(statSync(envPath(home)).mode & 0o777, 0o600)
  const exportToken = env.trim().split('=')[1]
  const ingestToken = calls.pbcopy[0]
  assert.match(ingestToken, /^recall_ingest_[A-Za-z0-9_-]{43}$/)
  // The clipboard is cleared once the owner pressed Enter.
  assert.deepEqual(calls.pbcopy, [ingestToken, ''])
  assert.equal(calls.asked, 1)
  assert.deepEqual(calls.wrangler, [
    { args: wranglerArgs('put', 'INGEST_TOKEN_SHA256'), input: digestOf(ingestToken), cwd: WORKER },
    { args: wranglerArgs('put', 'EXPORT_TOKEN_SHA256'), input: digestOf(exportToken), cwd: WORKER },
  ])
  assert.deepEqual(readState(statePath(home)), { version: 1, ingest: { current: digestOf(ingestToken), previous: null }, export: { current: digestOf(exportToken), previous: null } })
  assert.equal(statSync(statePath(home)).mode & 0o777, 0o600)
  assert.ok(!readFileSync(statePath(home), 'utf8').includes('recall_'), 'the digest file holds digests only')
  assert.ok(calls.logs.some((line) => line.includes(envPath(home))))
  assertNothingPrinted(calls, [ingestToken, exportToken])

  // A second plain mint would stop both tokens: refused, nothing changed.
  const again = await runMain([], { home })
  assert.equal(again.code, 1)
  assert.match(again.calls.errors[0], /--rotate/)
  assert.deepEqual(again.calls.wrangler, [])
}))

test('--keychain: the export token goes to `security -i` on stdin, never a command line or a file', withHome(async (home) => {
  const { code, calls } = await runMain(['--keychain'], { home })
  assert.equal(code, 0, calls.errors.join('\n'))
  assert.equal(calls.security.length, 1)
  assert.deepEqual(calls.security[0].args, ['-i'])
  const exportToken = /-w (recall_export_\S+)\n$/.exec(calls.security[0].input)?.[1]
  assert.ok(exportToken)
  assert.equal(calls.wrangler[1].input, digestOf(exportToken))
  assert.ok(!existsSync(envPath(home)))
  assert.ok(calls.logs.some((line) => line.includes(KEYCHAIN_SERVICE)))
  assertNothingPrinted(calls, [exportToken, calls.pbcopy[0]])
}))

test('--rotate moves the current digest to _PREVIOUS before it puts the new one; --retire deletes _PREVIOUS', withHome(async (home) => {
  await runMain([], { home })
  const first = readState(statePath(home))
  rmSync(envPath(home))

  const ingest = await runMain(['--rotate', 'ingest'], { home })
  assert.equal(ingest.code, 0, ingest.calls.errors.join('\n'))
  const newIngest = ingest.calls.pbcopy[0]
  assert.deepEqual(ingest.calls.wrangler.map(({ args, input }) => [args[4], input]), [
    ['INGEST_TOKEN_SHA256_PREVIOUS', first.ingest.current],
    ['INGEST_TOKEN_SHA256', digestOf(newIngest)],
  ])
  assert.deepEqual(ingest.calls.pbcopy, [newIngest, ''])
  assert.deepEqual(readState(statePath(home)).ingest, { current: digestOf(newIngest), previous: first.ingest.current })
  assert.deepEqual(readState(statePath(home)).export, first.export)
  assert.ok(!existsSync(envPath(home)), 'an ingest rotation writes no env file')

  const exported = await runMain(['--rotate', 'export', '--env-file', join(home, 'nas.env')], { home })
  assert.equal(exported.code, 0, exported.calls.errors.join('\n'))
  const newExport = readFileSync(join(home, 'nas.env'), 'utf8').trim().split('=')[1]
  assert.deepEqual(exported.calls.wrangler.map(({ args, input }) => [args[4], input]), [
    ['EXPORT_TOKEN_SHA256_PREVIOUS', first.export.current],
    ['EXPORT_TOKEN_SHA256', digestOf(newExport)],
  ])
  assert.deepEqual(exported.calls.pbcopy, [])

  const retired = await runMain(['--retire', 'ingest'], { home })
  assert.equal(retired.code, 0)
  assert.deepEqual(retired.calls.wrangler.map(({ args, input }) => [args[3], args[4], input]), [['delete', 'INGEST_TOKEN_SHA256_PREVIOUS', undefined]])
  assert.deepEqual(readState(statePath(home)).ingest, { current: digestOf(newIngest), previous: null })
  assertNothingPrinted(ingest.calls, [newIngest])
  assertNothingPrinted(exported.calls, [newExport])
}))

test('--revoke puts a new digest over the leaked one and deletes _PREVIOUS: only the new token works', withHome(async (home) => {
  await runMain([], { home })
  rmSync(envPath(home))
  // An earlier rotation left a previous export token.
  await runMain(['--rotate', 'export'], { home })
  rmSync(envPath(home))
  const before = readState(statePath(home))
  assert.notEqual(before.export.previous, null)

  const revoked = await runMain(['--revoke', 'export'], { home })
  assert.equal(revoked.code, 0, revoked.calls.errors.join('\n'))
  const newExport = readFileSync(envPath(home), 'utf8').trim().split('=')[1]
  assert.deepEqual(revoked.calls.wrangler.map(({ args, input }) => [args[3], args[4], input]), [
    ['put', 'EXPORT_TOKEN_SHA256', digestOf(newExport)],
    ['delete', 'EXPORT_TOKEN_SHA256_PREVIOUS', undefined],
  ])
  assert.deepEqual(readState(statePath(home)).export, { current: digestOf(newExport), previous: null })
  assert.deepEqual(readState(statePath(home)).ingest, before.ingest)
  assertNothingPrinted(revoked.calls, [newExport])

  // Without a previous token there is nothing to delete; the ingest token goes to the clipboard as usual.
  const ingest = await runMain(['--revoke', 'ingest'], { home })
  assert.equal(ingest.code, 0, ingest.calls.errors.join('\n'))
  assert.deepEqual(ingest.calls.wrangler.map(({ args }) => [args[3], args[4]]), [['put', 'INGEST_TOKEN_SHA256']])
  assert.deepEqual(ingest.calls.pbcopy, [ingest.calls.pbcopy[0], ''])

  // A delete that fails leaves the new token working and says how to finish.
  rmSync(envPath(home))
  await runMain(['--rotate', 'export'], { home })
  rmSync(envPath(home))
  const failed = await runMain(['--revoke', 'export'], { home, fail: { wrangler: 'EXPORT_TOKEN_SHA256_PREVIOUS' } })
  assert.equal(failed.code, 1)
  assert.ok(existsSync(envPath(home)), 'the new token is delivered')
  assert.match(failed.calls.errors.at(-1), /--retire export/)
  assert.notEqual(readState(statePath(home)).export.previous, null)
}))

test('refusals change nothing: no wrangler, a rotation before the first mint, an existing env file, no macOS, a foreign digest file', withHome(async (home) => {
  const missing = await runMain([], { home, wranglerInstalled: false })
  assert.equal(missing.code, 1)
  assert.match(missing.calls.errors[0], /npm ci/)
  const early = await runMain(['--rotate', 'ingest'], { home })
  assert.equal(early.code, 1)
  writeFileSync(envPath(home), 'kept\n')
  const exists = await runMain([], { home })
  assert.equal(exists.code, 1)
  assert.equal(readFileSync(envPath(home), 'utf8'), 'kept\n')
  rmSync(envPath(home))
  const linux = await runMain([], { home, platform: 'linux' })
  assert.equal(linux.code, 2)
  for (const run of [missing, early, exists, linux]) {
    assert.deepEqual(run.calls.wrangler, [])
    assert.deepEqual(run.calls.pbcopy, [])
  }
  assert.ok(!existsSync(statePath(home)))
  assert.ok(!existsSync(envPath(home)))

  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, '.config', 'recall'), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify({ version: 1, ingest: { current: 'recall_ingest_not-a-digest' } }))
  const foreign = await runMain(['--rotate', 'ingest'], { home })
  assert.equal(foreign.code, 1)
  assert.deepEqual(foreign.calls.wrangler, [])
}))

test('a failure part way leaves no usable stray token: the env file is removed and the clipboard cleared', withHome(async (home) => {
  const clipboard = await runMain([], { home, fail: { pbcopy: true } })
  assert.equal(clipboard.code, 1)
  assert.deepEqual(clipboard.calls.wrangler, [])
  assert.ok(!existsSync(envPath(home)))

  const put = await runMain([], { home, fail: { wrangler: 'EXPORT_TOKEN_SHA256' } })
  assert.equal(put.code, 1)
  assert.equal(put.calls.wrangler.length, 2)
  assert.ok(!existsSync(envPath(home)))
  assert.ok(!existsSync(statePath(home)), 'nothing recorded: the same command starts over')
  assert.equal(put.calls.pbcopy.at(-1), '')

  const keychain = await runMain(['--keychain'], { home, fail: { security: true } })
  assert.equal(keychain.code, 1)
  assert.deepEqual(keychain.calls.wrangler, [])
  assert.deepEqual(keychain.calls.pbcopy, [])

  // The same command, once nothing fails, mints both.
  assert.equal((await runMain([], { home })).code, 0)
}))

test('--dry-run says what it would do and changes nothing', withHome(async (home) => {
  const { code, calls } = await runMain(['--dry-run'], { home })
  assert.equal(code, 0)
  assert.deepEqual(calls.wrangler, [])
  assert.deepEqual(calls.pbcopy, [])
  assert.ok(!existsSync(envPath(home)))
  assert.ok(!existsSync(statePath(home)))
  assert.ok(calls.logs.some((line) => line.includes('INGEST_TOKEN_SHA256')))
  assert.ok(calls.logs.some((line) => line.includes('EXPORT_TOKEN_SHA256')))
}))
