import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MailCoordinator } from '../src/native/coordinator.ts';
import { MAX_PARSE_EXTRA_BYTES } from '../src/native/capacity.ts';

const key1='raw/11111111-1111-4111-8111-111111111111.eml';
const key2='raw/22222222-2222-4222-8222-222222222222.eml';
function fixture(options={}) {
  const db=new DatabaseSync(':memory:');let alarm=null,dbDown=false,policyReads=0;
  const objects=new Map(),settings={logical_bytes:0,logical_limit_bytes:5*1024**3,mode:'forward',revision_id:'frozen-revision',lifecycle_policy_version:3,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,...options.settings};
  const storage={sql:{exec(sql,...values){const query=db.prepare(sql),rows=query.columns().length?query.all(...values):(query.run(...values),[]);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},
    transactionSync(callback){db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},
    setAlarm:async value=>{alarm=value;},getAlarm:async()=>alarm};
  const env={DB:{prepare(sql){return {bind(...values){this.values=values;return this;},async first(){if(dbDown)throw new Error('synthetic_down');if(sql.includes('claim_token FROM messages'))return options.claim?.(this.values[0]) ?? null;if(sql.includes('SELECT s.*'))policyReads++;return settings;},async run(){if(dbDown)throw new Error('synthetic_down');return {meta:{changes:1}};}};}},
    MAIL_STORE:{head:async key=>objects.get(key) ?? null,list:options.list ?? (async()=>({objects:[],truncated:false}))},...options.env};
  const coordinator=new MailCoordinator({storage},env);
  return {db,objects,env,settings,coordinator,close(){db.close();},get policyReads(){return policyReads;},set dbDown(value){dbDown=value;}};
}
async function request(f,path,input) {return f.coordinator.fetch(new Request('https://coordinator'+path,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)}));}
const reserve=(f,key=key1,size=100)=>request(f,'/reserve-ingest',{key,size});

test('physical bootstrap is paged, fails closed, and counts unindexed raw before reserving',async()=>{
  let pages=0;
  const f=fixture({settings:{logical_bytes:100},list:async({cursor})=>{pages++;return cursor?{objects:[{size:700}],truncated:false}:{objects:[{size:300}],truncated:true,cursor:'page2'};}});
  try {
    assert.equal((await reserve(f)).status,503);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ingress_reservations').get().n,0);
    assert.equal((await reserve(f)).status,200);
    assert.equal(pages,2);
    const capacity=await (await request(f,'/capacity/status')).json();
    assert.equal(capacity.baseline_bytes,1000);assert.equal(capacity.reserved_bytes,100+MAX_PARSE_EXTRA_BYTES);
    assert.equal(capacity.used_bytes,1100+MAX_PARSE_EXTRA_BYTES);
  } finally {f.close();}
});
test('bootstrap outage cannot bypass capacity; initialized capacity still bounds intake when D1 goes down',async()=>{
  const f=fixture({settings:{logical_limit_bytes:MAX_PARSE_EXTRA_BYTES+150}});
  try {
    f.dbDown=true;assert.equal((await reserve(f)).status,503);
    f.dbDown=false;assert.equal((await request(f,'/capacity/status')).status,200);
    f.dbDown=true;const accepted=await reserve(f);assert.equal(accepted.status,200);assert.equal((await accepted.json()).policy_error,'policy_unavailable');
    assert.equal((await reserve(f,key2,1)).status,429);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  } finally {f.close();}
});
test('concurrent capacity reservations cannot oversubscribe and released keys cannot be resurrected',async()=>{
  const f=fixture({settings:{logical_limit_bytes:MAX_PARSE_EXTRA_BYTES+150}});
  try {
    const responses=await Promise.all([reserve(f,key1),reserve(f,key2)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
    const key=responses[0].status===200?key1:key2;
    assert.equal((await request(f,'/ingest/settle',{key,saved:false})).status,204);
    assert.equal((await request(f,'/ingest/settle',{key,saved:false})).status,204);
    assert.equal((await reserve(f,key)).status,429);
    assert.equal((await (await request(f,'/capacity/status')).json()).used_bytes,0);
  } finally {f.close();}
});
test('legacy resize and temporary parse hold transfer are atomic and idempotent',async()=>{
  const f=fixture({settings:{logical_bytes:1000}});
  try {
    assert.equal((await request(f,'/capacity/settle',{key:key1,bytes:700,legacy_bytes:1000})).status,204);
    assert.equal((await request(f,'/capacity/settle',{key:key1,bytes:700,legacy_bytes:1000})).status,204);
    const prefix='parsed/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333';
    assert.equal((await request(f,'/capacity/reserve',{key:prefix,bytes:2000})).status,204);
    assert.equal((await request(f,'/capacity/settle',{key:key1,bytes:2500,legacy_bytes:700,release_key:prefix})).status,204);
    assert.equal((await request(f,'/capacity/settle',{key:key1,bytes:2500,legacy_bytes:700,release_key:prefix})).status,204);
    assert.equal((await (await request(f,'/capacity/status')).json()).used_bytes,2500);
    await request(f,'/capacity/release',{key:key1,legacy_bytes:700});await request(f,'/capacity/release',{key:key1,legacy_bytes:700});
    assert.equal((await (await request(f,'/capacity/status')).json()).used_bytes,0);
  } finally {f.close();}
});
test('snapshot drains writes and waits for pre-cut PUT while post-cut intake keeps frozen policy',async()=>{
  const f=fixture();
  try {
    const write=await (await request(f,'/mutation/begin',{})).json();
    const pre=await (await reserve(f)).json();
    const begin=await (await request(f,'/backup/begin',{lease_seconds:30})).json();assert.equal(begin.state,'draining');
    assert.equal((await request(f,'/mutation/begin',{})).status,503);
    await request(f,'/mutation/end',{id:write.id});
    const settling=await (await request(f,'/backup/status')).json();assert.equal(settling.state,'settling');assert.equal(settling.cut_seq,pre.ingest_seq);
    f.dbDown=true;
    const post=await (await reserve(f,key2)).json();assert.equal(post.mode,'forward');assert.equal(post.revision,'frozen-revision');assert.equal(post.lifecycle_policy_version,3);assert.ok(post.ingest_seq>settling.cut_seq);
    assert.equal((await (await request(f,'/backup/status')).json()).state,'settling');
    f.objects.set(key1,{customMetadata:{ingest_seq:String(pre.ingest_seq)}});
    const ready=await (await request(f,'/backup/status')).json();assert.equal(ready.state,'ready');
    const control=await (await request(f,`/backup/control?backup_id=${begin.backup_id}`)).json();
    assert.deepEqual(control.uploads.map(r=>r.key),[key1]);assert.deepEqual(control.allocations.map(r=>r.key),[key1]);
    assert.deepEqual(control.jobs.map(r=>JSON.parse(r.payload).key),[key1]);
    assert.equal((await request(f,'/backup/cancel',{backup_id:begin.backup_id})).status,200);
    assert.equal((await request(f,'/mutation/begin',{})).status,200);
  } finally {f.close();}
});
test('snapshot expiry resumes writes and rejects commit; object pagination retries are stable',async()=>{
  const f=fixture({list:async()=>({objects:[{key:'raw/legacy.eml',size:1,etag:'x',uploaded:new Date(0),customMetadata:{}}],truncated:false})});
  try {
    const begin=await (await request(f,'/backup/begin',{})).json();assert.equal(begin.state,'ready');
    const url=`/backup/objects?backup_id=${begin.backup_id}`;
    const first=await (await request(f,url)).json(),second=await (await request(f,url)).json();assert.deepEqual(first,second);
    const lease=JSON.parse(f.db.prepare('SELECT value FROM backup_control').get().value);lease.expires_at=Date.now()-1;f.db.prepare('UPDATE backup_control SET value=?').run(JSON.stringify(lease));
    assert.equal((await request(f,'/backup/finish',{backup_id:begin.backup_id})).status,409);
    assert.equal((await (await request(f,'/backup/status')).json()).state,'expired');
    assert.equal((await request(f,'/mutation/begin',{})).status,200);
  } finally {f.close();}
});
test('abandoned empty parse reservations are reconciled without reclaiming a current claim',async()=>{
  const claim='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
  const f=fixture({claim:()=>({claim_token:claim})});
  try {
    const prefix=id=>`parsed/11111111-1111-4111-8111-111111111111/${id}`;
    await request(f,'/capacity/reserve',{key:prefix(claim),bytes:2000});await request(f,'/capacity/reserve',{key:prefix(other),bytes:3000});
    f.db.prepare('UPDATE capacity_allocations SET created=0').run();
    assert.deepEqual(await (await request(f,'/capacity/reconcile',{})).json(),{checked:2,released:1});
    assert.equal((await (await request(f,'/capacity/status')).json()).used_bytes,2000);
    const write=await (await request(f,'/mutation/begin',{})).json();assert.equal((await request(f,'/capacity/reconcile',{})).status,409);await request(f,'/mutation/end',{id:write.id});
  } finally {f.close();}
});
test('concurrent backup begin requests cannot replace the lease while request bodies yield',async()=>{
  const f=fixture();
  try {
    await request(f,'/capacity/status');
    const results=await Promise.all([request(f,'/backup/begin',{}),request(f,'/backup/begin',{})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const accepted=await results.find(r=>r.status===200).json();
    assert.equal((await (await request(f,'/backup/status')).json()).backup_id,accepted.backup_id);
  } finally {f.close();}
});
test('empty unpublished payload holds recover, while a stored payload remains reserved',async()=>{
  const f=fixture({env:{DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('logical_bytes')?{logical_bytes:0,logical_limit_bytes:5*1024**3}:null;}};}}}});
  try {
    const absent='payload/11111111-1111-4111-8111-111111111111.json',present='payload/22222222-2222-4222-8222-222222222222.json';
    await request(f,'/capacity/reserve',{key:absent,bytes:200});await request(f,'/capacity/reserve',{key:present,bytes:300});f.objects.set(present,{size:300});
    f.db.prepare('UPDATE capacity_allocations SET created=0').run();
    assert.deepEqual(await (await request(f,'/capacity/reconcile',{})).json(),{checked:2,released:1});
    assert.equal((await (await request(f,'/capacity/status')).json()).used_bytes,300);
  } finally {f.close();}
});
test('verified DO receipt survives a D1 status-index outage and retries without changing proof',async()=>{
  const f=fixture();
  try {
    const lease={id:'synthetic-backup-id',state:'remote_verified',created_at:new Date().toISOString(),expires_at:Date.now()-1,cut_seq:0,cut_at:new Date().toISOString(),policy:null,objects_done:true,object_cursor:null,manifest_sha256:'a'.repeat(64),remote_locator:'synthetic:remote',verified_at:new Date().toISOString(),receipt_sync_pending:true};
    f.db.prepare('INSERT INTO backup_control VALUES(1,?)').run(JSON.stringify(lease));
    f.dbDown=true;const pending=await (await request(f,'/backup/status')).json();assert.equal(pending.state,'remote_verified');assert.equal(pending.receipt_sync_pending,true);assert.equal(pending.paused,false);
    f.dbDown=false;const settled=await (await request(f,'/backup/status')).json();assert.equal(settled.state,'remote_verified');assert.equal(settled.receipt_sync_pending,false);assert.equal(settled.manifest_sha256,lease.manifest_sha256);
  } finally {f.close();}
});
test('stale writer reconciliation requires maintenance, operator quiescence, exact ID and minimum age',async()=>{
  const f=fixture();
  try {
    const writer=await (await request(f,'/mutation/begin',{})).json();
    assert.equal((await request(f,'/backup/reconcile-writer',{writer_id:writer.id,confirmed_quiescent:true})).status,409);
    f.env.MAINTENANCE_MODE='true';
    assert.equal((await request(f,'/backup/reconcile-writer',{writer_id:writer.id,confirmed_quiescent:true})).status,409);
    f.db.prepare('UPDATE mutation_leases SET created=? WHERE id=?').run(Date.now()-16*60_000,writer.id);
    assert.equal((await request(f,'/backup/reconcile-writer',{writer_id:writer.id})).status,409);
    const listed=await (await request(f,'/backup/writers')).json();assert.equal(listed.writers[0].id,writer.id);assert.ok(listed.writers[0].age_ms>=15*60_000);
    assert.equal((await request(f,'/backup/reconcile-writer',{writer_id:writer.id,confirmed_quiescent:true})).status,200);
    assert.equal((await (await request(f,'/backup/writers')).json()).writers.length,0);
    assert.equal((await request(f,'/backup/reconcile-writer',{writer_id:writer.id,confirmed_quiescent:true})).status,404);
  } finally {f.close();}
});
test('backup control excludes completed intake history and released capacity tombstones',async()=>{
  const f=fixture();
  try {
    const reserved=await (await reserve(f)).json();f.objects.set(key1,{customMetadata:{ingest_seq:String(reserved.ingest_seq)}});await request(f,'/ingest/settle',{key:key1,saved:true});
    f.db.prepare('DELETE FROM jobs').run();await request(f,'/capacity/release',{key:key1});
    const begun=await (await request(f,'/backup/begin',{})).json();
    const control=await (await request(f,'/backup/control?backup_id='+begun.backup_id)).json();assert.deepEqual(control.uploads,[]);assert.deepEqual(control.allocations,[]);assert.equal(control.cut_seq,reserved.ingest_seq);
  } finally {f.close();}
});
test('backup control size ceiling rejects before parsing oversized persisted job values',async()=>{
  const f=fixture();
  try {
    await request(f,'/capacity/status');
    f.db.prepare('INSERT INTO jobs(id,payload,due,created) VALUES(?,?,?,?)').run('synthetic-corrupt-job','x'.repeat(3*1024*1024),Date.now(),Date.now());
    const begun=await (await request(f,'/backup/begin',{})).json();
    const response=await request(f,'/backup/control?backup_id='+begun.backup_id);assert.equal(response.status,413);assert.equal((await response.json()).error.code,'backup_control_export_limit');
  } finally {f.close();}
});
test('processing deletion before upload settlement cannot leave a phantom pre-cut PUT',async()=>{
  const f=fixture();
  try {
    await reserve(f); // Simulate duplicate processing removing the saved raw before email settle arrives.
    assert.equal((await request(f,'/capacity/release',{key:key1})).status,204);
    assert.equal((await request(f,'/ingest/settle',{key:key1,saved:true})).status,204);
    assert.equal(f.db.prepare('SELECT status FROM ingest_uploads WHERE key=?').get(key1).status,'deleted');
    assert.equal((await (await request(f,'/backup/begin',{})).json()).state,'ready');
  } finally {f.close();}
});
