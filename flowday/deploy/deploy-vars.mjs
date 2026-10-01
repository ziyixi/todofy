#!/usr/bin/env node
// The values of the Worker "flowday" that are never committed to ../wrangler.toml, added at deploy time (the same
// shape as Lab's wrapper, ../../lab/deploy/deploy-vars.mjs):
//
// - with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry): BUILD_SHA (the
//   commit). FlowDay has no GitHub-variable switches;
// - with `--secrets-file` (Worker secrets, hidden in wrangler's output): the owner's addresses and the CSRF key
//   (inputs FLOWDAY_ACCESS_OWNER, FLOWDAY_ACCESS_OWNER_ALIASES, FLOWDAY_CSRF_SIGNING_KEY, masked in the public
//   Actions log). The deploy job (from F2) fills the first two from the dashboard's environment secrets
//   DASHBOARD_ACCESS_OWNER and DASHBOARD_ACCESS_OWNER_ALIASES (the same owner, like Lab) and the key from FlowDay's
//   own FLOWDAY_CSRF_SIGNING_KEY (../README.md "Deploy").
//
// NOT DEPLOYED YET: ../wrangler.toml still has the all-zeros D1 id and Access AUD (F2 replaces them). A real
// deploy is refused while either placeholder is committed (now, and later as a guard against a revert); a
// `wrangler deploy --dry-run` (CI's bundle check) needs no real resource and is allowed.
//
// Wrangler silently DELETES a var that a deploy does not send (the config has no keep_vars), so this
// wrapper refuses to run unless every value is present and valid. Messages name the setting, never a value.
//
//   node deploy/deploy-vars.mjs check
//   node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/flowday-secrets.json"         (from worker/)
//   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy --dry-run \
//     --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/flowday-secrets.json"     (from worker/)
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets`
// must set each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: FLOWDAY_ACCESS_OWNER FLOWDAY_ACCESS_OWNER_ALIASES FLOWDAY_CSRF_SIGNING_KEY
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))

// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048

export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing deploy setting: ${name}`)
    this.setting = name
  }
}

/** Worker var <- environment name. An absent or empty value is refused. */
export const INJECTED = [{ name: 'BUILD_SHA', from: 'GITHUB_SHA', kind: 'build', pattern: /^[0-9a-f]{40}$/ }]

function checked(env, name, pattern) {
  const value = env[name]
  if (typeof value !== 'string' || !pattern.test(value)) throw new SettingError(name)
  return value
}

/** {NAME: value} for every injected var. */
export function injectedVars(env) {
  return Object.fromEntries(INJECTED.map(({ name, from, pattern }) => [name, checked(env, from, pattern)]))
}

/** The flags appended to the wrangler command: --var NAME:value (wrangler splits at the first colon). */
export function wranglerArgs(env) {
  return Object.entries(injectedVars(env)).flatMap(([name, value]) => ['--var', `${name}:${value}`])
}

function aliases(env) {
  const name = 'FLOWDAY_ACCESS_OWNER_ALIASES'
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

/** Worker secrets for `wrangler deploy --secrets-file`. */
export function generateSecrets(env) {
  const list = aliases(env)
  return {
    ACCESS_OWNER: checked(env, 'FLOWDAY_ACCESS_OWNER', ACCESS_EMAIL),
    // --secrets-file only adds or replaces secrets: an emptied list is uploaded as one space (read as no
    // aliases) rather than left out, which would keep the previous aliases working.
    ACCESS_OWNER_ALIASES: list.join(',') || ' ',
    CSRF_SIGNING_KEY: checked(env, 'FLOWDAY_CSRF_SIGNING_KEY', /^[0-9a-fA-F]{64}$/),
  }
}

/** Which committed identifier is still the all-zeros placeholder, or null (text scan of the TOML). */
export function placeholderIn(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  if (/^\s*database_id\s*=\s*"0{8}-0{4}-0{4}-0{4}-0{12}"/m.test(lines)) return 'database_id'
  if (/^\s*ACCESS_AUDIENCE\s*=\s*"0{64}"/m.test(lines)) return 'ACCESS_AUDIENCE'
  return null
}

/** Writes the secrets file owner-only, never over an existing file. */
export function writeSecrets(path, env) {
  writeFileSync(path, JSON.stringify(generateSecrets(env), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

/** Why `argv` must not run through this wrapper, or null. `cwd` resolves a relative --config. */
export function refusal(argv, cwd = process.cwd()) {
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
  const placeholder = placeholderIn(readFileSync(CONFIG, 'utf8'))
  if (placeholder && !argv.includes('--dry-run')) return `${placeholder} in the committed config is the all-zeros placeholder (FlowDay is not deployed before F2)`
  return null
}

export function run(argv, env = process.env) {
  const [command, ...rest] = argv
  if (command === 'check' && rest.length === 0) {
    injectedVars(env)
    generateSecrets(env)
    console.log('Deploy values are valid (not printed).')
    return 0
  }
  if (command === 'secrets' && rest.length === 1) {
    writeSecrets(rest[0], env)
    console.log('Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES, CSRF_SIGNING_KEY (values not printed).')
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
    console.log(`Adding --var for ${INJECTED.map(({ name }) => name).join(', ')} (values not printed).`)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof SettingError ? error.message
      : error?.code === 'EEXIST' ? 'The secrets file already exists; nothing was overwritten.'
        : 'Unable to prepare the deploy values.')
    process.exitCode = 1
  }
}
