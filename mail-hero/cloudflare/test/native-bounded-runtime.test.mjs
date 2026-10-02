import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'
import { canonicalJSON } from '../src/native/backup.ts'
import { lifecycleDueSQL, terminalAnchorSQL } from '../src/native/lifecycle.ts'

// Production runs on Workers Free: D1 and DO SQLite each allow 5M rows read
// per day. These tests measure real workerd rows_read, not a JS model.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const token = 'synthetic-backup-machine-token-32-characters'
const uuid = `lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))`
let bundled
async function script() {
  bundled ??= (await build({ stdin: { contents: `
    import app from './src/native/index';
    import { emailHandler } from './src/native/ingest';
    import { runMaintenance } from './src/native/pipeline';
    import { MailCoordinator } from './src/native/coordinator';
    // Meters every D1 call. first() goes through all() because D1's first()
    // does not return meta.rows_read.
    function meter(db, stats) {
      const wrap = statement => ({ statement,
        bind: (...values) => wrap(statement.bind(...values)),
        async all() { const result = await statement.all(); stats.rows_read += result.meta.rows_read; stats.queries++; return result },
        async run() { const result = await statement.run(); stats.rows_read += result.meta.rows_read; stats.queries++; return result },
        async first(column) { const row = (await this.all()).results[0] ?? null; return column ? row?.[column] ?? null : row },
        raw() { throw new Error('unmetered_raw') } })
      return { prepare: sql => wrap(db.prepare(sql)), exec() { throw new Error('unmetered_exec') },
        async batch(statements) {
          const results = await db.batch(statements.map(item => item.statement))
          for (const result of results) stats.rows_read += result.meta.rows_read
          stats.queries += statements.length; return results
        } }
    }
    const override = (target, values) => new Proxy(target, { get(object, property) {
      if (Object.hasOwn(values, property)) return values[property]
      const value = object[property]; return typeof value === 'function' ? value.bind(object) : value } })
    // The real coordinator, with its SQL cursors and its D1 calls metered.
    export class ProbeCoordinator extends MailCoordinator {
      constructor(state, env) {
        const cursors = [], stats = { rows_read: 0, queries: 0 }
        const exec = (...args) => { const cursor = state.storage.sql.exec(...args); cursors.push(cursor); return cursor }
        super(override(state, { storage: override(state.storage, { sql: override(state.storage.sql, { exec }) }) }), { ...env, DB: meter(env.DB, stats) })
        this.cursors = cursors; this.stats = stats; this.sql = state.storage.sql
      }
      take() {
        const value = { do_rows_read: this.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0), d1_rows_read: this.stats.rows_read, d1_queries: this.stats.queries }
        this.cursors.length = 0; this.stats.rows_read = 0; this.stats.queries = 0; return value
      }
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (!path.startsWith('/__probe/')) return super.fetch(request)
        const input = request.method === 'POST' ? await request.json() : {}
        if (path === '/__probe/stats') return Response.json(this.take())
        if (path === '/__probe/snapshot') { this.take(); const snapshot = this.capacity.snapshot(); return Response.json({ ...this.take(), snapshot }) }
        if (path === '/__probe/reconcile') { this.take(); const result = await this.capacity.reconcileAbandoned(); return Response.json({ ...this.take(), result }) }
        if (path === '/__probe/reserve') {
          await this.capacity.initialize()
          this.state.storage.transactionSync(() => { for (let i = 0; i < input.count; i++) assert(this.capacity.reserve(input.prefix + i + input.suffix, input.bytes)) })
          if (input.old) this.sql.exec('UPDATE capacity_allocations SET created=0 WHERE key LIKE ?', input.prefix + '%')
          return Response.json(this.sql.exec('SELECT (SELECT allocated FROM capacity_totals) allocated,(SELECT sum(bytes) FROM capacity_allocations WHERE released=0) recount').one())
        }
        if (path === '/__probe/capacity-reconcile') return super.fetch(new Request('https://coordinator/capacity/reconcile', { method: 'POST', body: '{}' }))
        if (path === '/__probe/sql') return Response.json(this.sql.exec(input.sql, ...(input.values ?? [])).toArray())
        return new Response(null, { status: 404 })
      }
    }
    function assert(value) { if (!value) throw new Error('probe_assertion') }
    const coordinator = env => env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1'))
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/__probe/')) return coordinator(env).fetch(new Request('https://coordinator' + url.pathname, request))
      if (url.pathname === '/__test/email') {
        await emailHandler({ from: 'sender@example.org', to: env.RECEIVE_ADDRESS, raw: request.body, rawSize: Number(request.headers.get('x-raw-size')),
          setReject() { throw new Error('unexpected_reject') } }, env, ctx)
        return new Response(null, { status: 204 })
      }
      const stats = { rows_read: 0, queries: 0 }, metered = { ...env, DB: meter(env.DB, stats) }
      if (url.pathname === '/__test/maintenance') { const result = await runMaintenance(metered); return Response.json({ ...stats, jobs: result.jobs.length }) }
      if (url.pathname === '/__test/overview') {
        const response = await app.fetch(new Request('http://localhost/api/v2/overview'), metered, ctx)
        return Response.json({ ...stats, status: response.status, body: await response.json() })
      }
      return app.fetch(request, env, ctx)
    }};`, resolveDir: root, sourcefile: 'native-bounded-entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  return bundled
}
async function runtime(t, bindings = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-bounded-'))
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'mail-hero-bounded-test', modules: true, script: await script(),
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'bounded-test' }, d1Persist: join(temp, 'd1'), r2Buckets: ['MAIL_STORE'], r2Persist: join(temp, 'r2'),
    durableObjects: { COORDINATOR: { className: 'ProbeCoordinator', useSQLite: true } }, durableObjectsPersist: join(temp, 'do'),
    bindings: { RECEIVE_ADDRESS: 'inbox@mail.example.org', DEV_AUTH_BYPASS: 'true', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'synthetic', ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
      FORCE_SEND_PAUSED: 'true', MAINTENANCE_MODE: 'false', ...bindings },
    serviceBindings: { ASSETS: () => new Response('synthetic') },
    outboundService: () => { throw new Error('no outbound request is expected') } }))
  t.after(async () => { await mf.dispose(); await rm(temp, { recursive: true, force: true }) })
  await mf.ready
  const db = await mf.getD1Database('DB')
  for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)))
  }
  const call = async (path, input, headers = {}) => {
    const response = await mf.dispatchFetch('http://localhost' + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: input === undefined ? undefined : JSON.stringify(input) })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text
  }
  const json = async (path, input, headers) => JSON.parse(await call(path, input, headers))
  return { mf, db, call, json }
}
async function forwardTarget(db) {
  const endpoint = crypto.randomUUID(), revision = crypto.randomUUID(), date = new Date().toISOString()
  await db.batch([
    db.prepare("INSERT INTO webhook_endpoints(id,label,current_revision_id,created_at,updated_at) VALUES(?,'Synthetic',?,?,?)").bind(endpoint, revision, date, date),
    db.prepare("INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at) VALUES(?,?,1,'https://consumer.example.org/hook','bearer','synthetic-not-decrypted',?)").bind(revision, endpoint, date),
    db.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=? WHERE id=1").bind(endpoint),
  ])
  return revision
}

test('workerd rows read per maintenance cycle and overview stay bounded as stored mail grows', { timeout: 180000 }, async t => {
  const { db, json } = await runtime(t)
  const revision = await forwardTarget(db)
  const day = 86400000, ago = ms => new Date(Date.now() - ms).toISOString()
  // Live forward mail that was delivered and clocked, and deleted tombstones:
  // the history that previously made every periodic query grow.
  async function history(count) {
    await db.batch([
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,endpoint_revision_id,parse_state,parsed_key,content_bytes,
          retention_policy_version,raw_retention_days,content_retention_days,ledger_retention_days,retention_started_at)
        SELECT id,?,?,'seed-live@example.org','inbox@mail.example.org','raw/'||id||'.eml',100,'forward',?,'ready','parsed/'||id||'/seed/message.json',300,1,7,30,180,?
        FROM (SELECT ${uuid} id FROM n)`).bind(count, ago(2 * day), ago(2 * day), revision, ago(day)),
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,endpoint_revision_id,parse_state,content_bytes,
          retention_policy_version,raw_retention_days,content_retention_days,ledger_retention_days,retention_started_at,raw_expired_at,raw_purged_at,content_deleted_at)
        SELECT id,?,?,'seed-tombstone@example.org','inbox@mail.example.org',100,'forward',?,'ready',0,1,7,30,180,?,?,?,?
        FROM (SELECT ${uuid} id FROM n)`).bind(count, ago(60 * day), ago(60 * day), revision, ago(59 * day), ago(52 * day), ago(52 * day), ago(29 * day)),
      db.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,payload_size_bytes,state,next_attempt_at,created_at,delivered_at,attempt_count)
        SELECT e,id,?,1,CASE WHEN content_deleted_at IS NULL THEN 'payload/'||e||'.json' END,'synthetic-hash',CASE WHEN content_deleted_at IS NULL THEN 50 ELSE 0 END,'delivered',received_at,received_at,retention_started_at,1
        FROM (SELECT ${uuid} e,id,content_deleted_at,received_at,retention_started_at FROM messages m
          WHERE m.envelope_from LIKE 'seed-%' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id))`).bind(revision),
      // Steady state: the code has already healed these due times.
      db.prepare(`UPDATE messages AS m SET lifecycle_due_at=${lifecycleDueSQL('m', terminalAnchorSQL('m'))}
        WHERE m.retention_started_at IS NOT NULL AND m.content_deleted_at IS NULL AND m.lifecycle_due_at IS NULL`),
    ])
  }
  // A fixed unsettled set: stopped deliveries, parse failures, backlog and policy errors.
  const unsettled = [
    ["'forward'", "'ready'", 'NULL', 5, 'failed'], ["'archive'", "'failed'", 'NULL', 3, null], ["'archive'", "'pending'", 'NULL', 2, null],
    ["'forward'", "'ready'", 'NULL', 2, null], ["'archive'", "'ready'", "'policy_unavailable'", 1, null], ["'forward'", "'ready'", 'NULL', 2, 'retry_wait'],
  ]
  for (const [mode, parse, policyError, count, state] of unsettled) {
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,endpoint_revision_id,parse_state,policy_error,content_bytes,retention_policy_version,raw_retention_days,content_retention_days,ledger_retention_days)
      SELECT id,?,?,'unsettled@example.org','inbox@mail.example.org','raw/'||id||'.eml',100,${mode},CASE WHEN ${mode}='forward' THEN ? END,${parse},${policyError},100,1,7,30,180 FROM (SELECT ${uuid} id FROM n)`)
      .bind(count, ago(3 * day), ago(3 * day), revision).run()
    if (state) await db.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,payload_size_bytes,state,next_attempt_at,created_at,attempt_count)
      SELECT e,id,?,1,'payload/'||e||'.json','synthetic-hash',50,?,?,received_at,3 FROM (SELECT ${uuid} e,id,received_at FROM messages m
        WHERE m.envelope_from='unsettled@example.org' AND m.receive_mode='forward' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id) LIMIT ?)`)
      .bind(revision, state, ago(-day), count).run()
  }
  // Lifecycle work that happens once, in workerd: a heal and a content purge,
  // a heal and a raw expiry, and safe archived mail whose clocks start.
  const due = []
  for (const [started, count] of [[ago(40 * day), 1], [ago(10 * day), 1], [null, 3]]) {
    const rows = await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,parse_state,parsed_key,content_bytes,
        retention_policy_version,raw_retention_days,content_retention_days,ledger_retention_days,retention_started_at)
      SELECT id,?,?,'lifecycle@example.org','inbox@mail.example.org','raw/'||id||'.eml',100,'archive','ready','parsed/'||id||'/seed/message.json',300,1,7,30,180,?
      FROM (SELECT ${uuid} id FROM n) RETURNING id`).bind(count, ago(45 * day), ago(45 * day), started).all()
    due.push(rows.results.map(row => row.id))
  }
  async function measure() {
    const cycles = []
    for (let cycle = 0; cycle < 2; cycle++) {
      let d1 = 0, dos = 0, queries = 0
      for (const phase of ['repair', 'lifecycle', 'alerts']) {
        const result = await json('/__test/maintenance')
        const probe = await json('/__probe/stats')
        assert.ok(result.queries + probe.d1_queries <= 40, `${phase} used ${result.queries}+${probe.d1_queries} D1 queries`)
        d1 += result.rows_read + probe.d1_rows_read; dos += probe.do_rows_read; queries += result.queries + probe.d1_queries
      }
      cycles.push({ d1, dos, queries })
    }
    const overview = await json('/__test/overview'), probe = await json('/__probe/stats')
    assert.equal(overview.status, 200)
    return { cycle: cycles.at(-1), first: cycles[0], overview: overview.rows_read + probe.d1_rows_read, overviewDO: probe.do_rows_read, counts: { messages: overview.body.message_count ?? 0, delivered: overview.body.delivered_count ?? 0, failed: overview.body.failed_delivery_count ?? 0,
      pending: overview.body.pending_delivery_count ?? 0, parse_failed: overview.body.parse_failed_count ?? 0 },
      alerts: (overview.body.active_alerts ?? []).map(alert => alert.code).sort() }
  }
  await history(300)
  const small = await measure()
  const lifecycle = id => db.prepare('SELECT retention_started_at,lifecycle_due_at,raw_purged_at,content_deleted_at FROM messages WHERE id=?').bind(id).first()
  assert.ok((await lifecycle(due[0][0])).content_deleted_at, 'content stage purged')
  const raw = await lifecycle(due[1][0])
  assert.ok(raw.raw_purged_at); assert.equal(raw.content_deleted_at, null)
  assert.equal(raw.lifecycle_due_at, new Date(Date.parse(raw.retention_started_at) + 30 * day).toISOString())
  for (const id of due[2]) {
    const clocked = await lifecycle(id)
    assert.equal(clocked.lifecycle_due_at, new Date(Date.parse(clocked.retention_started_at) + 7 * day).toISOString(), 'numbered parameters in workerd')
  }
  await history(2700)
  const large = await measure()
  assert.equal((await db.prepare("SELECT count(*) n FROM messages WHERE content_deleted_at IS NULL AND envelope_from='seed-live@example.org'").first()).n, 3000)
  assert.equal(large.counts.messages, 6020); assert.equal(large.counts.delivered, 6000); assert.equal(large.counts.failed, 5); assert.equal(large.counts.pending, 2)
  assert.equal(large.counts.parse_failed, 3)
  assert.deepEqual(large.alerts, ['delivery_failed', 'parse_failed', 'pending_stale', 'policy_error'])
  const report = JSON.stringify({ small, large })
  t.diagnostic(report)
  for (const value of [small, large]) {
    assert.ok(value.first.d1 < 2000 && value.cycle.d1 < 2000, `D1 rows per cycle ${report}`)
    assert.ok(value.overview < 2000, `D1 rows per overview ${report}`)
    assert.ok(value.first.dos < 200 && value.cycle.dos < 200 && value.overviewDO < 200, `DO rows ${report}`)
  }
  assert.ok(large.cycle.d1 < small.cycle.d1 * 1.2, `ten times the history adds <20% ${report}`)
  assert.ok(large.overview < small.overview * 1.2, `overview ${report}`)
  assert.ok(large.cycle.dos <= small.cycle.dos * 1.2 + 5, `DO ${report}`)
})

test('workerd counter triggers keep changes() chaining exact in the registerRaw and createDelivery batches', { timeout: 90000 }, async t => {
  const { mf, db } = await runtime(t)
  await forwardTarget(db)
  // changes() after a statement whose trigger also wrote is still that
  // statement's own count; the batches below chain on exactly this value.
  const probe = crypto.randomUUID()
  const direct = await db.batch([
    db.prepare("INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode) VALUES(?,'2026-01-01','2026-01-01','a@example.org','b@example.org',1,'archive')").bind(probe),
    db.prepare('SELECT changes() n'),
    db.prepare('DELETE FROM messages WHERE id=?').bind(probe),
  ])
  assert.equal(direct[1].results[0].n, 1)
  // Local workerd reports meta.changes as a total_changes() delta, which does
  // include trigger writes; the Worker only ever tests meta.changes for zero.
  t.diagnostic(`INSERT meta.changes with trigger: ${direct[0].meta.changes}`)
  assert.ok(direct[0].meta.changes >= 1)
  const state = () => db.prepare(`SELECT (SELECT logical_bytes FROM app_settings) logical,
    (SELECT COALESCE(sum(content_bytes),0) FROM messages)+(SELECT COALESCE(sum(payload_size_bytes),0) FROM deliveries) ledger,
    (SELECT count(*) FROM messages) messages,(SELECT count(*) FROM deliveries) deliveries,(SELECT count(*) FROM ingest_receipts) receipts,
    (SELECT max(arrival_count) FROM messages) arrivals,(SELECT messages FROM app_counters) counted,(SELECT deliveries_pending FROM app_counters) pending`).first()
  async function receive(subject, receipts, messages) {
    const body = ['From: Synthetic Sender <sender@example.org>', 'To: inbox@mail.example.org', `Subject: ${subject}`,
      'Content-Type: text/plain; charset=UTF-8', '', `Synthetic trigger fixture ${subject}.`, ''].join('\r\n')
    const response = await mf.dispatchFetch('http://localhost/__test/email', { method: 'POST', headers: { 'x-raw-size': String(Buffer.byteLength(body)) }, body })
    assert.equal(response.status, 204, await response.text())
    let value
    for (const until = Date.now() + 20000; Date.now() < until; await delay(100)) {
      value = await state()
      if (value.receipts === receipts && value.messages === messages && value.deliveries === messages) return value
    }
    assert.fail(`mail not processed: ${JSON.stringify(value)}`)
  }
  const first = await receive('one', 1, 1)
  assert.ok(first.logical > 0); assert.equal(first.logical, first.ledger, 'registerRaw and createDelivery each added their bytes once')
  assert.equal(first.counted, 1); assert.equal(first.pending, 1)
  // Identical bytes and envelope: the INSERT is a no-op, so nothing chained on it runs.
  const duplicate = await receive('one', 2, 1)
  assert.equal(duplicate.logical, first.logical); assert.equal(duplicate.arrivals, 2); assert.equal(duplicate.counted, 1)
  // With no counter row the trigger UPDATE matches nothing; the chained
  // logical_bytes UPDATEs must still see the INSERT's own change.
  await db.prepare('DELETE FROM app_counters').run()
  const third = await receive('two', 3, 2)
  assert.ok(third.logical > first.logical); assert.equal(third.logical, third.ledger); assert.equal(third.counted, null)
})

test('workerd DO capacity snapshot reads O(1) rows and reconcile never walks raw allocations', { timeout: 90000 }, async t => {
  const { mf, json } = await runtime(t)
  const small = await json('/__probe/reserve', { prefix: 'payload/small-', suffix: '.json', count: 1, bytes: 10 })
  assert.equal(small.allocated, small.recount)
  const before = await json('/__probe/snapshot')
  assert.ok(before.do_rows_read <= 2, JSON.stringify(before))
  const raw = await json('/__probe/reserve', { prefix: 'raw/', suffix: '.eml', count: 1500, bytes: 1000 })
  const payload = await json('/__probe/reserve', { prefix: 'payload/old-', suffix: '.json', count: 300, bytes: 20, old: true })
  assert.equal(raw.allocated, raw.recount); assert.equal(payload.allocated, payload.recount)
  const after = await json('/__probe/snapshot')
  assert.ok(after.do_rows_read <= 2, JSON.stringify(after))
  assert.equal(after.snapshot.reserved_bytes, payload.recount)
  // The previous release inserts the control row positionally; a code rollback must still construct.
  await json('/__probe/sql', { sql: 'INSERT OR IGNORE INTO capacity_control VALUES(1,0,?,0)', values: [5 * 1024 ** 3] })
  const reconcile = await json('/__probe/reconcile')
  assert.equal(reconcile.result.checked, 4)
  assert.ok(reconcile.do_rows_read < 50, `raw allocations are never scanned: ${JSON.stringify(reconcile)}`)
  // The repair pass's reconcile request also reads backup status. A completed
  // snapshot keeps its cut, which must not make it count all intake history.
  await json('/__probe/sql', { sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
    INSERT INTO ingest_uploads(key,seq,status,policy,created,settled) SELECT 'raw/history-'||i||'.eml',i,'saved','{}',0,0 FROM n` })
  await json('/__probe/sql', { sql: 'INSERT INTO backup_control VALUES(1,?)', values: [JSON.stringify({ id: 'synthetic', state: 'remote_verified', created_at: new Date().toISOString(), expires_at: 0, cut_seq: 2000, cut_at: new Date().toISOString(), policy: null, objects_done: true, object_cursor: null })] })
  await json('/__probe/stats')
  const response = await mf.dispatchFetch('http://localhost/__probe/capacity-reconcile')
  assert.equal(response.status, 200)
  const repair = await json('/__probe/stats')
  assert.ok(repair.do_rows_read < 50, `reconcile with a completed snapshot: ${JSON.stringify(repair)}`)
})

test('workerd backup database export pages by rowid keyset, byte-identical to OFFSET pages', { timeout: 90000 }, async t => {
  const { db, call, json } = await runtime(t, { BACKUP_TOKEN: token })
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<260)
    INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,subject)
    SELECT ${uuid},'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','sender@example.org','inbox@mail.example.org',i,'archive','合成 '||i FROM n`).run()
  await db.prepare("DELETE FROM messages WHERE rowid IN(SELECT rowid FROM messages ORDER BY rowid LIMIT 3 OFFSET 50)").run()
  // Settled intake history the control export must not walk, and one upload a parse job still holds.
  await json('/__probe/sql', { sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
    INSERT INTO ingest_uploads(key,seq,status,policy,created,settled) SELECT 'raw/history-'||i||'.eml',i,'saved','{}',0,0 FROM n` })
  await json('/__probe/sql', { sql: 'UPDATE intake_control SET value=2000' })
  await json('/__probe/sql', { sql: 'INSERT INTO jobs(id,payload,due,created) VALUES(?,?,?,0)', values: ['parse:raw/history-7.eml', JSON.stringify({ type: 'parse', key: 'raw/history-7.eml' }), Date.now() + 86400000] })
  const auth = { Authorization: 'Bearer ' + token }, base = '/api/internal/backup'
  const begun = await json(base + '/begin', { lease_seconds: 300 }, auth)
  assert.equal(begun.state, 'ready')
  const q = '?backup_id=' + begun.backup_id
  await json('/__probe/stats')
  const control = await json(base + '/control' + q, undefined, auth), controlStats = await json('/__probe/stats')
  assert.deepEqual(control.uploads.map(row => row.key), ['raw/history-7.eml'])
  assert.ok(controlStats.do_rows_read < 100, `control export read ${JSON.stringify(controlStats)}`)
  await call(base + '/database-schema' + q, undefined, auth)
  await json('/__probe/stats')
  const page = offset => call(`${base}/database${q}&table=messages&offset=${offset}`, undefined, auth)
  const pages = []
  for (let offset = 0; offset !== null;) {
    const text = await page(offset), stats = await json('/__probe/stats')
    // The former implementation, run directly for comparison.
    const old = await db.prepare('SELECT * FROM "messages" ORDER BY rowid LIMIT ? OFFSET ?').bind(100, offset).all()
    assert.equal(text, canonicalJSON({ table: 'messages', offset, rows: old.results, next_offset: old.results.length === 100 ? offset + 100 : null }), `page ${offset}`)
    assert.equal(stats.d1_queries, 1)
    assert.ok(stats.d1_rows_read <= 101, `page ${offset} read ${stats.d1_rows_read} rows`)
    pages.push({ offset, text, old: old.meta.rows_read })
    offset = JSON.parse(text).next_offset
  }
  assert.deepEqual(pages.map(item => item.offset), [0, 100, 200])
  assert.ok(pages[2].old >= 250, 'OFFSET re-reads every skipped row')
  assert.equal(await page(200), pages[2].text, 'a lost page response can be requested again')
  // A previous page exported before this change has no cursor: OFFSET continues it.
  await json('/__probe/sql', { sql: 'DELETE FROM backup_table_cursors WHERE name=?', values: ['database/messages/100.json'] })
  assert.equal(await page(200), pages[2].text)
  await json(base + '/cancel', { backup_id: begun.backup_id }, auth)
  await json(base + '/begin', {}, auth)
  assert.deepEqual(await json('/__probe/sql', { sql: 'SELECT count(*) n FROM backup_table_cursors' }), [{ n: 0 }])
})
