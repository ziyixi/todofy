import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

async function harness(extra = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'mailhero-native-runner-'));
  const bundled = await build({ stdin: { contents: `
    import { MailCoordinator } from './src/native/coordinator';
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
        const trackedStorage=new Proxy(state.storage,{get(target,name){
          if(name==='sql')return trackedSQL;
          if(name==='setAlarm')return(...args)=>{metrics.alarm_writes++;return target.setAlarm(...args)};
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
            const value=await target.get(key,...args);
            if(faults.value==='readback' && key.startsWith('snapshots-v2/')) {faults.value=null;return null}
            if(faults.value==='corrupt_readback' && value && key.startsWith('snapshots-v2/')) {
              faults.value=null;await value.body.cancel();return {size:value.size,body:new Blob([new Uint8Array(value.size)]).stream()};
            }
            return value;
          };
          return typeof target[name]==='function'?(...args)=>{metrics.r2_calls++;return target[name](...args)}:target[name];
        }});
        const mainBucket=new Proxy(env.MAIL_STORE,{get(target,name){return typeof target[name]==='function'?(...args)=>{metrics.r2_calls++;return target[name](...args)}:target[name];}});
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
      assert.ok(metrics.rows_written + metrics.alarm_writes < (count === 100 ? 1500 : 9000));
      assert.ok(metrics.max_alarm_d1_calls <= 50); assert.ok(metrics.max_alarm_r2_calls <= 50);
      t.diagnostic(JSON.stringify({objects:count,elapsed_ms:Date.now()-started,phase:state.native.phase,...totals,top,top_writes}));
      await h.call('/backup/native/run', { version: 2, request_id: crypto.randomUUID() });
      await advance(h, value => value.native.phase === 'complete', count * 2);
      const repeated = await h.call('/test/metrics'), delta = {};
      for (const key of ['rows_read','rows_written','alarm_writes','d1_reads','d1_writes','d1_calls','r2_calls']) delta[key] = repeated[key] - metrics[key];
      assert.ok(delta.rows_read < (count === 100 ? 8000 : 50000));
      assert.ok(delta.rows_written + delta.alarm_writes < (count === 100 ? 1500 : 9000));
      t.diagnostic(JSON.stringify({objects:count,run:2,...delta,max_alarm_d1_calls:repeated.max_alarm_d1_calls,max_alarm_r2_calls:repeated.max_alarm_r2_calls}));
    } finally { await h.close(); }
  }
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
  const h = await harness();
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
