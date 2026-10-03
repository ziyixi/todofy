import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RestD1, configureWebhook, readSecret, safeError } from '../../deploy/configure-webhook.mjs'
import { decryptCredential } from '../src/native/security.ts'

const token = 'test-credential-which-must-not-be-logged'
const options = { owner: 'owner@example.org', url: 'https://consumer.example.org/mail', label: 'Consumer',
  'action-id': 'fe2fdc28-e75b-4991-90d5-d7b8a67a4e05' }
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  const directory = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'))
  const requests = []
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.cloudflare.com')
    assert.equal(init.redirect, 'error')
    const body = JSON.parse(init.body)
    requests.push(body)
    const queries = body.batch ?? [body]
    sqlite.exec('BEGIN')
    try {
      const result = queries.map(({ sql, params }) => ({ success: true,
        results: sqlite.prepare(sql).all(...params).map(row => ({ ...row })),
        meta: { changes: sqlite.prepare('SELECT changes() n').get().n } }))
      sqlite.exec('COMMIT')
      return Response.json({ success: true, result })
    } catch {
      sqlite.exec('ROLLBACK')
      return Response.json({ success: false, errors: [{ message: `unsafe provider echo ${token}` }] })
    }
  }
  const DB = new RestD1('a'.repeat(32), '1664e49d-0a32-4e6d-86b7-a09bbd819ce4', 'fake-cf-token', fetcher)
  return { sqlite, requests, env: { DB, CREDENTIAL_KEY: '12'.repeat(32), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org' } }
}

test('bootstrap encrypts one paused endpoint through native code; repeat checks without rotating or changing mode', async t => {
  const { sqlite, requests, env } = fixture()
  t.after(() => sqlite.close())
  const result = await configureWebhook(env, options, token)
  assert.equal(result.created, true)
  assert.equal(result.paused, true)
  const revision = sqlite.prepare('SELECT * FROM endpoint_revisions').get()
  assert.equal(await decryptCredential(env, revision.id, revision.url, revision.credential_ciphertext), token)
  assert.equal(revision.credential_ciphertext.includes(token), false)
  assert.equal(sqlite.prepare('SELECT mode FROM app_settings').get().mode, 'archive')
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ui_actions').get().n, 1)
  assert.equal(requests.filter(body => body.batch?.length === 3).length, 1, 'the endpoint and its first revision commit together')
  assert.equal(JSON.stringify(requests).includes(token), false)
  const second = await configureWebhook(env, options, token)
  assert.equal(second.id, result.id)
  assert.equal(second.created, false)
  await assert.rejects(configureWebhook(env, options, token + '-rotated'), /existing_credential_mismatch/)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM endpoint_revisions').get().n, 1)
  assert.equal(JSON.stringify(result).includes(token), false)
})

test('native action reservation resumes after transactional batch failure without an orphan endpoint', async t => {
  const { sqlite, env } = fixture()
  t.after(() => sqlite.close())
  sqlite.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON endpoint_revisions BEGIN SELECT RAISE(ABORT,'test failure'); END")
  await assert.rejects(configureWebhook(env, options, token), /cloudflare_query_failed/)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM webhook_endpoints').get().n, 0)
  assert.equal(sqlite.prepare('SELECT result_ref FROM ui_actions').get().result_ref, null)
  sqlite.exec('DROP TRIGGER fail_revision')
  const result = await configureWebhook(env, options, token)
  assert.equal(result.created, true)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM webhook_endpoints').get().n, 1)
})

test('secret files reject shared permissions and symlinks; safe errors never include provider text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-hero-bootstrap-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'token')
  writeFileSync(path, token + '\n', { mode: 0o600 })
  assert.equal(readSecret(path, 'bearer'), token)
  chmodSync(path, 0o644)
  assert.throws(() => readSecret(path, 'bearer'), /secret_file_permissions/)
  chmodSync(path, 0o600)
  symlinkSync(path, join(directory, 'link'))
  assert.throws(() => readSecret(join(directory, 'link'), 'bearer'), /secret_file_unavailable/)
  const db = new RestD1('a'.repeat(32), '1664e49d-0a32-4e6d-86b7-a09bbd819ce4', token,
    async () => { throw new Error(token) })
  await assert.rejects(db.prepare('SELECT 1').run(), error => safeError(error) === 'cloudflare_request_failed')
  assert.equal(safeError(new Error(token)), 'configuration_failed')
})
