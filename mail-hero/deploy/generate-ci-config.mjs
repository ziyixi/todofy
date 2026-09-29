#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const output = new URL('../cloudflare/wrangler.native.production.ci.json', import.meta.url)
const fail = name => { throw new Error(`Invalid or missing CI setting: ${name}`) }
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Access owner and aliases: printable ASCII only, as packages/edge-auth requires (SPEC.md #36).
const accessEmailPattern = /^(?=[\x21-\x7e]+$)[^\s@]+@[^\s@]+\.[^\s@]+$/
function checked(env, name, pattern, fallback) {
  const value = env[name] ?? fallback
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) fail(name)
  return value
}
function flag(env, name) { return checked(env, name, /^(true|false)$/) }
function integer(env, name, fallback, maximum) {
  const value = checked(env, name, /^[1-9][0-9]*$/, fallback)
  if (!Number.isSafeInteger(Number(value)) || Number(value) > maximum) fail(name)
  return value
}

export function generateConfig(env) {
  const aliases = (env.MAIL_HERO_ACCESS_OWNER_ALIASES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (aliases.length > 8 || aliases.join(',').length > 2048 || aliases.some(value => !accessEmailPattern.test(value))) fail('MAIL_HERO_ACCESS_OWNER_ALIASES')
  const allowed = (env.MAIL_HERO_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (!allowed.length || allowed.some(value => !domainPattern.test(value))) fail('MAIL_HERO_WEBHOOK_ALLOWED_HOSTS')
  const alertAllowed = (env.MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (alertAllowed.some(value => !domainPattern.test(value))) fail('MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS')
  const alertURL = env.MAIL_HERO_ALERT_WEBHOOK_URL ?? ''
  if (alertURL) {
    let parsed
    try { parsed = new URL(alertURL) } catch { fail('MAIL_HERO_ALERT_WEBHOOK_URL') }
    if (alertURL !== alertURL.trim() || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
      (parsed.port && parsed.port !== '443') || !(alertAllowed.length ? alertAllowed : allowed).includes(parsed.hostname)) fail('MAIL_HERO_ALERT_WEBHOOK_URL')
  }
  const publicHost = checked(env, 'MAIL_HERO_PUBLIC_HOST', domainPattern)
  const databaseID = checked(env, 'MAIL_HERO_D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  return {
    name: 'mail-hero',
    account_id: checked(env, 'CLOUDFLARE_ACCOUNT_ID', /^[a-f0-9]{32}$/i),
    main: 'src/native/index.ts', compatibility_date: '2026-09-07',
    workers_dev: false, preview_urls: false,
    assets: { directory: '../uiassets/dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    vars: {
      RECEIVE_ADDRESS: checked(env, 'MAIL_HERO_RECEIVE_ADDRESS', emailPattern),
      ACCESS_ISSUER: checked(env, 'MAIL_HERO_ACCESS_ISSUER', /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
      ACCESS_AUDIENCE: checked(env, 'MAIL_HERO_ACCESS_AUDIENCE', /^[a-f0-9]{64}$/i),
      ACCESS_OWNER: checked(env, 'MAIL_HERO_ACCESS_OWNER', accessEmailPattern),
      ACCESS_OWNER_ALIASES: aliases.join(','), WEBHOOK_ALLOWED_HOSTS: allowed.join(','),
      ...(alertURL ? { ALERT_WEBHOOK_URL: alertURL, ALERT_WEBHOOK_ALLOWED_HOSTS: (alertAllowed.length ? alertAllowed : allowed).join(',') } : {}),
      FORCE_SEND_PAUSED: flag(env, 'MAIL_HERO_FORCE_SEND_PAUSED'),
      MAINTENANCE_MODE: flag(env, 'MAIL_HERO_MAINTENANCE_MODE'),
      INGEST_DAILY_MESSAGE_LIMIT: integer(env, 'MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT', '300', 100000),
      INGEST_DAILY_BYTE_LIMIT: integer(env, 'MAIL_HERO_INGEST_DAILY_BYTE_LIMIT', '268435456', 10737418240),
      // contracts/ops-v1 status() links the owner UI; the same host as the custom-domain route.
      PUBLIC_HOST: publicHost,
    },
    d1_databases: [{ binding: 'DB', database_name: checked(env, 'MAIL_HERO_D1_DATABASE_NAME', /^[a-zA-Z0-9_-]{1,63}$/, 'mail-hero'),
      database_id: databaseID, migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'MAIL_STORE', bucket_name: checked(env, 'MAIL_HERO_R2_BUCKET_NAME', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'mail-hero-store') },
      ...(env.MAIL_HERO_BACKUP_BUCKET_NAME ? [{binding: 'BACKUP_STORE', bucket_name: checked(env, 'MAIL_HERO_BACKUP_BUCKET_NAME', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)}] : [])],
    durable_objects: { bindings: [{ name: 'COORDINATOR', class_name: 'MailCoordinator' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['MailCoordinator'] }],
    observability: { enabled: false },
    routes: [{ pattern: publicHost, custom_domain: true }],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Never overwrite a local production configuration. This generated file is
    // ignored, removed by CI and never uploaded as an artifact or printed.
    writeFileSync(output, JSON.stringify(generateConfig(process.env), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log('Generated native CI configuration; values were not printed.')
  } catch (error) {
    console.error(error?.code === 'EEXIST' ? 'CI configuration already exists; nothing was overwritten.' :
      /^Invalid or missing CI setting: [A-Z_]+$/.test(error?.message ?? '') ? error.message : 'Unable to generate CI configuration.')
    process.exitCode = 1
  }
}
