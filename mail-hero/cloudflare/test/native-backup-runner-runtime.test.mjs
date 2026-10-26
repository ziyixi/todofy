import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrationStatements } from './migrations.mjs';
import { canonicalJSON } from '../src/native/backup.ts';
import { nextNativeBackupAt } from '../src/native/native-backup-runner.ts';
import { injectedVars } from '../../deploy/deploy-vars.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('daily UTC schedule rolls forward without a timer or local-time dependence', () => {
  assert.equal(new Date(nextNativeBackupAt(Date.parse('2026-10-03T04:16:59Z'))).toISOString(), '2026-10-03T04:17:00.000Z');
  assert.equal(new Date(nextNativeBackupAt(Date.parse('2026-10-03T04:17:00Z'))).toISOString(), '2026-10-04T04:17:00.000Z');
  assert.throws(() => nextNativeBackupAt(Date.now(), '25:00'), /schedule_invalid/);
});

// The tests drive the Alarm themselves through /test/tick, one step at a time. The coordinator re-arms its Alarm about
// a second after each tick, and a real Alarm firing between two of a test's steps would run the runner on its own (on
// a slow runner it once wrote the marker between a fault injection and the check that it had not). So the test object
// records each setAlarm (counted, and answered by getAlarm) without arming it, and only /test/tick runs the Alarm.
// `platformAlarms` arms real Alarms instead, for the test of the platform Alarm alone, which then cannot tick by hand.
async function harness(extra = {}, { platformAlarms = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'mailhero-native-runner-'));
  const bundled = await build({ stdin: { contents: `
    import { MailCoordinator } from './src/native/coordinator';
    const PLATFORM_ALARMS=${platformAlarms ? 'true' : 'false'};
    export class TestCoordinator extends MailCoordinator {
      constructor(state,env) {
        const faults={value:null};
        const metrics={rows_read:0,rows_written:0,alarm_writes:0,sql_calls:0,queries:{},d1_reads:0,d1_writes:0,d1_calls:0,r2_calls:0,max_alarm_d1_calls:0,max_alarm_r2_calls:0};
        const trackedSQL={exec(sql,...bindings) {
          const cursor=state.storage.sql.exec(sql,...bindings),label=sql.replace(/\\s+/g,' ').slice(0,110);
          metrics.sql_calls++;const query=metrics.queries[label] ??= {calls:0,reads:0,writes:0};query.calls++;
          let read=0,written=0;
          const record=()=>{
            const r=cursor.rowsRead,w=cursor.rowsWritten;
            metrics.rows_read+=r-read;metrics.rows_written+=w-written;query.reads+=r-read;query.writes+=w-written;read=r;written=w;
          };
          record();
          return new Proxy(cursor,{get(target,name) {
            if(name==='toArray'||name==='one')return(...args)=>{try{return target[name](...args)}finally{record()}};
            if(name===Symbol.iterator)return function*(){try{yield* target}finally{record()}};
            const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
          }});
        }};
        const alarm={at:null};
        const trackedStorage=new Proxy(state.storage,{get(target,name){
          if(name==='sql')return trackedSQL;
          if(name==='setAlarm')return async(time,...args)=>{metrics.alarm_writes++;if(PLATFORM_ALARMS)return target.setAlarm(time,...args);alarm.at=Number(time)};
          if(name==='getAlarm' && !PLATFORM_ALARMS)return async()=>alarm.at;
          if(name==='deleteAlarm' && !PLATFORM_ALARMS)return async()=>{alarm.at=null};
          const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
        }});
        const trackedState=new Proxy(state,{get(target,name){if(name==='storage')return trackedStorage;const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
        const bucket=new Proxy(env.BACKUP_STORE,{get(target,name) {
          if(name==='put')return async(key,...args)=>{
            metrics.r2_calls++;
            if(faults.value==='marker' && key.startsWith('verified-v2/')) {faults.value=null;throw new Error('synthetic_marker_failure')}
            return target.put(key,...args);
          };
          if(name==='get')return async(key,...args)=>{
            metrics.r2_calls++;
            if(faults.value==='journal:'+key) {faults.value=null;throw new Error('synthetic_journal_unavailable')}
            const value=await target.get(key,...args);
            if(faults.value==='readback' && key.startsWith('snapshots-v2/')) {faults.value=null;return null}
            if(faults.value==='corrupt_readback' && value && key.startsWith('snapshots-v2/')) {
              faults.value=null;await value.body.cancel();return {size:value.size,body:new Blob([new Uint8Array(value.size)]).stream()};
            }
            return value;
          };
          return typeof target[name]==='function'?(...args)=>{metrics.r2_calls++;return target[name](...args)}:target[name];
        }});
        const mainBucket=new Proxy(env.MAIL_STORE,{get(target,name){
          if(name==='get')return async(key,...args)=>{
            metrics.r2_calls++;
            if(faults.value==='source:'+key) {faults.value=null;throw new Error('synthetic_source_unavailable')}
            return target.get(key,...args);
          };
          return typeof target[name]==='function'?(...args)=>{metrics.r2_calls++;return target[name](...args)}:target[name];
        }});
        const statementProxy=(statement,sql)=>new Proxy(statement,{get(query,method) {
          if(method==='bind')return(...args)=>statementProxy(query.bind(...args),sql);
          if(['all','run','first'].includes(method))return async(...args)=>{
            if(method==='first' && sql.includes('SELECT s.*') && faults.value==='policy_read') {faults.value=null;throw new Error('synthetic_database_unavailable')}
            const result=await query[method==='first'?'all':method](...(method==='first'?[]:args));
            metrics.d1_calls++;metrics.d1_reads+=result.meta?.rows_read??0;metrics.d1_writes+=result.meta?.rows_written??0;
            return method==='first'?(result.results[0]===undefined?null:args.length?result.results[0][args[0]]:result.results[0]):result;
          };
          return typeof query[method]==='function'?query[method].bind(query):query[method];
        }});
        const database=new Proxy(env.DB,{get(target,name) {
          if(name==='prepare')return(sql)=>statementProxy(target.prepare(sql),sql);
          return typeof target[name]==='function'?target[name].bind(target):target[name];
        }});
        super(trackedState,{...env,DB:database,MAIL_STORE:mainBucket,BACKUP_STORE:bucket});this.testState=state;this.faults=faults;this.metrics=metrics;
        const finalize=this.backup.finalizeNativeMarker.bind(this.backup);
        this.backup.finalizeNativeMarker=async(id)=>{
          await finalize(id);
          if(this.faults.value==='completion_race') {
            this.faults.value=null;
            const response=await super.fetch(new Request('https://coordinator/backup/begin',{method:'POST',body:JSON.stringify({lease_seconds:300})}));
            await state.storage.put('test_completion_race_status',response.status);
            throw new Error('synthetic_crash_after_finalize');
          }
        };
      }
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if(path==='/test/tick') {
          if(PLATFORM_ALARMS)return new Response('a manual tick would race the platform Alarm',{status:409});
          const value=this.testState.storage.sql.exec('SELECT value FROM native_backup_control WHERE id=1').toArray()[0];
          if(value) {const run=JSON.parse(value.value);run.next_at=Date.now();this.testState.storage.sql.exec('UPDATE native_backup_control SET value=? WHERE id=1',JSON.stringify(run));}
          const d1=this.metrics.d1_calls,r2=this.metrics.r2_calls;await this.alarm();
          this.metrics.max_alarm_d1_calls=Math.max(this.metrics.max_alarm_d1_calls,this.metrics.d1_calls-d1);
          this.metrics.max_alarm_r2_calls=Math.max(this.metrics.max_alarm_r2_calls,this.metrics.r2_calls-r2);
          return super.fetch(new Request('https://coordinator/backup/status'));
        }
        if(path==='/test/fault') {this.faults.value=await request.text();return new Response(null,{status:204})}
        if(path==='/test/metrics')return Response.json(this.metrics);
        if(path==='/test/lose-begin-checkpoint') {
          const row=this.testState.storage.sql.exec('SELECT value FROM native_backup_control WHERE id=1').one();
          const run=JSON.parse(row.value);run.phase='begin';delete run.id;delete run.prefix;delete run.date;delete run.started_at;
          this.testState.storage.sql.exec('UPDATE native_backup_control SET value=? WHERE id=1',JSON.stringify(run));
          return new Response(null,{status:204});
        }
        if(path==='/test/race') return Response.json({status:await this.testState.storage.get('test_completion_race_status')});
        if(path==='/test/expire') {
          const value=JSON.parse(this.testState.storage.sql.exec('SELECT value FROM backup_control WHERE id=1').one().value);
          value.expires_at=Date.now()-1;this.testState.storage.sql.exec('UPDATE backup_control SET value=? WHERE id=1',JSON.stringify(value));
          return new Response(null,{status:204});
        }
        return super.fetch(request);
      }
    }
    export default {fetch(request,env) {return env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch(request)}};
  `, resolveDir: root, sourcefile: 'native-runner-test.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', conditions: ['browser'], external: ['cloudflare:workers'], write: false });
  const options = { name: 'native-backup-runner-test', modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    resourcePersistencePath: join(temporary, 'resources'),
    d1Databases: { DB: 'native-backup-runner-db' }, d1Persist: join(temporary, 'd1'),
    r2Buckets: ['MAIL_STORE', 'BACKUP_STORE'], r2Persist: join(temporary, 'r2'),
    durableObjects: { COORDINATOR: { className: 'TestCoordinator', useSQLite: true } }, durableObjectsPersist: join(temporary, 'do'),
    bindings: { RECEIVE_ADDRESS: 'inbox@example.invalid', ACCESS_OWNER: 'owner@example.invalid', ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'synthetic', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.invalid', FORCE_SEND_PAUSED: 'true',
      NATIVE_BACKUP_ENABLED: 'true', NATIVE_BACKUP_AT_UTC: '04:17', ...extra },
    outboundService() { throw new Error('native backup must not contact any external service'); } };
  let mf;
  async function start() { mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; }
  await start();
  let db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)));
  }
  async function call(path, body) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    assert.ok(response.ok, `synthetic route ${path}: ${response.status} ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  }
  return { call, raw: (path, body) => mf.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    get db() { return db; }, bucket: name => mf.getR2Bucket(name),
    async restart(bindings = {}) { await mf.dispose(); Object.assign(options.bindings, bindings); await start(); db = await mf.getD1Database('DB'); },
    async close() { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); } };
}

async function seed(h, { missingAttachment = false, large = false, rawSize } = {}) {
  const bucket = await h.bucket('MAIL_STORE'), id = crypto.randomUUID(), now = new Date().toISOString();
  const rawKey = `raw/${id}.eml`, parsedKey = `parsed/${id}/fixture/message.json`, attachmentKey = `parsed/${id}/fixture/attachment-1`;
  const raw = Buffer.alloc(rawSize ?? (large ? 2 * 1024 * 1024 + 123 : 127), 0x61), attachment = Buffer.from('synthetic attachment');
  const parsed = Buffer.from(JSON.stringify({ subject: 'synthetic fixture', text: 'never production mail', html: '', headers: [],
    attachments: [{ part_id: '1', filename: 'fixture.txt', size: attachment.length, r2_key: attachmentKey, storage_status: 'stored' },
      { part_id: '2', filename: 'omitted.txt', size: 3, storage_status: 'omitted', omitted_reason: 'size_limit' }] }));
  await bucket.put(rawKey, raw, { customMetadata: { raw_size: String(raw.length), mode: 'archive' }, httpMetadata: { contentType: 'message/rfc822' } });
  await bucket.put(parsedKey, parsed, { httpMetadata: { contentType: 'application/json' } });
  if (!missingAttachment) await bucket.put(attachmentKey, attachment);
  await h.db.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,raw_sha256,size_bytes,receive_mode,
    parse_state,parsed_key,parsed_size_bytes,content_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, now, now, 'synthetic@example.invalid',
      'inbox@example.invalid', rawKey, hash(raw), raw.length, 'archive', 'ready', parsedKey, parsed.length, raw.length + parsed.length + attachment.length).run();
  const endpoint = crypto.randomUUID(), revision = crypto.randomUUID(), eventID = crypto.randomUUID(), payloadKey = `payload/${eventID}.json`;
  const payload = Buffer.from(canonicalJSON({ type: 'mail.received.v1', event_id: eventID, received_at: now,
    message: { id, subject: 'synthetic fixture', text: 'synthetic frozen payload', from: [], to: [], attachments: [], sent_at: null, rfc_message_id: null } }));
  await bucket.put(payloadKey, payload);
  await h.db.prepare('INSERT INTO webhook_endpoints(id,label,created_at,updated_at) VALUES(?,?,?,?)').bind(endpoint, 'Synthetic', now, now).run();
  await h.db.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at)
    VALUES(?,?,1,'https://consumer.example.invalid','bearer','synthetic-never-used',?)`).bind(revision, endpoint, now).run();
  await h.db.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,payload_size_bytes,state,next_attempt_at,created_at)
    VALUES(?,?,?,1,?,?,?,'pending',?,?)`).bind(eventID, id, revision, payloadKey, hash(payload), payload.length, now, now).run();
  return { id, rawKey, raw, parsedKey, attachmentKey, payloadKey, payload, eventID };
}

async function advance(h, wanted, limit = 100) {
  let latest;
  for (let index = 0; index < limit; index++) {
    const value = await h.call('/test/tick');
    latest = value;
    if (wanted(value)) return value;
    assert.ok(!['cleanup', 'failed'].includes(value.native.phase), JSON.stringify(value));
  }
  assert.fail('native backup did not reach the requested durable phase: ' + JSON.stringify(latest));
}

test('native DO Alarm snapshot: writer drain, post-cut intake, restart, whole files and finish/marker failure boundary', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const source = await seed(h, { large: true });
    const writer = await h.call('/mutation/begin', {});
    let state = await h.call('/test/tick');
    assert.equal(state.state, 'draining', 'the native driver waits for real writers, not its own Alarm running flag');
    assert.equal(state.native.phase, 'waiting');
    await h.call('/mutation/end', { id: writer.id });
    state = await advance(h, value => value.state === 'ready');
    assert.equal(state.executor, 'native');
    assert.equal((await h.raw('/backup/begin', { lease_seconds: 300 })).status, 410);
    assert.equal((await h.raw('/backup/cancel', { backup_id: state.backup_id })).status, 409);
    assert.equal((await h.raw('/backup/finish', { backup_id: state.backup_id, manifest_sha256: 'a'.repeat(64), receipt: {}, receipt_mac: 'b'.repeat(64) })).status, 409);
    const postKey = `raw/${crypto.randomUUID()}.eml`, postBytes = Buffer.from('post-cut synthetic raw');
    const intake = await h.call('/reserve-ingest', { key: postKey, size: postBytes.length });
    const main = await h.bucket('MAIL_STORE');
    await main.put(postKey, postBytes, { customMetadata: { ingest_seq: String(intake.ingest_seq), raw_size: String(postBytes.length), mode: 'archive' } });
    await h.call('/ingest/settle', { key: postKey, saved: true });
    assert.equal((await h.call('/mutation/begin', {}).catch(() => null)), null, 'owner writes are excluded during the lease');
    await h.restart();
    state = await advance(h, value => value.native.phase === 'commit');
    const id = state.backup_id;
    await h.call('/test/fault', 'marker');
    state = await h.call('/test/tick');
    assert.equal(state.state, 'remote_verified');
    assert.equal(state.native_marker_pending, true);
    assert.equal(state.native.phase, 'marker');
    assert.equal((await h.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, null);
    assert.equal(await (await h.bucket('BACKUP_STORE')).get(`verified-v2/${id}.json`), null);
    await h.restart({ NATIVE_BACKUP_ENABLED: 'false' });
    await h.call('/test/fault', 'completion_race');
    state = await h.call('/test/tick');
    assert.equal((await h.call('/test/race')).status, 409, 'native ownership, independently of the auto switch, excludes a new lease before its completion checkpoint');
    assert.equal(state.native.phase, 'marker');
    await h.restart();
    state = await advance(h, value => value.native.phase === 'complete');
    assert.equal(state.native_marker_pending, false);
    const backup = await h.bucket('BACKUP_STORE'), marker = await (await backup.get(`verified-v2/${id}.json`)).json();
    assert.equal(marker.proof, 'native_readback_verified');
    assert.equal((await h.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, marker.verified_at);
    const prefix = marker.key.slice(0, marker.key.lastIndexOf('/'));
    const manifestBytes = new Uint8Array(await (await backup.get(marker.key)).arrayBuffer());
    assert.equal(hash(manifestBytes), marker.sha256); assert.equal(marker.sha256, marker.manifest_sha256);
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    assert.equal(manifest.format, 'mailhero.native-backup.v2'); assert.equal(manifest.encrypted, false);
    assert.equal(manifest.credential_key_included, false);
    assert.ok(!manifest.files.some(file => file.object_key === postKey));
    const copies = new Map();
    for (const file of manifest.files) {
      const bytes = Buffer.from(await (await backup.get(`${prefix}/${file.path}`)).arrayBuffer());
      assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
      assert.equal(file.chunks, undefined); copies.set(file.path, bytes);
    }
    const raw = manifest.files.find(file => file.object_key === source.rawKey);
    assert.deepEqual(copies.get(raw.path), source.raw);
    const payload = manifest.files.find(file => file.object_key === source.payloadKey);
    assert.deepEqual(copies.get(payload.path), source.payload);
    const oldManifest = JSON.parse(copies.get('source-manifest.json'));
    assert.equal(hash(canonicalJSON(oldManifest)), manifest.source_manifest_sha256);
    assert.ok(copies.has('snapshot-deletions.json')); assert.ok(!copies.has('credential-key.gpg'));
    assert.ok(manifest.files.every(file => !file.path.endsWith('.gpg')));
    assert.ok(await (await h.bucket('MAIL_STORE')).get(postKey));
    assert.ok(Date.parse(state.native.next_at) > Date.now());
  } finally { await h.close(); }
});

test('actual native snapshot restores through the Python bridge with frozen bytes and paused recovery', { timeout: 120000 }, async () => {
  const h = await harness(), temporary = await mkdtemp(join(tmpdir(), 'mailhero-native-restore-'));
  try {
    const source = await seed(h);
    await h.db.prepare("UPDATE deliveries SET state='sending',claim_token='synthetic-claim',lease_until=? WHERE event_id=?")
      .bind(new Date(Date.now() + 60_000).toISOString(), source.eventID).run();
    const state = await advance(h, value => value.native.phase === 'complete');
    const bucket = await h.bucket('BACKUP_STORE');
    const marker = await (await bucket.get(`verified-v2/${state.backup_id}.json`)).json();
    const prefix = marker.key.slice(0, -'manifest.json'.length), bundle = join(temporary, 'download'), entries = [];
    await mkdir(bundle, { mode: 0o700 });
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
      for (const object of page.objects) {
        const bytes = Buffer.from(await (await bucket.get(object.key)).arrayBuffer());
        const path = 'snapshot/' + object.key.slice(prefix.length), destination = join(bundle, path);
        assert.equal(hash(bytes), object.customMetadata.sha256);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { mode: 0o600 });
        entries.push({ key: object.key, path, bytes: bytes.length, sha256: hash(bytes) });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const journal = Buffer.from(canonicalJSON({ version: 1, fetched_at: new Date().toISOString(), items: [] }));
    const journalPath = join(bundle, 'latest-deletions.json');
    await writeFile(journalPath, journal, { mode: 0o600 });
    const receipt = Buffer.from(canonicalJSON({ version: 2, format: 'mailhero.native-download.v2', marker,
      objects: entries.sort((a, b) => a.key.localeCompare(b.key)), latest_deletions: { bytes: journal.length, sha256: hash(journal) } }));
    await writeFile(join(bundle, 'receipt.json'), receipt, { mode: 0o600 });
    const destination = join(temporary, 'restored');
    const recovered = JSON.parse(execFileSync('python3', [join(root, '../deploy/backup/native_backup.py'), 'restore',
      '--bundle', bundle, '--receipt-sha256', hash(receipt), '--latest-deletions', journalPath, '--destination', destination], { encoding: 'utf8' }));
    assert.equal(recovered.state, 'isolated_requires_reconciliation');
    assert.equal(recovered.native_format_version, 2);
    assert.equal(recovered.force_send_paused, true);
    assert.equal(recovered.maintenance_mode, true);
    assert.equal(recovered.activation_allowed, false);
    assert.equal(recovered.do_alarm_restored, false);
    const inventory = JSON.parse(await readFile(join(destination, 'r2-objects.json'), 'utf8')).objects;
    const raw = inventory.find(item => item.key === source.rawKey), payload = inventory.find(item => item.key === source.payloadKey);
    assert.deepEqual(await readFile(join(destination, raw.path)), source.raw);
    assert.deepEqual(await readFile(join(destination, payload.path)), source.payload);
    assert.equal(raw.customMetadata.mode, 'archive');
    assert.equal(raw.httpMetadata.contentType, 'message/rfc822');
    const restoredDB = JSON.parse(execFileSync('python3', ['-c', `
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    print(json.dumps({
        'send_paused': db.execute('SELECT send_paused FROM app_settings').fetchone()[0],
        'endpoint_paused': db.execute('SELECT paused FROM webhook_endpoints').fetchone()[0],
        'delivery': db.execute('SELECT event_id,message_id,payload_sha256,state,last_error,claim_token,lease_until FROM deliveries').fetchone()
    }))
`, join(destination, 'database.sqlite')], { encoding: 'utf8' }));
    assert.deepEqual(restoredDB, { send_paused: 1, endpoint_paused: 1,
      delivery: [source.eventID, source.id, hash(source.payload), 'failed', 'restore_reconciliation_required', null, null] });
  } finally { await h.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('quota audit: bounded SQLite rows and per-Alarm calls for ordinary snapshots', { timeout: 120000 }, async t => {
  for (const count of process.env.MAILHERO_BACKUP_QUOTA_AUDIT === '1' ? [100, 1000] : [100]) {
    const h = await harness();
    try {
      const bucket = await h.bucket('MAIL_STORE');
      for (let index = 0; index < count; index++) await bucket.put(`audit/${String(index).padStart(6, '0')}`, `synthetic-${index}`);
      const started = Date.now();
      const state = await advance(h, value => value.native.phase === 'complete', count * 2);
      const metrics = await h.call('/test/metrics');
      const top = Object.entries(metrics.queries).sort((a,b)=>b[1].reads-a[1].reads).slice(0,8);
      const top_writes = Object.entries(metrics.queries).sort((a,b)=>b[1].writes-a[1].writes).slice(0,10);
      const {queries,...totals}=metrics;
      assert.ok(metrics.rows_read < (count === 100 ? 8000 : 50000));
      for (const [sql, measured] of Object.entries(metrics.queries)) {
        if (/^(INSERT|UPDATE|DELETE).*\b(backup_objects|native_backup_copies|native_backup_deletions)\b/.test(sql)) assert.equal(measured.writes, 0, sql);
      }
      assert.equal((await (await h.bucket('BACKUP_STORE')).list({ prefix: 'native-work/' })).objects.length, 0);
      assert.ok(metrics.rows_written + metrics.alarm_writes < (count === 100 ? 200 : 400));
      // Workers Free: an invocation may make 1,000 subrequests to Cloudflare services (R2 calls and D1 queries), at most
      // 50 of them D1 queries. A backup tick spends at most 400 of them, and the Alarm a few of its own.
      assert.ok(metrics.max_alarm_d1_calls <= 50); assert.ok(metrics.max_alarm_r2_calls + metrics.max_alarm_d1_calls <= 450);
      t.diagnostic(JSON.stringify({objects:count,elapsed_ms:Date.now()-started,phase:state.native.phase,...totals,top,top_writes}));
      await h.call('/backup/native/run', { version: 2, request_id: crypto.randomUUID() });
      await advance(h, value => value.native.phase === 'complete', count * 2);
      const repeated = await h.call('/test/metrics'), delta = {};
      for (const key of ['rows_read','rows_written','alarm_writes','d1_reads','d1_writes','d1_calls','r2_calls']) delta[key] = repeated[key] - metrics[key];
      assert.ok(delta.rows_read < (count === 100 ? 8000 : 50000));
      assert.ok(delta.rows_written + delta.alarm_writes < (count === 100 ? 150 : 400));
      t.diagnostic(JSON.stringify({objects:count,run:2,...delta,max_alarm_d1_calls:repeated.max_alarm_d1_calls,max_alarm_r2_calls:repeated.max_alarm_r2_calls}));
    } finally { await h.close(); }
  }
});

// Synthetic messages of four objects each (raw, parsed JSON, one stored attachment, frozen payload) with their D1 rows.
async function seedMany(h, messages) {
  const bucket = await h.bucket('MAIL_STORE'), now = new Date().toISOString(), endpoint = crypto.randomUUID(), revision = crypto.randomUUID();
  await h.db.prepare('INSERT INTO webhook_endpoints(id,label,created_at,updated_at) VALUES(?,?,?,?)').bind(endpoint, 'Synthetic', now, now).run();
  await h.db.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at)
    VALUES(?,?,1,'https://consumer.example.invalid','bearer','synthetic-never-used',?)`).bind(revision, endpoint, now).run();
  const keys = [];
  for (let first = 0; first < messages; first += 50) {
    const statements = [];
    await Promise.all(Array.from({ length: Math.min(50, messages - first) }, async () => {
      const id = crypto.randomUUID(), eventID = crypto.randomUUID(), rawKey = `raw/${id}.eml`, parsedKey = `parsed/${id}/fixture/message.json`;
      const attachmentKey = `parsed/${id}/fixture/attachment-1`, payloadKey = `payload/${eventID}.json`;
      const raw = Buffer.alloc(20_000, 0x61), attachment = Buffer.alloc(2_000, 0x62);
      const parsed = Buffer.from(JSON.stringify({ subject: 'synthetic fixture', text: 'never production mail', html: '', headers: [],
        attachments: [{ part_id: '1', filename: 'fixture.txt', size: attachment.length, r2_key: attachmentKey, storage_status: 'stored' }] }));
      const payload = Buffer.from(canonicalJSON({ type: 'mail.received.v1', event_id: eventID, received_at: now,
        message: { id, subject: 'synthetic fixture', text: 'synthetic frozen payload', from: [], to: [], attachments: [], sent_at: null, rfc_message_id: null } }));
      await Promise.all([bucket.put(rawKey, raw, { customMetadata: { raw_size: String(raw.length), mode: 'archive' } }),
        bucket.put(parsedKey, parsed), bucket.put(attachmentKey, attachment), bucket.put(payloadKey, payload)]);
      keys.push(rawKey, parsedKey, attachmentKey, payloadKey);
      statements.push(h.db.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,raw_sha256,size_bytes,receive_mode,
        parse_state,parsed_key,parsed_size_bytes,content_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, now, now, 'synthetic@example.invalid',
          'inbox@example.invalid', rawKey, hash(raw), raw.length, 'archive', 'ready', parsedKey, parsed.length, raw.length + parsed.length + attachment.length),
        h.db.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,payload_size_bytes,state,next_attempt_at,created_at)
          VALUES(?,?,?,1,?,?,?,'pending',?,?)`).bind(eventID, id, revision, payloadKey, hash(payload), payload.length, now, now));
    }));
    // Each message row before its delivery row: the delivery references it.
    await h.db.batch(statements.filter((_, index) => index % 2 === 0));
    await h.db.batch(statements.filter((_, index) => index % 2 === 1));
  }
  return keys;
}

test('a transient failure inside a copy group resumes the same snapshot without skipping an object', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    const bucket = await h.bucket('MAIL_STORE'), keys = Array.from({ length: 12 }, (_, index) => `group/${String(index).padStart(2, '0')}`);
    for (const key of keys) await bucket.put(key, `synthetic-${key}`);
    // The first group is group/00 to group/05; group/03's source read fails once, its neighbours copy.
    await h.call('/test/fault', 'source:group/03');
    const failed = await advance(h, value => value.native.error === 'native_backup_stage_retry');
    assert.equal(failed.native.phase, 'copy');
    let backup = await h.bucket('BACKUP_STORE');
    const copied = async key =>
      (await backup.list({ prefix: `snapshots-v2/` })).objects.some(object => object.key.endsWith(`/objects/${hash(Buffer.from(key))}.bin`));
    assert.equal(await copied('group/05'), true); assert.equal(await copied('group/03'), false);
    await h.restart();
    backup = await h.bucket('BACKUP_STORE');
    const complete = await advance(h, value => value.native.phase === 'complete');
    assert.equal(complete.backup_id, failed.backup_id);
    const marker = await (await backup.get(`verified-v2/${complete.backup_id}.json`)).json(), manifest = await (await backup.get(marker.key)).json();
    assert.deepEqual(manifest.files.filter(file => file.kind === 'object').map(file => file.object_key).sort(), keys);
  } finally { await h.close(); }
});

test('a partial journal page resumes without duplicate deletion records or leftover work files', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    await seed(h);
    const bucket = await h.bucket('BACKUP_STORE'), ids = [crypto.randomUUID(), crypto.randomUUID()].sort();
    for (const id of ids) await bucket.put(`deletion-journal/${id}/raw.json`, JSON.stringify({ id, scope: 'raw', deleted_at: new Date().toISOString() }));
    await h.call('/test/fault', `journal:deletion-journal/${ids[1]}/raw.json`);
    const interrupted = await advance(h, value => value.native.error === 'native_backup_stage_retry');
    assert.equal(interrupted.native.phase, 'journal');
    await h.restart();
    const complete = await advance(h, value => value.native.phase === 'complete');
    assert.equal(complete.backup_id, interrupted.backup_id);
    const saved = await (await h.bucket('BACKUP_STORE')).get(`verified-v2/${complete.backup_id}.json`);
    const marker = await saved.json(), prefix = marker.key.slice(0, -'manifest.json'.length);
    const deletions = await (await (await h.bucket('BACKUP_STORE')).get(`${prefix}snapshot-deletions.json`)).json();
    assert.deepEqual(deletions.items.map(item => item.id).sort(), ids);
    assert.equal((await (await h.bucket('BACKUP_STORE')).list({ prefix: 'native-work/' })).objects.length, 0);
    assert.equal((await (await h.bucket('BACKUP_STORE')).list({ prefix: 'deletion-journal/' })).objects.length, 2);
  } finally { await h.close(); }
});

test('a 2,500-object snapshot takes few Alarm ticks, well inside its 30-minute lease', { timeout: 300000 }, async t => {
  const h = await harness();
  try {
    const keys = await seedMany(h, 625);
    // A new DO first counts the existing objects, a page an Alarm; production's did so long ago.
    for (let page = 0; page < 100 && !(await h.raw('/capacity/status')).ok; page++);
    // Ticks counted by the phase each started in.
    const ticks = {}; let phase = 'begin', state, total = 0;
    for (; total < 2000 && phase !== 'complete'; total++) {
      state = await h.call('/test/tick');
      ticks[phase] = (ticks[phase] ?? 0) + 1; phase = state.native.phase;
      assert.ok(!['cleanup', 'failed'].includes(phase), JSON.stringify(state));
    }
    const metrics = await h.call('/test/metrics');
    t.diagnostic(JSON.stringify({ objects: keys.length, ticks: total, by_phase: ticks,
      max_alarm_r2_calls: metrics.max_alarm_r2_calls, max_alarm_d1_calls: metrics.max_alarm_d1_calls }));
    assert.equal(phase, 'complete');
    const bucket = await h.bucket('BACKUP_STORE'), marker = await (await bucket.get(`verified-v2/${state.backup_id}.json`)).json();
    const manifest = await (await bucket.get(marker.key)).json();
    assert.deepEqual(manifest.files.filter(file => file.kind === 'object').map(file => file.object_key).sort(), keys.sort());
    // Was 415 ticks (313 copying) with eight steps a tick, and a page a tick for the object list and the checks.
    assert.ok(total <= 60, `${total} ticks`);
    assert.ok(ticks.copy <= 30, `${ticks.copy} copy ticks`);
    // A tick works at most 10 s, and the next Alarm follows about a second later: even at that pace the snapshot
    // ends within half of its 30-minute lease.
    assert.ok(total * 12_000 <= 15 * 60_000);
    assert.ok(metrics.max_alarm_d1_calls <= 50);
    assert.ok(metrics.max_alarm_r2_calls + metrics.max_alarm_d1_calls <= 450);
  } finally { await h.close(); }
});

test('deploy wrapper flags drive the actual DO and manual native requests remain idempotent after completion', { timeout: 90000 }, async () => {
  const vars = injectedVars({ MAIL_HERO_FORCE_SEND_PAUSED: 'true', MAIL_HERO_MAINTENANCE_MODE: 'false',
    MAIL_HERO_NATIVE_BACKUP_ENABLED: 'false', GITHUB_SHA: 'a'.repeat(40) });
  const h = await harness(vars);
  try {
    await seed(h);
    assert.equal((await h.call('/backup/native/status')).enabled, false);
    const requestID = crypto.randomUUID();
    const accepted = await h.call('/backup/native/run', { version: 2, request_id: requestID });
    assert.equal(accepted.duplicate, false);
    assert.equal((await h.raw('/backup/begin', { lease_seconds: 300 })).status, 409, 'manual native ownership also holds when automatic scheduling is disabled');
    assert.equal((await h.call('/backup/native/run', { version: 2, request_id: requestID })).duplicate, true);
    const complete = await advance(h, value => value.native.phase === 'complete');
    const replay = await h.call('/backup/native/run', { version: 2, request_id: requestID });
    assert.equal(replay.duplicate, true); assert.equal(replay.backup_id, complete.backup_id); assert.equal(replay.phase, 'complete');
  } finally { await h.close(); }
});

test('25 MiB source is hashed completely and copied as one streamed ordinary object', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const seeded = await seed(h, { rawSize: 25 * 1024 * 1024 });
    const result = await advance(h, value => value.native.phase === 'complete', 150);
    const bucket = await h.bucket('BACKUP_STORE'), marker = await (await bucket.get(`verified-v2/${result.backup_id}.json`)).json();
    const manifest = await (await bucket.get(marker.key)).json(), source = manifest.files.find(file => file.object_key === seeded.rawKey);
    assert.equal(source.bytes, seeded.raw.length); assert.equal(source.sha256, hash(seeded.raw));
    assert.equal(source.chunks, undefined);
    const prefix = marker.key.slice(0, marker.key.lastIndexOf('/'));
    const copied = Buffer.from(await (await bucket.get(`${prefix}/${source.path}`)).arrayBuffer());
    assert.deepEqual(copied, seeded.raw);
  } finally { await h.close(); }
});

test('native readback failure cancels the lease without a success marker or fresh timestamp', { timeout: 90000 }, async () => {
  for (const fault of ['readback', 'corrupt_readback']) {
    const h = await harness();
    try {
      await seed(h);
      await h.call('/test/fault', fault);
      const state = await advance(h, value => value.native.phase === 'cleanup');
      assert.equal(state.native.phase, 'cleanup'); assert.equal(state.paused, false);
      assert.equal(state.native.error, 'native_backup_readback_failed');
      assert.equal((await h.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, null);
      assert.equal((await (await h.bucket('BACKUP_STORE')).list({ prefix: 'verified-v2/' })).objects.length, 0);
    } finally { await h.close(); }
  }
});

test('native snapshot rejects missing live attachments and an expired lease', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    await seed(h, { missingAttachment: true });
    let state;
    for (let index = 0; index < 100; index++) {
      state = await h.call('/test/tick'); if (state.native.phase === 'cleanup') break;
    }
    assert.equal(state.native.error, 'native_backup_attachment_reference_missing');
    assert.equal((await h.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, null);
    const stopped = await advance(h, value => value.native.phase === 'failed');
    assert.equal(stopped.native.manual_required, true); assert.equal(stopped.native.next_at, null);
    for (let index = 0; index < 3; index++) {
      const retry = await h.call('/test/tick');
      assert.equal(retry.native.phase, 'failed'); assert.equal(retry.native.backup_id, stopped.backup_id);
    }
    assert.equal((await (await h.bucket('BACKUP_STORE')).list({ prefix: 'snapshots-v2/' })).objects.length, 0,
      'a permanent reference failure must not keep paying to re-copy the full snapshot');
    assert.equal((await h.call('/backup/native/run', { version: 2, request_id: crypto.randomUUID() })).phase, 'begin');
  } finally { await h.close(); }
  const expired = await harness();
  try {
    await seed(expired);
    await advance(expired, value => value.state === 'ready');
    await expired.call('/test/expire', {});
    const state = await expired.call('/test/tick');
    assert.equal(state.native.phase, 'cleanup');
    assert.equal((await expired.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at, null);
  } finally { await expired.close(); }
});

test('a transient policy-read failure resumes the same already-created lease instead of stranding the freeze', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    await seed(h);
    await h.call('/test/fault', 'policy_read');
    const failed = await h.call('/test/tick');
    assert.equal(failed.native.phase, 'waiting'); assert.equal(failed.native.error, 'native_backup_stage_retry');
    assert.equal(failed.native.backup_id, failed.backup_id);
    const completed = await advance(h, value => value.native.phase === 'complete');
    assert.equal(completed.backup_id, failed.backup_id);
  } finally { await h.close(); }
});

test('a process death after lease creation but before the caller ID checkpoint adopts the existing snapshot cut', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    await seed(h);
    const ready = await advance(h, value => value.state === 'ready');
    assert.equal(ready.native.phase, 'export');
    await h.call('/test/lose-begin-checkpoint', {});
    await h.restart();
    const complete = await advance(h, value => value.native.phase === 'complete');
    assert.equal(complete.backup_id, ready.backup_id); assert.equal(complete.cut_seq, ready.cut_seq); assert.equal(complete.cut_at, ready.cut_at);
  } finally { await h.close(); }
});

test('the platform Alarm finishes a native backup and arms the next day without repeated triggering requests', { timeout: 60000 }, async () => {
  const h = await harness({}, { platformAlarms: true });
  try {
    await seed(h);
    await h.call('/wake', {});
    const deadline = Date.now() + 45_000;
    let state;
    do {
      state = await h.call('/backup/native/status');
      if (state.phase === 'complete') break;
      assert.ok(!['failed', 'cleanup'].includes(state.phase), JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(state.phase, 'complete', JSON.stringify(state));
    assert.ok(Date.parse(state.next_at) > Date.now());
    assert.ok((await h.db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at);
  } finally { await h.close(); }
});
