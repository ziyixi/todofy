#!/usr/bin/env node
// Fleet production wrapper. Owner UI is read-only; its machine report identity is independent.
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: FLEET_ACCESS_OWNER FLEET_ACCESS_OWNER_ALIASES FLEET_REPORT_HMAC_KEY
import { mergeWorkerSecrets } from '../../tools/cloud-config/worker-secrets.mjs'
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
  if (typeof value !== 'string' || !pattern.test(value)
    || (['GITHUB_SHA', 'BUILD_SOURCE_SHA'].includes(name) && value.length !== 40)) throw new SettingError(name)
  return value
}

/** {NAME: value} for every injected var. */
export function injectedVars(env) {
  return Object.fromEntries(INJECTED.map(({ name, from, pattern }) => {
    const source = from === 'GITHUB_SHA' && env.BUILD_SOURCE_SHA ? 'BUILD_SOURCE_SHA' : from
    return [name, checked(env, source, pattern)]
  }))
}

/** The flags appended to the wrangler command: --var NAME:value (wrangler splits at the first colon). */
export function wranglerArgs(env) {
  return Object.entries(injectedVars(env)).flatMap(([name, value]) => ['--var', `${name}:${value}`])
}

function aliases(env) {
  const name = 'FLEET_ACCESS_OWNER_ALIASES'
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
  const personal = {
    ACCESS_OWNER: checked(env, 'FLEET_ACCESS_OWNER', ACCESS_EMAIL),
    // --secrets-file only adds or replaces secrets: an emptied list is uploaded as one space (read as no
    // aliases) rather than left out, which would keep the previous aliases working.
    ACCESS_OWNER_ALIASES: list.join(',') || ' ',
    REPORT_HMAC_KEY: checked(env, 'FLEET_REPORT_HMAC_KEY', /^[0-9a-fA-F]{64}$/),
  }
  return mergeWorkerSecrets('fleet', env, personal, SettingError)
}

/** Which committed identifier is still the all-zeros placeholder, or null (text scan of the TOML). */
export function placeholderIn(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  if (!/^\s*ACCESS_AUDIENCE\s*=\s*"[0-9a-f]{64}"/m.test(lines)) return 'ACCESS_AUDIENCE'
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
  const missingAudience = !/^\s*ACCESS_AUDIENCE\s*=/m.test(readFileSync(CONFIG, 'utf8'))
  if (placeholder && !(argv.includes('--dry-run') && missingAudience)) return `${placeholder} in the committed config is missing or an all-zeros placeholder`
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
    console.log('Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES, REPORT_HMAC_KEY (values not printed).')
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
