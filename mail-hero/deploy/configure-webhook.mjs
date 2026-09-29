#!/usr/bin/env node
// Requires Node >=24 and `npm ci` in cloudflare/. This is an administrative
// bootstrap, not an authentication bypass exposed by the Worker.
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import { createEndpoint, validateCredential } from '../cloudflare/src/native/api-endpoints.ts'
import { endpointSelect, uuid } from '../cloudflare/src/native/api-common.ts'
import { decryptCredential, HttpError, validateTarget } from '../cloudflare/src/native/security.ts'

class BootstrapError extends Error {}
const fail = code => { throw new BootstrapError(code) }

export function readSecret(path, kind) {
  let fd
  try {
    // Check the opened inode: disallow symlinks, devices and shared permissions.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8192) fail('secret_file_permissions')
    const value = readFileSync(fd, 'utf8').replace(/\r?\n$/, '')
    if (kind === 'key' && !/^[a-fA-F0-9]{64}$/.test(value)) fail('invalid_master_key')
    if (kind === 'cloudflare' && !/^[a-zA-Z0-9_-]{20,512}$/.test(value)) fail('invalid_cloudflare_token')
    if (kind === 'bearer') validateCredential('bearer', value)
    return value
  } catch (error) {
    if (error instanceof BootstrapError || error instanceof HttpError) throw error
    fail('secret_file_unavailable')
  } finally { if (fd !== undefined) closeSync(fd) }
}

// D1 REST accepts {sql,params} or {batch:[{sql,params}]}. Values are always bound.
// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
export class RestD1 {
  constructor(account, database, token, fetcher = fetch) {
    if (!/^[a-fA-F0-9]{32}$/.test(account)) fail('invalid_account')
    uuid(database, 'database')
    this.url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`
    this.token = token
    this.fetcher = fetcher
  }
  prepare(sql) { return new Statement(this, sql) }
  async request(body, count) {
    let response, value
    try {
      response = await this.fetcher(this.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) fail(`cloudflare_http_${response.status}`)
      value = await response.json()
    } catch (error) {
      if (error instanceof BootstrapError) throw error
      fail('cloudflare_request_failed')
    }
    // Never propagate provider messages: a SQL error can echo parameters.
    if (value.success !== true || !Array.isArray(value.result) || value.result.length !== count ||
        value.result.some(item => item.success !== true || !Array.isArray(item.results))) fail('cloudflare_query_failed')
    return value.result
  }
  async batch(statements) {
    if (!statements.length || statements.some(statement => statement.db !== this)) fail('invalid_batch')
    return this.request({ batch: statements.map(({ sql, params }) => ({ sql, params })) }, statements.length)
  }
}
class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params }
  bind(...params) { return new Statement(this.db, this.sql, params) }
  async all() { return (await this.db.request({ sql: this.sql, params: this.params }, 1))[0] }
  async run() { return this.all() }
  async first(column) {
    const row = (await this.all()).results[0] ?? null
    return column ? row?.[column] ?? null : row
  }
}

function safeMetadata(endpoint, created) {
  return { created, id: endpoint.id, current_revision_id: endpoint.current_revision_id,
    url: endpoint.url, paused: !!endpoint.paused, version: endpoint.version,
    mode_unchanged: true, sending_unchanged: true }
}

export async function configureWebhook(env, options, credential) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.owner)) fail('invalid_owner')
  uuid(options['action-id'], 'action-id')
  validateCredential('bearer', credential)
  const url = validateTarget(env, options.url).href
  // Never silently rotate an existing destination or create a second one.
  const matches = (await env.DB.prepare(endpointSelect + ' WHERE e.archived_at IS NULL AND r.url=?')
    .bind(url).all()).results
  if (matches.length > 1) fail('multiple_existing_endpoints')
  if (matches.length === 1) {
    const existing = matches[0]
    if (existing.auth_type !== 'bearer') fail('existing_credential_mismatch')
    const old = Buffer.from(await decryptCredential(env, existing.current_revision_id, url, existing.credential_ciphertext))
    const next = Buffer.from(credential)
    if (old.length !== next.length || !timingSafeEqual(old, next)) fail('existing_credential_mismatch')
    return safeMetadata(existing, false)
  }
  const response = await createEndpoint(new Request('https://admin.invalid/api/endpoints', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: options.label, url, auth_type: 'bearer', credential,
      paused: true, rate_per_minute: 2, timeout_seconds: 20, action_request_id: options['action-id'] }),
  }), env, options.owner)
  if (response.status !== 201) fail('endpoint_creation_failed')
  return safeMetadata(await response.json(), true)
}

export function safeError(error) {
  if (error instanceof BootstrapError) return error.message
  if (error instanceof HttpError && /^[a-z_]+$/.test(error.code)) return error.code
  return 'configuration_failed'
}

const optionNames = ['account', 'database', 'owner', 'allow-host', 'url', 'label', 'token-file',
  'cloudflare-token-file', 'credential-key-file', 'action-id']
async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    ...optionNames.map(name => [name, { type: 'string' }]), ['help', { type: 'boolean' }],
  ]) })
  if (values.help) {
    console.log('Create a paused Bearer webhook endpoint using existing native validation and encryption.\n' +
      'Required options: ' + optionNames.map(name => `--${name} VALUE`).join(' ') + '\n' +
      'All three secret files must be owner-only regular files. No secrets in arguments.\n' +
      'Reuse the same action-id after an uncertain result. Existing matching targets are not modified.\n' +
      'This command does not change archive/forward mode, global pause or Worker configuration.')
    return
  }
  if (optionNames.some(name => !values[name])) fail('missing_required_option')
  if (!/^[a-zA-Z0-9.-]+$/.test(values['allow-host'])) fail('invalid_allowed_host')
  const env = {
    DB: new RestD1(values.account, values.database, readSecret(values['cloudflare-token-file'], 'cloudflare')),
    CREDENTIAL_KEY: readSecret(values['credential-key-file'], 'key'),
    WEBHOOK_ALLOWED_HOSTS: values['allow-host'],
  }
  const result = await configureWebhook(env, values, readSecret(values['token-file'], 'bearer'))
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Webhook bootstrap stopped: ${safeError(error)}. No secrets were printed.`); process.exitCode = 1 })
}
