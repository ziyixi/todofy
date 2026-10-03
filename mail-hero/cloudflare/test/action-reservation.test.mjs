import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'

test('workerd action reservation rolls back on read failure and preserves retry, owner and request identity', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const bundle = await build({
    stdin: { contents: `
      import { action } from './src/native/api-common';
      import { HttpError } from './src/native/security';
      export default { async fetch(request, env) {
        const input = await request.json();
        const DB = {
          prepare(sql) {
            if (input.fail_read && sql.startsWith('SELECT * FROM ui_actions')) {
              sql = 'SELECT missing_test_column FROM ui_actions WHERE owner=? AND action_request_id=?';
            }
            return env.DB.prepare(sql);
          },
          batch(statements) { return env.DB.batch(statements); },
        };
        try {
          return Response.json(await action({ ...env, DB }, input.owner, input.request_id,
            input.operation, input.resource, input.value));
        } catch (error) {
          return Response.json({ code: error instanceof HttpError ? error.code : 'dependency_failed' },
            { status: error instanceof HttpError ? error.status : 503 });
        }
      }};`, resolveDir: root, sourcefile: 'action-reservation-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false,
  })
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'action-reservation-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'action-reservation-test' },
    bindings: { CREDENTIAL_KEY: '12'.repeat(32) },
  }))
  try {
    const db = await mf.getD1Database('DB')
    const directory = new URL('../migrations/', import.meta.url)
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await db.batch(migrationStatements(await readFile(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)))
    }
    const input = { owner: 'owner@example.org', request_id: crypto.randomUUID(), operation: 'send',
      resource: crypto.randomUUID(), value: crypto.randomUUID() }
    async function reserve(overrides = {}) {
      const response = await mf.dispatchFetch('http://localhost/reserve', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ...overrides }) })
      return { status: response.status, body: await response.json() }
    }
    const count = async () => (await db.prepare('SELECT count(*) n FROM ui_actions').first()).n

    assert.deepEqual(await reserve({ fail_read: true }), { status: 503, body: { code: 'dependency_failed' } })
    assert.equal(await count(), 0, 'a failed second statement rolls back the first statement in actual D1')
    const first = await reserve()
    assert.equal(first.status, 200)
    assert.equal(first.body.result_ref, null, 'reservation is an unfinished intent')
    assert.deepEqual(await reserve(), first, 'a lost reservation response is recovered with the same identity')
    assert.equal(await count(), 1)

    const event = crypto.randomUUID()
    await db.prepare('UPDATE ui_actions SET result_ref=?,http_status=201 WHERE id=?').bind(event, first.body.id).run()
    const completed = await reserve()
    assert.equal(completed.body.id, first.body.id)
    assert.equal(completed.body.result_ref, event, 'an existing result is never reset by the ignored insert')
    assert.equal(completed.body.http_status, 201)
    assert.deepEqual(await reserve({ fail_read: true }), { status: 503, body: { code: 'dependency_failed' } })
    assert.deepEqual(await reserve(), completed, 'failure leaves a pre-existing acknowledged action unchanged')
    for (const change of [{ value: 'different' }, { resource: crypto.randomUUID() }, { operation: 'replay' }]) {
      assert.deepEqual(await reserve(change), { status: 400, body: { code: 'request_id_reused' } })
    }
    assert.deepEqual(await reserve(), completed, 'conflicting requests cannot rewrite the frozen intent or result')

    const request = crypto.randomUUID()
    const [one, two] = await Promise.all([reserve({ request_id: request }), reserve({ request_id: request })])
    assert.equal(one.status, 200)
    assert.deepEqual(two, one, 'simultaneous identical actions share the same durable intent')
    assert.equal(await count(), 2)
    const otherOwner = await reserve({ owner: 'other@example.org' })
    assert.equal(otherOwner.status, 200)
    assert.notEqual(otherOwner.body.id, first.body.id, 'owner scope remains part of the ledger identity')
    assert.equal(await count(), 3)
  } finally { await mf.dispose() }
})
