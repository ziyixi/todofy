#!/usr/bin/env node
// The values of the Worker "mail-hero" that are never committed to ../wrangler.toml, added at deploy time:
//
// - with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry): the operational
//   state (GitHub environment variables; a release restates them and never overwrites them, AGENTS.md §8)
//   FORCE_SEND_PAUSED and MAINTENANCE_MODE, and BUILD_SHA (the commit);
// - with `--secrets-file` (Worker secrets: hidden in wrangler's output and in the Cloudflare dashboard/API,
//   unlike a plain_text var): the personal values RECEIVE_ADDRESS, ACCESS_OWNER, ACCESS_OWNER_ALIASES
//   (GitHub environment secrets, masked in the public Actions log).
//
// Wrangler silently DELETES a var that a deploy does not send (the config has no keep_vars), so this
// wrapper refuses to run unless every value is present and valid, and `exec` refuses a deploy without a
// --secrets-file holding the three personal bindings. Until 2026-10 the three personal values were plain_text vars:
// the first deploy through this version replaces each var by a secret of the same name in the same upload
// (one upload carries the whole binding list with keep_bindings secret_text/secret_key, so the previous
// plain_text bindings are dropped and there is no moment without the values). Never move them with
// `wrangler secret put` or `secret bulk`: those are separate deployments next to the var of the same name,
// not this atomic switch. Messages name the setting, never a value.
//
//   node deploy/deploy-vars.mjs check
//   node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/mail-hero-secrets.json"        (from cloudflare/)
//   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy [--dry-run] \
//     --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/mail-hero-secrets.json"   (from cloudflare/,
//     where the pinned wrangler lives)
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets`
// must set each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: MAIL_HERO_FORCE_SEND_PAUSED MAIL_HERO_MAINTENANCE_MODE MAIL_HERO_NATIVE_BACKUP_ENABLED GITHUB_SHA
// deploy-vars-inputs secrets: MAIL_HERO_RECEIVE_ADDRESS MAIL_HERO_ACCESS_OWNER MAIL_HERO_ACCESS_OWNER_ALIASES
import { mergeWorkerSecrets, validWorkerSecrets } from '../../tools/cloud-config/worker-secrets.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
const FLAG = /^(?:true|false)$/
const SHA = /^[0-9a-f]{40}$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048
// --secrets-file only adds or replaces secrets: an emptied alias list is uploaded as one space (packages/
// edge-auth trims it to no aliases) rather than left out, which would keep the previous aliases working.
const NO_ALIASES = ' '


export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing deploy setting: ${name}`)
    this.setting = name
  }
}

const matching = (pattern) => (value) => (pattern.test(value) ? value : null)

function aliasList(value) {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (items.length > MAX_ALIASES || items.join(',').length > MAX_LIST_CHARS || !items.every((item) => ACCESS_EMAIL.test(item))) return null
  return items.join(',')
}

/** Worker binding <- environment name, in deploy order. `validate` returns the value to send, or null.
 * `secret` entries go to the secrets file, the others are --var flags. */
export const INJECTED = [
  { name: 'FORCE_SEND_PAUSED', from: 'MAIL_HERO_FORCE_SEND_PAUSED', kind: 'toggle', validate: matching(FLAG) },
  { name: 'MAINTENANCE_MODE', from: 'MAIL_HERO_MAINTENANCE_MODE', kind: 'toggle', validate: matching(FLAG) },
  { name: 'NATIVE_BACKUP_ENABLED', from: 'MAIL_HERO_NATIVE_BACKUP_ENABLED', kind: 'toggle', validate: matching(FLAG) },
  { name: 'BUILD_SHA', from: 'GITHUB_SHA', kind: 'build', validate: matching(SHA) },
]
export const SECRETS = [
  { name: 'RECEIVE_ADDRESS', from: 'MAIL_HERO_RECEIVE_ADDRESS', kind: 'personal', validate: matching(EMAIL) },
  { name: 'ACCESS_OWNER', from: 'MAIL_HERO_ACCESS_OWNER', kind: 'personal', validate: matching(ACCESS_EMAIL) },
  // Up to 8 exact login emails that resolve to ACCESS_OWNER; empty is allowed (uploaded as one space).
  { name: 'ACCESS_OWNER_ALIASES', from: 'MAIL_HERO_ACCESS_OWNER_ALIASES', kind: 'personal', optional: true, validate: aliasList },

]

function values(entries, env) {
  const found = {}
  for (const { name, from, optional, validate } of entries) {
    const source = from === 'GITHUB_SHA' && env.BUILD_SOURCE_SHA ? 'BUILD_SOURCE_SHA' : from
    const value = env[source]
    // Absent means the CI step forgot the setting: always refused. Empty is refused unless optional.
    // Surrounding whitespace (a newline pasted into a secret) is refused; the alias list is normalized
    // item by item instead, as before.
    if (typeof value !== 'string' || (value === '' && !optional) || (!optional && value !== value.trim())) throw new SettingError(source)
    const checked = value.trim() === '' ? '' : validate(value)
    if (checked === null || (from === 'GITHUB_SHA' && value.length !== 40)) throw new SettingError(source)
    found[name] = checked
  }
  return found
}

/** {NAME: value} for every --var. Throws SettingError naming the first bad setting. */
export function injectedVars(env) {
  return values(INJECTED, env)
}

/** The flags appended to the wrangler command: --var NAME:value (wrangler splits at the first colon). */
export function wranglerArgs(env) {
  return Object.entries(injectedVars(env)).flatMap(([name, value]) => ['--var', `${name}:${value}`])
}

/** Worker secrets for `wrangler deploy --secrets-file`. Throws SettingError naming the first bad setting. */
export function generateSecrets(env) {
  const secrets = values(SECRETS, env)
  return mergeWorkerSecrets('mail-hero', env, { ...secrets, ACCESS_OWNER_ALIASES: secrets.ACCESS_OWNER_ALIASES || NO_ALIASES }, SettingError)
}

/** Writes the secrets file owner-only, never over an existing file. */
export function writeSecrets(path, env) {
  writeFileSync(path, JSON.stringify(generateSecrets(env), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

/** Refuse unknown or incomplete personal bindings; values are never printed. */
export function secretsFileProblem(path) {
  let content
  try { content = JSON.parse(readFileSync(path, 'utf8')) } catch { return 'the --secrets-file is missing or not JSON' }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return 'the --secrets-file is not a JSON object'
  const names = SECRETS.map(({ name }) => name)
  if (!names.every((name) => Object.hasOwn(content, name)) || !validWorkerSecrets('mail-hero', content, false)) return `the --secrets-file must hold ${names.join(', ')} and only declared bindings`
  for (const { name, validate } of SECRETS) {
    const value = content[name]
    const valid = typeof value === 'string' && value !== '' && (name === 'ACCESS_OWNER_ALIASES'
      ? value === NO_ALIASES || (value === value.trim() && validate(value) === value)
      : validate(value) === value)
    if (!valid) return `${name} in the --secrets-file is invalid`
  }
  return null
}

/** Why `argv` must not run through this wrapper, or null. `cwd` resolves a relative --config and --secrets-file. */
export function refusal(argv, cwd = process.cwd()) {
  if (argv.length === 0) return 'no command given'
  let config = null
  const secretsFiles = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--env' || arg === '-e' || arg.startsWith('--env=') || /^-e./.test(arg)) return '--env is not allowed: the top level is production'
    if (arg === '--keep-vars' || arg.startsWith('--keep-vars=')) return '--keep-vars is not allowed: the config is the source of truth'
    if (arg === '--var' || arg.startsWith('--var=')) return '--var is added by this wrapper only'
    if (arg === '--config' || arg === '-c') config = argv[index + 1] ?? ''
    else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
    else if (arg === '--secrets-file') secretsFiles.push(argv[index + 1] ?? '')
    else if (arg.startsWith('--secrets-file=')) secretsFiles.push(arg.slice('--secrets-file='.length))
  }
  if (!argv.includes('deploy')) return 'only a deploy (or a --dry-run deploy) runs through this wrapper'
  if (!config) return `--config must name ${CONFIG}`
  let target
  try { target = realpathSync(resolve(cwd, config)) } catch { return `--config must name ${CONFIG}` }
  if (target !== realpathSync(CONFIG)) return `--config must name ${CONFIG}`
  // Without the file the deploy would drop the personal values (the first time, the plain_text vars).
  if (secretsFiles.length !== 1 || !secretsFiles[0]) return 'exactly one --secrets-file (written by `secrets`) is required'
  return secretsFileProblem(resolve(cwd, secretsFiles[0]))
}

export function run(argv, env = process.env) {
  const [command, ...rest] = argv
  if (command === 'check' && rest.length === 0) {
    injectedVars(env)
    generateSecrets(env)
    console.log(`Deploy values are valid (not printed): ${[...INJECTED, ...SECRETS].map(({ name }) => name).join(', ')}.`)
    return 0
  }
  if (command === 'secrets' && rest.length === 1) {
    writeSecrets(rest[0], env)
    console.log(`Wrote the secrets file: ${SECRETS.map(({ name }) => name).join(', ')} (values not printed).`)
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
