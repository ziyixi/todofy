#!/usr/bin/env node
// The values of the Worker "home" that are never committed to ../wrangler.toml, added at deploy time:
//
// - with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry): BUILD_SHA (the
//   commit) and CANARY_ENABLED (the GitHub environment variable DASHBOARD_CANARY_ENABLED; exactly "true" or
//   "false": unset or empty is refused like every other switch, so a deleted variable can never turn the
//   canaries back on, docs/setup.md §7);
// - with `--secrets-file` (Worker secrets, hidden in wrangler's output): the owner's addresses, the CSRF key
//   and the analytics token (GitHub environment secrets, masked in the public Actions log).
//
// Wrangler silently DELETES a var that a deploy does not send (the config has no keep_vars), so this
// wrapper refuses to run unless every value is present and valid. Messages name the setting, never a value.
//
//   node deploy/deploy-vars.mjs check
//   node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/home-secrets.json"            (from worker/)
//   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy [--dry-run] \
//     --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/home-secrets.json"        (from worker/)
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets`
// must set each input of that mode (Actions sets GITHUB_* itself). The secrets step also gets CF_API_TOKEN,
// optionally, only to warn when it is reused as the analytics token (it is never written).
// deploy-vars-inputs exec: DASHBOARD_CANARY_ENABLED GITHUB_SHA
// deploy-vars-inputs secrets: DASHBOARD_ACCESS_OWNER DASHBOARD_ACCESS_OWNER_ALIASES DASHBOARD_CSRF_SIGNING_KEY
// deploy-vars-inputs secrets: DASHBOARD_CF_ANALYTICS_TOKEN
import { spawnSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
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

/** Worker var <- environment name. An absent or empty value is refused (GitHub passes an unset variable as ""). */
export const INJECTED = [
  // In this order, the bindings keep the order the retired generator gave them (CANARY_ENABLED, BUILD_SHA last).
  { name: 'CANARY_ENABLED', from: 'DASHBOARD_CANARY_ENABLED', kind: 'toggle', pattern: /^(?:true|false)$/ },
  { name: 'BUILD_SHA', from: 'GITHUB_SHA', kind: 'build', pattern: /^[0-9a-f]{40}$/ },
]

function checked(env, name, pattern) {
  // Absent means the CI step forgot the setting; empty, that the GitHub variable or secret is unset.
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
  const name = 'DASHBOARD_ACCESS_OWNER_ALIASES'
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
    ACCESS_OWNER: checked(env, 'DASHBOARD_ACCESS_OWNER', ACCESS_EMAIL),
    // --secrets-file only adds or replaces secrets: an emptied list is uploaded as one space (read as
    // no aliases) rather than left out, which would keep the previous aliases working.
    ACCESS_OWNER_ALIASES: list.join(',') || ' ',
    CSRF_SIGNING_KEY: checked(env, 'DASHBOARD_CSRF_SIGNING_KEY', /^[0-9a-fA-F]{64}$/),
    // Used only for the GraphQL Analytics API; should be an "Account Analytics: Read" token (docs/setup.md §4).
    CF_ANALYTICS_TOKEN: checked(env, 'DASHBOARD_CF_ANALYTICS_TOKEN', /^[A-Za-z0-9_-]{20,200}$/),
  }
}

/** Whether the analytics token is the deploy token (CF_API_TOKEN, passed to the secrets step only for this
 * comparison): a broad token then sits in an internet-facing Worker. The owner allowed the reuse until a
 * read-only token is saved, so it is a warning, not a refusal. Values are never printed. */
export function deployTokenReused(env) {
  const deploy = typeof env.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN.trim() : ''
  const token = typeof env.DASHBOARD_CF_ANALYTICS_TOKEN === 'string' ? env.DASHBOARD_CF_ANALYTICS_TOKEN.trim() : ''
  return deploy !== '' && deploy === token
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
    console.log('Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES, CF_ANALYTICS_TOKEN, CSRF_SIGNING_KEY (values not printed).')
    if (deployTokenReused(env)) {
      console.log('::warning title=Broad analytics token::DASHBOARD_CF_ANALYTICS_TOKEN is the deploy token CF_API_TOKEN; replace it with an "Account Analytics: Read" token (dashboard/docs/setup.md §4).')
    }
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
