#!/usr/bin/env node
// The values of the Worker "brief" that are never committed to ../wrangler.toml, added at deploy time (the shape of
// mailsort's wrapper):
//
// - with `wrangler deploy --var NAME:value` (a plain_text var, exactly like a [vars] entry): MODE (the GitHub variable
//   BRIEF_MODE: `off`, `archive`, `shadow` or `live`, the highest mode the deployment allows: the emergency switch,
//   ../docs/design.md §15) and BUILD_SHA (the commit);
// - with `--secrets-file` (Worker secrets, hidden in wrangler's output): the owner's addresses, the CSRF key, the
//   feedback links' signing key and the two mail addresses (inputs BRIEF_ACCESS_OWNER, BRIEF_ACCESS_OWNER_ALIASES,
//   BRIEF_FEEDBACK_SIGNING_KEY, BRIEF_MAIL_FROM, BRIEF_MAIL_TO, masked in the public Actions
//   log). The deploy job fills the first two from the dashboard's DASHBOARD_ACCESS_OWNER(_ALIASES) (the same owner,
//   like mailsort) and the rest from the brief's own secrets.
//
// The Claude API key and the Resend key (ANTHROPIC_API_KEY, RESEND_API_KEY) are never part of a deploy: the owner puts
// them from their own machine (`wrangler secret put`, ../docs/design.md §18). The secrets file never names them, and
// this wrapper refuses a BRIEF_WORKER_SECRETS map that does, so they can neither come from GitHub nor be overwritten by
// a deploy; and `wrangler deploy --secrets-file` keeps every secret the file does not name (test/secrets-kept.test.mjs
// checks the pinned wrangler), so a deploy never deletes them either.
//
// A real deploy is refused while ../wrangler.toml has no ACCESS_AUDIENCE (before "Infra apply" creates the Access
// application); a `wrangler deploy --dry-run` (CI's bundle check) is always allowed.
//
// Wrangler silently DELETES a var that a deploy does not send (the config has no keep_vars), so this wrapper refuses
// to run unless every value is present and valid. Messages name the setting, never a value.
//
//   node deploy/deploy-vars.mjs check
//   node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/brief-secrets.json"            (from worker/)
//   node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy [--dry-run] \
//     --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/brief-secrets.json"        (from worker/)
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: BRIEF_MODE GITHUB_SHA
// deploy-vars-inputs secrets: BRIEF_ACCESS_OWNER BRIEF_ACCESS_OWNER_ALIASES BRIEF_FEEDBACK_SIGNING_KEY BRIEF_MAIL_FROM BRIEF_MAIL_TO
import { mergeWorkerSecrets } from '../../tools/cloud-config/worker-secrets.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))

// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
// The mail addresses, as the Worker reads them (worker/src/env.ts mailSettings): `a@b.c`, or `Name <a@b.c>` for the
// sender.
const MAIL_ADDRESS = /^(?=[\x21-\x7e]+$)[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/
const NAMED_ADDRESS = /^(?:(?=[\x21-\x7e]+$)[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+|[^<>\r\n]{0,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>)$/
const HEX_KEY = /^[0-9a-fA-F]{64}$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048

export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing deploy setting: ${name}`)
    this.setting = name
  }
}

/** Worker var <- environment name. An absent or empty value is refused. */
export const INJECTED = [
  { name: 'MODE', from: 'BRIEF_MODE', kind: 'toggle', pattern: /^(?:off|archive|shadow|live)$/ },
  { name: 'BUILD_SHA', from: 'GITHUB_SHA', kind: 'build', pattern: /^[0-9a-f]{40}$/ },
]

/** The Claude API key and the Resend key: put from the owner's machine, never by a deploy. */
export const OWNER_ONLY_SECRETS = ['ANTHROPIC_API_KEY', 'RESEND_API_KEY']

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
  const name = 'BRIEF_ACCESS_OWNER_ALIASES'
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
    ACCESS_OWNER: checked(env, 'BRIEF_ACCESS_OWNER', ACCESS_EMAIL),
    // --secrets-file only adds or replaces secrets: an emptied list is uploaded as one space (read as no
    // aliases) rather than left out, which would keep the previous aliases working.
    ACCESS_OWNER_ALIASES: list.join(',') || ' ',
    FEEDBACK_SIGNING_KEY: checked(env, 'BRIEF_FEEDBACK_SIGNING_KEY', HEX_KEY),
    MAIL_FROM: checked(env, 'BRIEF_MAIL_FROM', NAMED_ADDRESS),
    MAIL_TO: checked(env, 'BRIEF_MAIL_TO', MAIL_ADDRESS),
  }
  const secrets = mergeWorkerSecrets('brief', env, personal, SettingError)
  if (OWNER_ONLY_SECRETS.some((name) => Object.hasOwn(secrets, name))) throw new SettingError('BRIEF_WORKER_SECRETS')
  return secrets
}

/**
 * Why the committed config cannot be deployed for real yet, or null (a text scan of the TOML): ACCESS_AUDIENCE is added
 * only once the Access application exists, and the all-zeros placeholder never counts.
 */
export function placeholderIn(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  const match = /^\s*ACCESS_AUDIENCE\s*=\s*"([0-9a-f]{64})"/m.exec(lines)
  if (match === null || /^0{64}$/.test(match[1])) return 'ACCESS_AUDIENCE'
  return null
}

/** Writes the secrets file owner-only, never over an existing file. */
export function writeSecrets(path, env) {
  writeFileSync(path, JSON.stringify(generateSecrets(env), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

/**
 * Why `argv` must not run through this wrapper, or null. `cwd` resolves a relative --config; `readConfig` returns the
 * committed config's text (the tests pass a text with an AUD to prove the placeholder guard).
 */
export function refusal(argv, cwd = process.cwd(), readConfig = () => readFileSync(CONFIG, 'utf8')) {
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
  const placeholder = placeholderIn(readConfig())
  if (placeholder && !argv.includes('--dry-run')) return `${placeholder} is missing from the committed config (a real deploy needs the Access application's AUD)`
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
    console.log('Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES, FEEDBACK_SIGNING_KEY, MAIL_FROM, MAIL_TO (values not printed).')
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
