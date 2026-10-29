/**
 * The deploy-vars core of the standard Workers. An app's deploy/deploy-vars.mjs built on it declares only what differs
 * (its inputs, switches and committed-resource guard) and re-exports what workerDeploy returns, so ci.yml, the app's
 * tests and .github/scripts/drift_desired.py keep importing and running the app's own wrapper. Deploy tooling only: no
 * Worker imports it. A wrapper that needs more than these declarations stays the app's own (Mail Hero's, Home's).
 *
 * A wrapper adds at deploy time the values never committed to the app's wrangler.toml:
 * - with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry): the commit (BUILD_SHA) and
 *   any GitHub-variable switch;
 * - with `--secrets-file` (Worker secrets, hidden in wrangler's output): the owner's addresses, over the app's optional
 *   <APP>_WORKER_SECRETS map (worker-secrets.mjs).
 *
 * Wrangler silently DELETES a var that a deploy does not send (no config has keep_vars), so a wrapper refuses to run
 * unless every value is present and valid. Messages name the setting, never a value.
 *
 *   node deploy/deploy-vars.mjs check
 *   node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/<app>-secrets.json"         (from worker/)
 *   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy [--dry-run] \
 *     --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/<app>-secrets.json"     (from worker/)
 */
import { mergeWorkerSecrets } from './worker-secrets.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048

// The committed identifiers a deploy can be gated on: the shape of a real value, and the all-zeros placeholder.
const IDENTIFIERS = {
  database_id: { real: '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', zeros: '0{8}-0{4}-0{4}-0{4}-0{12}' },
  ACCESS_AUDIENCE: { real: '[0-9a-f]{64}', zeros: '0{64}' },
}
// How an identifier gates a deploy (comment lines never count):
// - 'zeros': its all-zeros placeholder refuses a real deploy (a guard against a revert to the pre-resource config);
// - 'required': a real deploy also needs it committed and well formed (absent until "Infra apply" creates the resource);
// - 'strict': as 'required', and a committed value that is malformed or all zeros refuses the dry run too, which runs
//   only while the identifier is absent.
// A dry run (CI's bundle check) otherwise needs no real resource and is allowed.
const RULES = ['zeros', 'required', 'strict']

export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing deploy setting: ${name}`)
    this.setting = name
  }
}

/** The commit, injected by every wrapper; a repair's BUILD_SOURCE_SHA, when set, is used in place of GITHUB_SHA. */
export const BUILD_SHA = { name: 'BUILD_SHA', from: 'GITHUB_SHA', kind: 'build', pattern: /^[0-9a-f]{40}$/ }

function checked(env, name, pattern) {
  const value = env[name]
  if (typeof value !== 'string' || !pattern.test(value)
    || (['GITHUB_SHA', 'BUILD_SOURCE_SHA'].includes(name) && value.length !== 40)) throw new SettingError(name)
  return value
}

function aliases(env, name) {
  if (typeof env[name] !== 'string') throw new SettingError(name)
  const items = env[name].split(',').map((item) => item.trim()).filter(Boolean)
  if (
    items.length > MAX_ALIASES ||
    new Set(items).size !== items.length ||
    items.join(',').length > MAX_LIST_CHARS ||
    !items.every((item) => ACCESS_EMAIL.test(item))
  ) throw new SettingError(name)
  return items
}

const uncommented = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
const assignment = (key, value) => new RegExp(`^\\s*${key}\\s*=${value === undefined ? '' : `\\s*"${value}"`}`, 'm')

/**
 * The wrapper of the app whose deploy/deploy-vars.mjs is `url` (its import.meta.url; the committed config is the
 * wrangler.toml beside deploy/):
 * - worker: its entry in worker-secrets.json (the <APP>_WORKER_SECRETS map and the bindings it may hold);
 * - injected: the --var rows {name, from, kind, pattern} in flag order, BUILD_SHA among them;
 * - owner: the input holding the owner's address, whose aliases are `<owner>_ALIASES`;
 * - guard: {identifier: rule} (IDENTIFIERS, RULES), checked in this order.
 */
export function workerDeploy(url, { worker, injected, owner, guard }) {
  const CONFIG = fileURLToPath(new URL('../wrangler.toml', url))
  for (const [key, rule] of Object.entries(guard)) {
    if (!Object.hasOwn(IDENTIFIERS, key) || !RULES.includes(rule)) throw new Error(`Unknown deploy guard: ${key} ${rule}`)
  }

  /** {NAME: value} for every injected var. */
  function injectedVars(env) {
    return Object.fromEntries(injected.map(({ name, from, pattern }) => {
      const source = from === 'GITHUB_SHA' && env.BUILD_SOURCE_SHA ? 'BUILD_SOURCE_SHA' : from
      return [name, checked(env, source, pattern)]
    }))
  }

  /** The flags appended to the wrangler command: --var NAME:value (wrangler splits at the first colon). */
  function wranglerArgs(env) {
    return Object.entries(injectedVars(env)).flatMap(([name, value]) => ['--var', `${name}:${value}`])
  }

  /** Worker secrets for `wrangler deploy --secrets-file`. */
  function generateSecrets(env) {
    const list = aliases(env, `${owner}_ALIASES`)
    return mergeWorkerSecrets(worker, env, {
      ACCESS_OWNER: checked(env, owner, ACCESS_EMAIL),
      // --secrets-file only adds or replaces secrets: an emptied list is uploaded as one space (read as no
      // aliases) rather than left out, which would keep the previous aliases working.
      ACCESS_OWNER_ALIASES: list.join(',') || ' ',
    }, SettingError)
  }

  /** Which guarded identifier the committed config does not hold for real yet, or null (a text scan of the TOML). */
  function placeholderIn(text) {
    const lines = uncommented(text)
    return Object.keys(guard).find((key) => unready(key, lines)) ?? null
  }

  function unready(key, lines) {
    const { real, zeros } = IDENTIFIERS[key]
    return assignment(key, zeros).test(lines) || (guard[key] !== 'zeros' && !assignment(key, real).test(lines))
  }

  /** Writes the secrets file owner-only, never over an existing file. */
  function writeSecrets(path, env) {
    writeFileSync(path, JSON.stringify(generateSecrets(env), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  }

  /**
   * Why `argv` must not run through this wrapper, or null. `cwd` resolves a relative --config; `readConfig` returns the
   * committed config's text (the tests pass other texts to prove the guard).
   */
  function refusal(argv, cwd = process.cwd(), readConfig = () => readFileSync(CONFIG, 'utf8')) {
    if (argv.length === 0) return 'no command given'
    let config = null
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]
      if (arg === '--env' || arg === '-e' || arg.startsWith('--env=') || /^-e./.test(arg)) return '--env is not allowed: the top level is production'
      if (arg === '--keep-vars' || arg.startsWith('--keep-vars=')) return '--keep-vars is not allowed: the config is the source of truth'
      if (arg === '--var' || arg.startsWith('--var=')) return '--var is added by this wrapper only'
      if (arg === '--config' || arg === '-c') config = argv[index + 1] ?? ''
      else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
    }
    if (!argv.includes('deploy')) return 'only a deploy (or a --dry-run deploy) runs through this wrapper'
    if (!config) return `--config must name ${CONFIG}`
    let target
    try { target = realpathSync(resolve(cwd, config)) } catch { return `--config must name ${CONFIG}` }
    if (target !== realpathSync(CONFIG)) return `--config must name ${CONFIG}`
    const lines = uncommented(readConfig())
    const dryRun = argv.includes('--dry-run')
    const blocked = Object.keys(guard).find((key) => unready(key, lines)
      && (!dryRun || (guard[key] === 'strict' && assignment(key).test(lines))))
    if (!blocked) return null
    return guard[blocked] === 'zeros'
      ? `${blocked} in the committed config is the all-zeros placeholder (a real deploy needs the real resource)`
      : `${blocked} is missing from the committed config, malformed or all zeros (a deploy needs the real resource)`
  }

  function run(argv, env = process.env) {
    const [command, ...rest] = argv
    if (command === 'check' && rest.length === 0) {
      injectedVars(env)
      generateSecrets(env)
      console.log('Deploy values are valid (not printed).')
      return 0
    }
    if (command === 'secrets' && rest.length === 1) {
      writeSecrets(rest[0], env)
      console.log('Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES (values not printed).')
      return 0
    }
    if (command === 'exec' && rest[0] === '--') {
      const child = rest.slice(1)
      const reason = refusal(child)
      if (reason) {
        console.error(`Refused: ${reason}.`)
        return 2
      }
      const extra = wranglerArgs(env)
      console.log(`Adding --var for ${injected.map(({ name }) => name).join(', ')} (values not printed).`)
      const result = spawnSync(child[0], [...child.slice(1), ...extra], { stdio: 'inherit', env })
      if (result.error) {
        console.error(`Could not start ${child[0]}.`)
        return 1
      }
      return result.status ?? 1
    }
    console.error('Usage: deploy-vars.mjs check | secrets <path> | exec -- <wrangler deploy command…>')
    return 2
  }

  /** Runs the command line when the wrapper is the script node started, not when a test or drift_desired.py imports it. */
  function main() {
    if (!process.argv[1] || url !== pathToFileURL(process.argv[1]).href) return
    try {
      process.exitCode = run(process.argv.slice(2))
    } catch (error) {
      console.error(error instanceof SettingError ? error.message
        : error?.code === 'EEXIST' ? 'The secrets file already exists; nothing was overwritten.'
          : 'Unable to prepare the deploy values.')
      process.exitCode = 1
    }
  }

  return {
    CONFIG, INJECTED: injected, SettingError,
    injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run, main,
  }
}
