import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { canonicalJSON } from '../src/native/backup.ts'
import { startRuntime } from './runtime-harness.mjs'

const fixture = 'From: sender@example.org\r\nTo: inbox@mail.example.org\r\nSubject: Synthetic backup fixture\r\n\r\nBackup contract test only.\r\n'
const token = 'synthetic-backup-machine-token-32-characters', receiptKey = 'b'.repeat(64)
const key = 'raw/11111111-1111-4111-8111-111111111111.eml'
const hash = value => createHash('sha256').update(value).digest('hex')

test('workerd snapshot cut preserves intake and verifies complete export before resuming', { timeout: 90000 }, async () => {
  const { mf, db, close } = await startRuntime({
    prefix: 'mail-hero-backup-test-',
    name: 'mail-hero-backup-test',
    entry: {
      sourcefile: 'native-backup-entry.ts',
      contents: `
    import app from './src/native/index';
    import { emailHandler } from './src/native/ingest';
    export { MailCoordinator } from './src/native/coordinator';
    export default {async fetch(request,env,ctx) {
      const url=new URL(request.url);
      if(url.pathname.startsWith('/__test/coordinator/')) return env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch(new Request('https://coordinator/'+url.pathname.slice('/__test/coordinator/'.length)+url.search,request));
      if(url.pathname==='/__test/email') {
        await emailHandler({from:'sender@example.org',to:env.RECEIVE_ADDRESS,raw:request.body,rawSize:Number(request.headers.get('x-raw-size')),setReject(){throw new Error('unexpected_reject');}},env,ctx);
        return new Response(null,{status:204});
      }
      return app.fetch(request,env,ctx);
    }};`,
    },
    d1Databases: { DB: 'backup-test' },
    r2Buckets: ['MAIL_STORE', 'BACKUP_STORE'],
    durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } },
    bindings: {
      RECEIVE_ADDRESS: 'inbox@mail.example.org',
      ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'synthetic',
      ACCESS_OWNER: 'owner@example.org',
      CREDENTIAL_KEY: 'a'.repeat(64),
      WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
      BACKUP_TOKEN: token,
      BACKUP_RECEIPT_KEY: receiptKey,
      FORCE_SEND_PAUSED: 'true',
    },
    serviceBindings: { ASSETS: () => new Response('synthetic') },
    outboundService: () => { throw new Error('backup must not send external requests') },
  })
  try {
    const bucket = await mf.getR2Bucket('MAIL_STORE')
    async function call(path, input, authenticated = true) {
      return mf.dispatchFetch('http://localhost' + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
        body: input === undefined ? undefined : JSON.stringify(input),
      })
    }
    async function json(path, input) {
      const response = await call(path, input)
      const value = await response.json()
      assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`)
      return value
    }
    // The coordinator's snapshot handlers directly: the machine API no longer serves the v1 collector's actions.
    assert.equal((await call('/api/internal/backup/native/status', undefined, false)).status, 401)
    assert.equal((await call('/api/internal/backup/begin', { lease_seconds: 300 })).status, 404)
    const base = '/__test/coordinator/backup'
    const pre = await json('/__test/coordinator/reserve-ingest', { key, size: Buffer.byteLength(fixture) })
    const begun = await json(base + '/begin', { lease_seconds: 300 })
    assert.equal(begun.state, 'settling'); assert.equal(begun.cut_seq, pre.ingest_seq)
    const id = begun.backup_id, q = '?backup_id=' + id
    assert.equal((await call('/__test/coordinator/mutation/begin', {})).status, 503)
    const incoming = await mf.dispatchFetch('http://localhost/__test/email', {
      method: 'POST', headers: { 'x-raw-size': String(Buffer.byteLength(fixture)) }, body: fixture,
    })
    assert.equal(incoming.status, 204, await incoming.text())
    assert.equal((await json(base + '/status')).state, 'settling')
    assert.equal((await db.prepare('SELECT count(*) n FROM messages').first()).n, 0, 'lease prevents Alarm from publishing new mail to D1')
    await bucket.put(key, fixture, {
      customMetadata: {
        ingest_seq: String(pre.ingest_seq), from: 'sender@example.org', to: 'inbox@mail.example.org',
        received_at: new Date().toISOString(), raw_size: String(Buffer.byteLength(fixture)), mode: 'archive', revision: '',
      },
      httpMetadata: { contentType: 'message/rfc822' },
    })
    assert.equal((await json(base + '/status')).state, 'ready')
    const blocks = new Map()
    async function block(path, name) {
      const response = await call(base + path)
      const bytes = await response.text()
      assert.equal(response.status, 200, bytes); assert.equal(response.headers.get('X-Content-SHA256'), hash(bytes))
      blocks.set(name, bytes)
      return JSON.parse(bytes)
    }
    const control = await block('/control' + q, 'control.json')
    assert.deepEqual(control.uploads.map(r => r.key), [key]); assert.equal(control.policy.mode, 'archive')
    const schema = await block('/database-schema' + q, 'database-schema.json')
    // Additive columns (0010, contracts/ops-v1) travel with the generic schema export.
    for (const column of ['canary_run_id', 'active_since', 'messages_canary_idx']) assert.match(JSON.stringify(schema), new RegExp(column))
    for (const table of schema.tables) {
      let offset = 0
      do {
        const page = await block('/database' + q + '&table=' + encodeURIComponent(table) + '&offset=' + offset, `database/${table}/${offset}.json`)
        offset = page.next_offset
      } while (offset !== null)
    }
    assert.equal((await call(base + '/manifest' + q)).status, 409, 'all database pages are not enough without object inventory')
    const objects = await json(base + '/objects' + q)
    assert.equal(objects.complete, true); assert.deepEqual(objects.objects.map(o => o.key), [key])
    assert.deepEqual(await json(base + '/objects' + q), objects, 'a lost page response can be retried safely')
    const raw = await call(base + '/object' + q + '&key=' + encodeURIComponent(key))
    assert.equal(await raw.text(), fixture)
    const exported = await json(base + '/manifest' + q)
    assert.equal(hash(canonicalJSON(exported.manifest)), exported.manifest_sha256)
    for (const item of exported.manifest.blocks) {
      assert.equal(hash(blocks.get(item.name)), item.sha256)
      assert.equal(Buffer.byteLength(blocks.get(item.name)), item.bytes)
    }
    assert.equal(exported.manifest.credential_key_included, false)
    assert.equal((await call(base + '/finish', { backup_id: id, manifest_sha256: exported.manifest_sha256 })).status, 409)
    assert.equal((await db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, null)
    const receipt = {
      backup_id: id, manifest_sha256: exported.manifest_sha256,
      remote_locator: 'synthetic:independently-verified-test-artifact', verified_at: new Date().toISOString(),
    }
    const finish = {
      backup_id: id, manifest_sha256: exported.manifest_sha256, receipt,
      receipt_mac: createHmac('sha256', Buffer.from(receiptKey, 'hex')).update(canonicalJSON(receipt)).digest('hex'),
    }
    assert.equal((await json(base + '/finish', finish)).state, 'remote_verified')
    assert.equal((await json(base + '/finish', finish)).state, 'remote_verified', 'lost finish acknowledgement is idempotent')
    assert.equal((await db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, receipt.verified_at)
    assert.equal((await json(base + '/status')).paused, false)
    assert.equal((await bucket.list()).objects.length, 2, 'post-cut raw was accepted and remains durable outside this snapshot')
  } finally {
    await close()
  }
})

test('workerd backup artifact: authenticated lease, streamed multipart, verified download, conservative pruning and deletion journal', { timeout: 90000 }, async () => {
  const artifactToken = 'synthetic-backup-token-'.repeat(3)
  const { mf, close } = await startRuntime({
    prefix: 'mailhero-artifacts-',
    name: 'artifact-runtime',
    d1: null,
    entry: {
      sourcefile: 'artifact-runtime.ts',
      contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { handleBackupAPI } from './src/native/backup';
    import { recordDeletion } from './src/native/backup-artifacts';
    import { HttpError } from './src/native/security';
    export class TestStatus extends DurableObject {
      async fetch(request) {
        if(request.method==='POST') {await this.ctx.storage.put('status',await request.json());return new Response(null,{status:204})}
        return Response.json(await this.ctx.storage.get('status') || {state:'idle',paused:false});
      }
    }
    export default {async fetch(request,env) {
      try {
        const path=new URL(request.url).pathname;
        if(path==='/__test/status') return env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch(request);
        if(path==='/__test/deletion') {const x=await request.json();await recordDeletion(env,x.id,x.scope,x.deleted_at);return new Response(null,{status:204})}
        return await handleBackupAPI(request,env);
      } catch(error) {return Response.json({code:error instanceof HttpError?error.code:'internal'}, {status:error instanceof HttpError?error.status:503})}
    }};`,
    },
    r2Buckets: ['BACKUP_STORE'],
    durableObjects: { COORDINATOR: { className: 'TestStatus', useSQLite: true } },
    bindings: { BACKUP_TOKEN: artifactToken },
  })
  try {
    const bucket = await mf.getR2Bucket('BACKUP_STORE'), id = crypto.randomUUID(), manifest = 'b'.repeat(64)
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 123, 0x61), bytesHash = hash(bytes)
    const input = { backup_id: id, manifest_sha256: manifest, sha256: bytesHash, size_bytes: bytes.length }
    const route = '/api/internal/backup/artifacts/'
    async function api(path, method = 'GET', body, headers = {}) {
      return mf.dispatchFetch('http://localhost' + route + path, {
        method,
        headers: { Authorization: `Bearer ${artifactToken}`, ...headers },
        body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
      })
    }
    async function status(value) {
      const response = await mf.dispatchFetch('http://localhost/__test/status', { method: 'POST', body: JSON.stringify(value) })
      assert.equal(response.status, 204)
    }
    assert.equal((await api('list', 'GET', undefined, { Authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await api('begin', 'POST', input)).status, 409, 'no active ready lease')
    await status({ state: 'ready', paused: true, backup_id: id })
    assert.equal((await api('begin', 'POST', { ...input, size_bytes: 8 * 1024 ** 3 + 1 })).status, 400)
    assert.equal((await api('begin', 'POST', 'x'.repeat(65537))).status, 413)
    assert.equal((await api('begin', 'POST', '{')).status, 400)
    let response = await api('begin', 'POST', input); assert.equal(response.status, 201)
    const upload = await response.json(); assert.equal(upload.part_size, 16 * 1024 * 1024)
    response = await api('begin', 'POST', input); assert.equal(response.status, 200); assert.equal((await response.json()).upload_id, upload.upload_id)
    assert.equal((await api('begin', 'POST', { ...input, sha256: 'c'.repeat(64) })).status, 409)
    const query = new URLSearchParams({ key: upload.key, upload_id: upload.upload_id })
    assert.equal((await api(`part?${query}&part_number=0`, 'PUT', 'a', { 'Content-Length': '1' })).status, 400)
    assert.equal((await api(`part?${query}&part_number=1`, 'PUT', 'a', { 'Content-Length': '1' })).status, 400)
    assert.equal((await api('complete', 'POST', { key: upload.key, upload_id: upload.upload_id, parts: [null, null] })).status, 400)
    const parts = []
    for (let number = 1; number <= 2; number++) {
      const data = bytes.subarray((number - 1) * upload.part_size, number * upload.part_size)
      response = await api(`part?${query}&part_number=${number}`, 'PUT', data, { 'Content-Length': String(data.length) })
      assert.equal(response.status, 200, await response.clone().text()); parts.push(await response.json())
    }
    response = await api('complete', 'POST', { key: upload.key, upload_id: upload.upload_id, parts }); assert.equal(response.status, 200, await response.clone().text())
    response = await api('object?' + new URLSearchParams({ key: upload.key })); assert.equal(response.status, 200)
    const downloaded = new Uint8Array(await response.arrayBuffer())
    assert.equal(downloaded.byteLength, bytes.length); assert.equal(hash(downloaded), bytesHash)
    assert.equal(response.headers.get('x-content-sha256'), bytesHash); assert.equal(response.headers.get('cache-control'), 'no-store')
    response = await api('object?' + new URLSearchParams({ key: upload.key }), 'HEAD'); assert.equal(response.headers.get('content-length'), String(bytes.length)); assert.equal(await response.text(), '')
    assert.equal((await api('object?key=deletion-journal%2Fprivate.json')).status, 400)
    const deletionID = crypto.randomUUID()
    response = await mf.dispatchFetch('http://localhost/__test/deletion', { method: 'POST', body: JSON.stringify({ id: deletionID, scope: 'raw', deleted_at: '2026-09-26T12:00:00Z' }) }); assert.equal(response.status, 204)
    const journal = await (await api('deletions')).json(); assert.deepEqual(journal.items, [{ id: deletionID, scope: 'raw', deleted_at: '2026-09-26T12:00:00Z' }]); assert.equal(journal.complete, true)
    assert.equal((await api('prune', 'POST', { backup_id: id, manifest_sha256: manifest })).status, 409)
    // Unrecognized object metadata must never become automatic prune candidates.
    const unknown = `snapshots/2026-09-01/${crypto.randomUUID()}.tar.gz.gpg`
    await bucket.put(unknown, 'unknown', { customMetadata: { sha256: 'a'.repeat(64) } })
    const unverifiedID = crypto.randomUUID(), unverified = `snapshots/2026-09-01/${unverifiedID}.tar.gz.gpg`
    await bucket.put(unverified, 'unverified', { customMetadata: { backup_id: unverifiedID, sha256: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64) } })
    for (let i = 0; i < 3; i++) {
      const oldID = crypto.randomUUID(), oldKey = `snapshots/2026-09-01/${oldID}.tar.gz.gpg`, metadata = { backup_id: oldID, sha256: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64) }
      await bucket.put(oldKey, 'old', { customMetadata: metadata }); await bucket.put(`verified/${oldID}.json`, '{}', { customMetadata: { ...metadata, key: oldKey } })
    }
    await status({ state: 'remote_verified', paused: false, backup_id: id, manifest_sha256: manifest, remote_locator: upload.key })
    assert.equal((await api('prune', 'POST', { backup_id: id, manifest_sha256: 'c'.repeat(64) })).status, 409)
    response = await api('prune', 'POST', { backup_id: id, manifest_sha256: manifest }); assert.equal(response.status, 200)
    assert.ok((await response.json()).deleted >= 2); assert.ok(await bucket.get(upload.key)); assert.ok(await bucket.get(unknown)); assert.ok(await bucket.get(unverified))
    assert.ok(await bucket.get(`deletion-journal/${deletionID}/raw.json`))
  } finally {
    await close()
  }
})

test('real R2: verified native download, durable bounded rotation and abandoned-prefix cleanup', { timeout: 90000 }, async () => {
  const sha = 'a'.repeat(64), manifestHash = 'b'.repeat(64)
  const { mf, close } = await startRuntime({
    prefix: 'native-backup-artifacts-',
    name: 'native-artifacts',
    d1: null,
    entry: {
      sourcefile: 'native-artifacts-test.ts',
      external: [],
      contents: `
    import { reserveNativeBackup, writeNativeVerifiedMarker, pruneNativeBackupsStep, abandonNativeBackupStep } from './src/native/native-backup-artifacts';
    import { handleBackupArtifactAPI } from './src/native/backup-artifacts';
    export default { async fetch(request, env) {
      try {
        const action = new URL(request.url).pathname;
        if(action.startsWith('/api/')) return await handleBackupArtifactAPI(request, env);
        const input = await request.json();
        if(action === '/reserve') await reserveNativeBackup(env,input.id,input.date,input.bytes);
        if(action === '/mark') await writeNativeVerifiedMarker(env,input);
        if(action === '/prune') return Response.json(await pruneNativeBackupsStep(env,input.id,input.cursor));
        if(action === '/abandon') return Response.json({done:await abandonNativeBackupStep(env,input.id,input.date)});
        return new Response(null,{status:204});
      } catch(error) {return Response.json({error:'code' in error?error.code:error.message},{status:409})}
    }};`,
    },
    r2Buckets: ['BACKUP_STORE'],
  })
  try {
    const store = await mf.getR2Bucket('BACKUP_STORE')
    const invoke = (action, value) => mf.dispatchFetch(`http://localhost/${action}`, { method: 'POST', body: JSON.stringify(value) })
    const api = action => mf.dispatchFetch(`http://localhost/api/internal/backup/artifacts/${action}`)
    const now = new Date('2026-10-03T04:17:00Z')
    const backups = []
    for (const age of [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28, 120]) {
      const created = new Date(now.getTime() - age * 86400000).toISOString(), id = crypto.randomUUID()
      const objectKey = `snapshots-v2/${created.slice(0, 10)}/${id}/manifest.json`
      const marker = {
        version: 2, backup_id: id, key: objectKey, sha256: sha, manifest_sha256: manifestHash,
        created_at: created, verified_at: created, size_bytes: 2048, object_count: 1, proof: 'native_readback_verified',
      }
      await store.put(objectKey, 'synthetic snapshot', { customMetadata: { backup_id: id, sha256: sha, manifest_sha256: manifestHash } })
      assert.equal((await invoke('mark', marker)).status, 204)
      backups.push(marker)
    }
    const current = backups[0], oldest = backups.at(-1)
    const prefix = oldest.key.slice(0, -'manifest.json'.length)
    for (let index = 0; index < 121; index++) await store.put(`${prefix}objects/${index.toString(16).padStart(64, '0')}.bin`, 'ciphertext', {
      customMetadata: { backup_id: oldest.backup_id, sha256: sha },
    })
    const unknown = `snapshots-v2/2026-01-01/${crypto.randomUUID()}/manifest.json`
    await store.put(unknown, 'unverified snapshot')
    const journal = `deletion-journal/${crypto.randomUUID()}/content.json`
    await store.put(journal, '{"scope":"content"}')

    const listed = await (await api('list-v2')).json()
    assert.equal(listed.version, 2); assert.equal(listed.items.length, 12)
    assert.ok(listed.items.some(item => item.backup_id === current.backup_id))
    const response = await api(`list-v2-objects?backup_id=${oldest.backup_id}`)
    const inventory = await response.json()
    assert.equal(inventory.objects.length, 100); assert.equal(inventory.complete, false)
    assert.ok(inventory.objects.every(item => Object.keys(item.customMetadata).sort().join(',') === 'backup_id,sha256'))
    assert.equal((await api(`list-v2-objects?backup_id=${crypto.randomUUID()}`)).status, 409)
    assert.equal((await api('object?key=' + encodeURIComponent(current.key))).status, 200)
    assert.equal((await api('object?key=snapshots-v2%2F..%2Fsecret')).status, 409)
    assert.equal((await invoke('mark', { ...current, sha256: 'c'.repeat(64) })).status, 409)
    assert.equal((await invoke('abandon', { id: current.backup_id, date: current.created_at.slice(0, 10) })).status, 409)

    let state = await (await invoke('prune', { id: current.backup_id })).json()
    assert.equal(state.done, false)
    assert.ok(state.cursor.targets.some(target => target.id === oldest.backup_id))
    // The first call only plans. This lets the runner persist the deletion work before doing it.
    assert.ok(await store.head(oldest.key))
    const saved = structuredClone(state.cursor)
    state = await (await invoke('prune', { id: current.backup_id, cursor: saved })).json()
    state = await (await invoke('prune', { id: current.backup_id, cursor: saved })).json()
    let steps = 0
    while (!state.done) {
      assert.ok(++steps < 10)
      state = await (await invoke('prune', { id: current.backup_id, cursor: state.cursor })).json()
    }
    assert.equal((await store.list({ prefix })).objects.length, 0)
    assert.ok(await store.head(current.key)); assert.ok(await store.head(unknown)); assert.ok(await store.head(journal))
    assert.ok((await (await api('list-v2')).json()).items.length <= 11)

    const failed = crypto.randomUUID(), date = '2026-10-03', failedPrefix = `snapshots-v2/${date}/${failed}/`
    assert.equal((await invoke('reserve', { id: failed, date, bytes: 10000 })).status, 204)
    assert.equal((await invoke('reserve', { id: failed, date, bytes: 10000 })).status, 204)
    assert.equal((await invoke('reserve', { id: failed, date, bytes: 10001 })).status, 409)
    for (let index = 0; index < 101; index++) await store.put(`${failedPrefix}objects/${index.toString(16).padStart(64, '0')}.bin`, 'failed snapshot')
    assert.equal((await (await invoke('abandon', { id: failed, date })).json()).done, false)
    assert.ok(await store.head(`pending-v2/${failed}.json`))
    assert.equal((await (await invoke('abandon', { id: failed, date })).json()).done, true)
    assert.equal(await store.head(`pending-v2/${failed}.json`), null)
    assert.ok(await store.head(current.key)); assert.ok(await store.head(journal))
  } finally {
    await close()
  }
})
