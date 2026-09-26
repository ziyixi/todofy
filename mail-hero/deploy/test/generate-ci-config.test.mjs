import test from 'node:test'
import assert from 'node:assert/strict'
import { generateConfig } from '../generate-ci-config.mjs'

function environment() {
  return { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), MAIL_HERO_D1_DATABASE_ID: '15e53438-8b8e-4821-bc45-c40da0e3e9bd',
    MAIL_HERO_RECEIVE_ADDRESS: 'hero@inbox.example.org', MAIL_HERO_ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    MAIL_HERO_ACCESS_AUDIENCE: 'b'.repeat(64), MAIL_HERO_ACCESS_OWNER: 'owner@example.org',
    MAIL_HERO_ACCESS_OWNER_ALIASES: 'alias@example.org', MAIL_HERO_PUBLIC_HOST: 'mail.example.org',
    MAIL_HERO_WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org', MAIL_HERO_FORCE_SEND_PAUSED: 'false',
    MAIL_HERO_MAINTENANCE_MODE: 'false' }
}
test('CI configuration targets only the native service and preserves the SQLite DO migration', () => {
  const config = generateConfig(environment())
  assert.equal(config.main, 'src/native/index.ts')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.vars.ACCESS_OWNER_ALIASES, 'alias@example.org')
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['MailCoordinator'] }])
  assert.equal(config.d1_databases[0].database_name, 'mail-hero')
  assert.equal(config.r2_buckets[0].bucket_name, 'mail-hero-store')
  assert.equal(config.vars.INGEST_DAILY_MESSAGE_LIMIT, '300')
  assert.equal('CREDENTIAL_KEY' in config.vars, false)
  assert.equal('DEV_AUTH_BYPASS' in config.vars, false)
  assert.equal('limits' in config, false)
})
test('missing pause state, invalid resource identity and malformed alias fail before deployment', () => {
  for (const [name, value] of [
    ['MAIL_HERO_FORCE_SEND_PAUSED', undefined], ['MAIL_HERO_MAINTENANCE_MODE', 'False'],
    ['MAIL_HERO_D1_DATABASE_ID', '00000000-0000-0000-0000-000000000000'],
    ['MAIL_HERO_WEBHOOK_ALLOWED_HOSTS', 'https://consumer.example.org'],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', 'owner@example.org\ninjected-value'],
  ]) assert.throws(() => generateConfig({ ...environment(), [name]: value }), new RegExp(name))
})
