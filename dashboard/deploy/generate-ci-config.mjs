#!/usr/bin/env node
// Generates the production Wrangler config of the Worker "home" and its secrets file from validated
// GitHub variables and secrets (docs/design.md §10), in the style of Mail Hero's and Todofy's
// generators:
//
// - The Worker's shape (entry, compatibility date, assets, Durable Object, migrations, service
//   bindings, cron) is copied from the checked-in worker/wrangler.toml, read with the pinned
//   wrangler's own raw-config reader, so production cannot drift from what the tests run. Account,
//   route and vars come from the environment; a test fails when wrangler.toml gains an unknown key.
// - The owner's addresses, the CSRF key and the analytics token are never vars (Wrangler prints vars
//   and the Actions logs are public): they go to an owner-only secrets file for
//   `wrangler deploy --secrets-file`, where they become hidden Worker secrets.
// - Messages name variables and never print values; DEV_* switches are never emitted.
// - Both files are written next to wrangler.toml (wrangler resolves `main` and assets relative to the
//   config) with mode 0600 and never over an existing file.
//
//   node deploy/generate-ci-config.mjs        (from dashboard/, after `npm ci` in worker/)
import { unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKER = new URL('../worker/', import.meta.url)
export const BASE_CONFIG = fileURLToPath(new URL('wrangler.toml', WORKER))
export const CONFIG_OUTPUT = fileURLToPath(new URL('wrangler.production.ci.json', WORKER))
export const SECRETS_OUTPUT = fileURLToPath(new URL('wrangler.production.secrets.json', WORKER))

/** Keys copied verbatim from wrangler.toml. */
export const SHAPE_KEYS = ['name', 'main', 'compatibility_date', 'assets', 'durable_objects', 'migrations', 'services', 'triggers']
/** Keys of wrangler.toml that the generator replaces (local placeholders). */
export const REPLACED_KEYS = ['workers_dev', 'preview_urls', 'vars']

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const ACCESS_EMAIL = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ALIASES = 8
const MAX_LIST_CHARS = 2048

export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing CI setting: ${name}`)
  }
}

function checked(env, name, pattern, fallback) {
  // GitHub passes an unset variable as "": empty means the fallback, or missing when there is none.
  const value = env[name] || fallback
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) throw new SettingError(name)
  return value
}

function aliases(env) {
  const name = 'DASHBOARD_ACCESS_OWNER_ALIASES'
  const raw = env[name] ?? ''
  if (typeof raw !== 'string') throw new SettingError(name)
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean)
  if (
    items.length > MAX_ALIASES ||
    new Set(items).size !== items.length ||
    items.join(',').length > MAX_LIST_CHARS ||
    !items.every((item) => ACCESS_EMAIL.test(item))
  ) throw new SettingError(name)
  return items
}

/** The production config from `env` (GitHub variables) and `base` (the parsed wrangler.toml). */
export function generateConfig(env, base) {
  const unknown = Object.keys(base).filter((key) => !SHAPE_KEYS.includes(key) && !REPLACED_KEYS.includes(key))
  if (unknown.length > 0) throw new Error(`wrangler.toml has keys the generator does not know: ${unknown.join(', ')}`)
  const accountId = checked(env, 'CLOUDFLARE_ACCOUNT_ID', /^[a-f0-9]{32}$/i)
  const host = checked(env, 'DASHBOARD_PUBLIC_HOST', DOMAIN)
  const mailHeroHost = checked(env, 'MAIL_HERO_PUBLIC_HOST', DOMAIN)
  const todofyHost = checked(env, 'TODOFY_PUBLIC_HOST', DOMAIN)
  // The dashboard's custom domain must be its own; claiming an app's host would take its route.
  if (host === mailHeroHost || host === todofyHost) throw new SettingError('DASHBOARD_PUBLIC_HOST')
  const hour = checked(env, 'DASHBOARD_CANARY_UTC_HOUR', /^(?:[0-9]|1[0-9]|2[0-3])$/, '16')
  return {
    ...Object.fromEntries(SHAPE_KEYS.map((key) => [key, base[key]])),
    account_id: accountId,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    routes: [{ pattern: host, custom_domain: true }],
    vars: {
      PUBLIC_HOST: host,
      ACCESS_ISSUER: checked(env, 'DASHBOARD_ACCESS_ISSUER', /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
      ACCESS_AUDIENCE: checked(env, 'DASHBOARD_ACCESS_AUDIENCE', /^[a-f0-9]{64}$/i),
      ACCOUNT_ID: accountId,
      MAIL_HERO_URL: `https://${mailHeroHost}/`,
      TODOFY_URL: `https://${todofyHost}/`,
      CANARY_UTC_HOUR: hour,
      BUILD_SHA: checked(env, 'GITHUB_SHA', /^[0-9a-f]{40}$/),
    },
  }
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
    // Used only for the GraphQL Analytics API; should be an "Account Analytics: Read" token.
    CF_ANALYTICS_TOKEN: checked(env, 'DASHBOARD_CF_ANALYTICS_TOKEN', /^[A-Za-z0-9_-]{20,200}$/),
  }
}

/** wrangler.toml as Wrangler itself parses it (the pinned wrangler in worker/node_modules). */
export async function readBase(path = BASE_CONFIG) {
  const require = createRequire(new URL('package.json', WORKER))
  const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
  // Plain JSON values (the TOML parser returns null-prototype objects).
  return JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: path }).rawConfig))
}

function writePrivate(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

export async function main(env = process.env, outputs = { config: CONFIG_OUTPUT, secrets: SECRETS_OUTPUT }) {
  const written = []
  try {
    const config = generateConfig(env, await readBase())
    const secrets = generateSecrets(env)
    for (const [path, data] of [[outputs.config, config], [outputs.secrets, secrets]]) {
      writePrivate(path, data)
      written.push(path)
    }
    console.log(`Generated production configuration; values were not printed. Vars: ${Object.keys(config.vars).sort().join(', ')}. Secrets file: ${Object.keys(secrets).sort().join(', ')}.`)
    return 0
  } catch (error) {
    // Never leave half a pair behind, and never remove a file this run did not write.
    for (const path of written) unlinkSync(path)
    if (error instanceof SettingError) console.error(error.message)
    else if (error?.code === 'EEXIST') console.error('CI configuration already exists; nothing was overwritten.')
    else console.error('Unable to generate CI configuration.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
