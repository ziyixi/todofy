#!/usr/bin/env node
// Mints recall's two machine tokens ON THE OWNER'S OWN MACHINE (../docs/design.md §2.2), and puts the SHA-256 digest of
// each into the Worker "recall" with `wrangler secret put` (the digest on stdin):
//
// - the ingest token (`recall_ingest_<43 base64url characters>`, write-only: POST /api/machine/v1/batches) goes to the
//   clipboard (pbcopy, through stdin) while the owner pastes it into the extension's options, and the clipboard is
//   cleared once they press Enter;
// - the export token (`recall_export_…`, read-only: the change feed and its blobs) goes into a new file for the NAS
//   container, mode 0600, `RECALL_EXPORT_TOKEN=…` (default ~/recall-sync.env: outside the repository, which may sit in
//   a synced folder), or with --keychain into the macOS Keychain (service recall-export-token) instead.
//
// No token passes through a command line, a log, a chat or the repository: the values travel from this process to
// pbcopy's stdin, the file or the Keychain (`security -i` reads its command on stdin) and nowhere else, and the Worker
// only ever holds their digests. A deploy keeps the digests (deploy-vars.mjs, test/secrets-kept.test.mjs).
//
// Rotation: the Worker accepts a route's current and previous digest. `--rotate ingest|export` moves the current digest
// to _PREVIOUS and puts a new token's (both tokens work until the extension or the container has the new one);
// `--retire ingest|export` deletes _PREVIOUS (wrangler asks to confirm). A token that leaked must stop at once, so
// `--revoke ingest|export` puts a new token's digest over the current one and deletes _PREVIOUS: only the new token
// works (the extension or the container stops until it has it). Worker secrets cannot be read back, so this script
// keeps the digests it put, and only them (a digest of a random 256-bit token opens nothing), in
// ~/.config/recall/token-digests.json (mode 0600). Deleting a route's digests stops that route at once (503):
// `wrangler secret delete INGEST_TOKEN_SHA256` is the emergency stop of uploads.
//
// Usage, after recall's first deploy (`wrangler secret put` needs the Worker), `npm ci` in recall/worker and
// `npx wrangler login` with the account that owns the Worker; from any directory:
//   node recall/deploy/mint-tokens.mjs [--keychain | --env-file <path>]     both tokens, the first time
//   node recall/deploy/mint-tokens.mjs --rotate ingest                       a new ingest token
//   node recall/deploy/mint-tokens.mjs --rotate export [--keychain | --env-file <path>]
//   node recall/deploy/mint-tokens.mjs --retire ingest|export                the previous token stops working
//   node recall/deploy/mint-tokens.mjs --revoke ingest|export [...]          a leaked token: only a new one works
//   … --dry-run                                                              what it would do; nothing is changed
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))
/** The pinned wrangler lives here (`npm ci` in recall/worker). */
export const WORKER = fileURLToPath(new URL('../worker/', import.meta.url))
export const ROUTES = ['ingest', 'export']
export const KEYCHAIN_SERVICE = 'recall-export-token'
export const KEYCHAIN_ACCOUNT = 'recall'
export const ENV_NAME = 'RECALL_EXPORT_TOKEN'
const DIGEST = /^[0-9a-f]{64}$/

/** The Worker secret that holds a route's current or previous digest. */
export function secretName(route, previous = false) {
  if (!ROUTES.includes(route)) throw new Error('not a recall token route')
  return `${route.toUpperCase()}_TOKEN_SHA256${previous ? '_PREVIOUS' : ''}`
}

/** A new token of a route: its prefix (which recall's scrubber and secret scanners know) and 32 random bytes. */
export function newToken(route, random = randomBytes) {
  if (!ROUTES.includes(route)) throw new Error('not a recall token route')
  return `recall_${route}_${Buffer.from(random(32)).toString('base64url')}`
}

/** The digest the Worker compares a bearer with: the SHA-256 of the token's UTF-8, in lower-case hex. */
export function digestOf(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The wrangler command that puts one secret (its value on stdin) or deletes one. */
export function wranglerArgs(action, name) {
  if (!['put', 'delete'].includes(action) || !/^(INGEST|EXPORT)_TOKEN_SHA256(_PREVIOUS)?$/.test(name)) throw new Error('not a recall token secret')
  return ['--no-install', 'wrangler', 'secret', action, name, '--config', CONFIG]
}

/** The `security -i` command (read on stdin, never on a command line) that stores the export token in the Keychain. */
export function keychainCommand(token) {
  if (!/^recall_export_[A-Za-z0-9_-]+$/.test(token)) throw new Error('not an export token')
  return `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w ${token}\n`
}

/** What the command line asks for, or a usage problem. */
export function parseArgs(argv) {
  const options = { action: 'mint', route: null, keychain: false, envFile: null, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--rotate' || arg === '--retire' || arg === '--revoke') {
      if (options.action !== 'mint' || !ROUTES.includes(argv[index + 1])) return { problem: `${arg} needs ingest or export` }
      options.action = arg.slice(2)
      options.route = argv[index + 1]
      index += 1
    } else if (arg === '--keychain') options.keychain = true
    else if (arg === '--env-file') {
      const path = argv[index + 1]
      if (path === undefined || path.startsWith('--')) return { problem: '--env-file needs a path' }
      options.envFile = path
      index += 1
    } else if (arg === '--dry-run') options.dryRun = true
    else return { problem: `unknown argument ${JSON.stringify(arg)}` }
  }
  const delivers = options.action === 'mint' || (['rotate', 'revoke'].includes(options.action) && options.route === 'export')
  if ((options.keychain || options.envFile !== null) && !delivers) return { problem: '--keychain and --env-file go with a first mint, --rotate export or --revoke export' }
  if (options.keychain && options.envFile !== null) return { problem: '--keychain or --env-file, not both' }
  return { options }
}

/** The digests this script put (none before the first mint); throws for a file it did not write. */
export function readState(path) {
  const stored = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1 }
  if (stored?.version !== 1) throw new Error('the digest file is not one this script wrote')
  const state = { version: 1 }
  for (const route of ROUTES) {
    state[route] = {}
    for (const slot of ['current', 'previous']) {
      const value = stored[route]?.[slot] ?? null
      if (value !== null && !DIGEST.test(value)) throw new Error('the digest file is not one this script wrote')
      state[route][slot] = value
    }
  }
  return state
}

/** Writes the digests owner-only and atomically (a temporary file renamed over the old one). */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

function ask(question) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.question(question, (answer) => {
      rl.close()
      done(answer)
    })
  })
}

/** What main() touches outside itself; a test replaces each of these with a fake (test/mint-tokens.test.mjs). */
export const realDeps = {
  home: homedir(),
  platform: process.platform,
  random: randomBytes,
  spawnSync,
  ask,
  wranglerInstalled: () => existsSync(join(WORKER, 'node_modules', '.bin', 'wrangler')),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}

/** The places this run writes: the digest file and the export token's env file. */
export function paths(options, deps) {
  return {
    state: join(deps.home, '.config', 'recall', 'token-digests.json'),
    envFile: options.envFile === null ? join(deps.home, 'recall-sync.env') : resolve(options.envFile),
  }
}

export async function main(argv, deps = realDeps) {
  const parsed = parseArgs(argv)
  if (parsed.problem !== undefined) {
    deps.error(`Usage: mint-tokens.mjs [--keychain | --env-file <path>] | --rotate ingest|export | --retire ingest|export | --revoke ingest|export [--dry-run] (${parsed.problem}).`)
    return 2
  }
  const { options } = parsed
  const where = paths(options, deps)
  if (!deps.wranglerInstalled()) {
    deps.error('The pinned wrangler is missing: run `npm ci` in recall/worker first (and `npx wrangler login`).')
    return 1
  }
  let state
  try {
    state = readState(where.state)
  } catch {
    deps.error(`${where.state} is not a digest file this script wrote; move it away and run again.`)
    return 1
  }
  const wrangler = (action, name, digest) => {
    if (options.dryRun) {
      deps.log(`Would ${action} the Worker secret ${name}${action === 'put' ? ' (value not printed)' : ''}.`)
      return true
    }
    const io = action === 'put' ? { input: digest, stdio: ['pipe', 'inherit', 'inherit'] } : { stdio: 'inherit' }
    const result = deps.spawnSync('npx', wranglerArgs(action, name), { cwd: WORKER, ...io })
    if (result.status === 0) return true
    deps.error(`wrangler secret ${action} ${name} failed.`)
    return false
  }

  if (options.action === 'retire') {
    const name = secretName(options.route, true)
    if (!wrangler('delete', name)) {
      deps.error('Nothing was changed.')
      return 1
    }
    if (!options.dryRun) writeState(where.state, { ...state, [options.route]: { ...state[options.route], previous: null } })
    deps.log(`Done: only the current ${options.route} token works now.`)
    return 0
  }

  const routes = options.action === 'mint' ? ROUTES : [options.route]
  if (options.action === 'mint' && ROUTES.some((route) => state[route].current !== null)) {
    deps.error(`Tokens were minted already (${where.state}); use --rotate ingest or --rotate export.`)
    return 1
  }
  if (options.action !== 'mint' && state[options.route].current === null) {
    deps.error(`No current ${options.route} token is recorded in ${where.state}: mint the tokens first.`)
    return 1
  }
  const exporting = routes.includes('export')
  if (exporting && !options.keychain && existsSync(where.envFile)) {
    deps.error(`${where.envFile} exists already; move it away (or pass --env-file) and run again. Nothing was changed.`)
    return 1
  }
  if (exporting && options.keychain && deps.platform !== 'darwin') {
    deps.error('--keychain needs macOS; use the env file instead.')
    return 2
  }
  if (routes.includes('ingest') && deps.platform !== 'darwin') {
    deps.error('The ingest token goes to the clipboard with pbcopy, which needs macOS.')
    return 2
  }
  if (options.dryRun) {
    if (exporting) deps.log(options.keychain ? `Would store the export token in the Keychain (service ${KEYCHAIN_SERVICE}).` : `Would write the export token to ${where.envFile} (mode 0600).`)
    if (routes.includes('ingest')) deps.log('Would copy the ingest token to the clipboard, and clear it after Enter.')
  }

  const tokens = Object.fromEntries(routes.map((route) => [route, newToken(route, deps.random)]))
  let wroteEnvFile = false
  let copied = false
  const undo = () => {
    if (wroteEnvFile) unlinkSync(where.envFile)
    if (copied) deps.spawnSync('pbcopy', [], { input: '' })
  }
  if (!options.dryRun && exporting) {
    if (options.keychain) {
      const stored = deps.spawnSync('security', ['-i'], { input: keychainCommand(tokens.export), stdio: ['pipe', 'ignore', 'inherit'] })
      if (stored.status !== 0) {
        deps.error('The Keychain refused the export token; nothing was changed.')
        return 1
      }
    } else {
      try {
        writeFileSync(where.envFile, `${ENV_NAME}=${tokens.export}\n`, { mode: 0o600, flag: 'wx' })
      } catch {
        deps.error(`Could not create ${where.envFile}; nothing was changed.`)
        return 1
      }
      wroteEnvFile = true
    }
  }
  if (!options.dryRun && routes.includes('ingest')) {
    copied = deps.spawnSync('pbcopy', [], { input: tokens.ingest }).status === 0
    if (!copied) {
      undo()
      deps.error('pbcopy failed; nothing was changed.')
      return 1
    }
  }

  const next = { ...state }
  /** A route whose _PREVIOUS a revocation could not delete (the new token works; `--retire` deletes it). */
  let previousLeft = null
  for (const route of routes) {
    const current = state[route].current
    if (options.action === 'rotate' && !wrangler('put', secretName(route, true), current)) {
      undo()
      deps.error('Nothing was changed.')
      return 1
    }
    const digest = digestOf(tokens[route])
    if (!wrangler('put', secretName(route), digest)) {
      undo()
      deps.error('Run the same command again: it starts over with new tokens.')
      return 1
    }
    let previous = options.action === 'rotate' ? current : null
    // The leaked token stopped working above; an older one kept in _PREVIOUS stops too.
    if (options.action === 'revoke' && state[route].previous !== null && !wrangler('delete', secretName(route, true))) {
      previous = state[route].previous
      previousLeft = route
    }
    next[route] = { current: digest, previous }
  }
  if (options.dryRun) return 0
  writeState(where.state, next)

  if (exporting) {
    deps.log(options.keychain
      ? `The export token is in the Keychain (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}); give it to the NAS container as ${ENV_NAME}.`
      : `The export token is in ${where.envFile} (mode 0600): the NAS container's env file. Move it there and delete the local copy.`)
  }
  if (copied) {
    await deps.ask('The ingest token is on the clipboard: paste it into the recall extension\'s options (令牌), then press Enter here. ')
    deps.spawnSync('pbcopy', [], { input: '' })
    deps.log('The clipboard is cleared.')
  }
  if (options.action === 'rotate') {
    deps.log(`Both ${options.route} tokens work until \`--retire ${options.route}\`: run it once the ${options.route === 'ingest' ? 'extension' : 'container'} uses the new one.`)
  }
  if (options.action === 'revoke') {
    deps.log(`The leaked ${options.route} token no longer works: the ${options.route === 'ingest' ? 'extension stops uploading' : 'container stops pulling'} until it has the new one.`)
  }
  if (previousLeft !== null) {
    deps.error(`${secretName(previousLeft, true)} is still set: run \`--retire ${previousLeft}\` to delete it.`)
    return 1
  }
  deps.log('Done: the Worker recall holds the new digests (values not printed).')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      console.error('The tokens were not minted (an unexpected error; no value was printed).')
      process.exitCode = 1
    },
  )
}
