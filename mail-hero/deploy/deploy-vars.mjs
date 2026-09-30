#!/usr/bin/env node
// The values of the Worker "mail-hero" that are never committed to ../wrangler.toml, added at deploy time
// with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry):
//
// - personal (GitHub environment secrets, masked in the public Actions log; wrangler prints --var values
//   as "(hidden)"): RECEIVE_ADDRESS, ACCESS_OWNER, ACCESS_OWNER_ALIASES;
// - operational state (GitHub environment variables; a release restates them and never overwrites them,
//   AGENTS.md §8): FORCE_SEND_PAUSED, MAINTENANCE_MODE.
//
// Wrangler silently DELETES a var that a deploy does not send (the config has no keep_vars), so this
// wrapper refuses to run unless every value is present and valid. Messages name the setting, never a value.
//
//   node deploy/deploy-vars.mjs check
//   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy [--dry-run] --config ../wrangler.toml
//     (from cloudflare/, where the pinned wrangler lives)
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` must set each.
// deploy-vars-inputs exec: MAIL_HERO_RECEIVE_ADDRESS MAIL_HERO_ACCESS_OWNER MAIL_HERO_ACCESS_OWNER_ALIASES
// deploy-vars-inputs exec: MAIL_HERO_FORCE_SEND_PAUSED MAIL_HERO_MAINTENANCE_MODE
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
const FLAG = /^(?:true|false)$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048

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

/** Worker var <- GitHub name, in deploy order. `validate` returns the value to send, or null. */
export const INJECTED = [
  { name: 'RECEIVE_ADDRESS', from: 'MAIL_HERO_RECEIVE_ADDRESS', kind: 'personal', validate: matching(EMAIL) },
  { name: 'ACCESS_OWNER', from: 'MAIL_HERO_ACCESS_OWNER', kind: 'personal', validate: matching(ACCESS_EMAIL) },
  // Up to 8 exact login emails that resolve to ACCESS_OWNER; empty is allowed (sent as "").
  { name: 'ACCESS_OWNER_ALIASES', from: 'MAIL_HERO_ACCESS_OWNER_ALIASES', kind: 'personal', optional: true, validate: aliasList },
  { name: 'FORCE_SEND_PAUSED', from: 'MAIL_HERO_FORCE_SEND_PAUSED', kind: 'toggle', validate: matching(FLAG) },
  { name: 'MAINTENANCE_MODE', from: 'MAIL_HERO_MAINTENANCE_MODE', kind: 'toggle', validate: matching(FLAG) },
]

/** {NAME: value} for every injected var. Throws SettingError naming the first bad setting. */
export function injectedVars(env) {
  const vars = {}
  for (const { name, from, optional, validate } of INJECTED) {
    const value = env[from]
    // Absent means the CI step forgot the setting: always refused. Empty is refused unless optional.
    // Surrounding whitespace (a newline pasted into a secret) is refused; the alias list is normalized
    // item by item instead, as before.
    if (typeof value !== 'string' || (value === '' && !optional) || (!optional && value !== value.trim())) throw new SettingError(from)
    const checked = value.trim() === '' ? '' : validate(value)
    if (checked === null) throw new SettingError(from)
    vars[name] = checked
  }
  return vars
}

/** The flags appended to the wrangler command: --var NAME:value (wrangler splits at the first colon). */
export function wranglerArgs(env) {
  return Object.entries(injectedVars(env)).flatMap(([name, value]) => ['--var', `${name}:${value}`])
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

function run(argv, env = process.env) {
  const [command, ...rest] = argv
  if (command === 'check' && rest.length === 0) {
    injectedVars(env)
    console.log(`Deploy values are valid (not printed): ${INJECTED.map(({ name }) => name).join(', ')}.`)
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
  console.error('Usage: deploy-vars.mjs check | exec -- <wrangler deploy command…>')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof SettingError ? error.message : 'Unable to prepare the deploy values.')
    process.exitCode = 1
  }
}
