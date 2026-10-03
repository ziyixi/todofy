import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { canonicalJSON } from '../src/native/backup.ts';
import { migrationStatements } from './migrations.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture='From: sender@example.org\r\nTo: inbox@mail.example.org\r\nSubject: Synthetic backup fixture\r\n\r\nBackup contract test only.\r\n';
const token='synthetic-backup-machine-token-32-characters',receiptKey='b'.repeat(64);
const key='raw/11111111-1111-4111-8111-111111111111.eml';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('workerd snapshot cut preserves intake and verifies complete authenticated export before resuming',{timeout:90000},async()=>{
  const temp=await mkdtemp(join(tmpdir(),'mail-hero-backup-test-'));
  const bundle=await build({stdin:{contents:`
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
    }};`,resolveDir:root,sourcefile:'native-backup-entry.ts',loader:'ts'},bundle:true,format:'esm',platform:'neutral',conditions:['browser'],external:['cloudflare:workers'],write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({name:'mail-hero-backup-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',host:'127.0.0.1',port:0,
    d1Databases:{DB:'backup-test'},d1Persist:join(temp,'d1'),r2Buckets:['MAIL_STORE','BACKUP_STORE'],r2Persist:join(temp,'r2'),
    durableObjects:{COORDINATOR:{className:'MailCoordinator',useSQLite:true}},durableObjectsPersist:join(temp,'do'),
    bindings:{RECEIVE_ADDRESS:'inbox@mail.example.org',ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'synthetic',ACCESS_OWNER:'owner@example.org',CREDENTIAL_KEY:'a'.repeat(64),WEBHOOK_ALLOWED_HOSTS:'consumer.example.org',BACKUP_TOKEN:token,BACKUP_RECEIPT_KEY:receiptKey,FORCE_SEND_PAUSED:'true'},
    serviceBindings:{ASSETS:()=>new Response('synthetic')},outboundService:()=>{throw new Error('backup must not send external requests');}}));
  try {
    await mf.ready;const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MAIL_STORE');
    for(const name of (await readdir(join(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort()) {
      const sql=await readFile(join(root,'migrations',name),'utf8');await db.batch(migrationStatements(sql).map(s=>db.prepare(s)));
    }
    async function call(path,input,authenticated=true){return mf.dispatchFetch('http://localhost'+path,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+token}:{})},body:input===undefined?undefined:JSON.stringify(input)});}
    async function json(path,input){const response=await call(path,input);const value=await response.json();assert.ok(response.ok,`${response.status} ${JSON.stringify(value)}`);return value;}
    const base='/api/internal/backup';
    assert.equal((await call(base+'/status',undefined,false)).status,401);
    const pre=await json('/__test/coordinator/reserve-ingest',{key,size:Buffer.byteLength(fixture)});
    const begun=await json(base+'/begin',{lease_seconds:300});assert.equal(begun.state,'settling');assert.equal(begun.cut_seq,pre.ingest_seq);
    const id=begun.backup_id,q='?backup_id='+id;
    assert.equal((await call('/__test/coordinator/mutation/begin',{})).status,503);
    const incoming=await mf.dispatchFetch('http://localhost/__test/email',{method:'POST',headers:{'x-raw-size':String(Buffer.byteLength(fixture))},body:fixture});assert.equal(incoming.status,204,await incoming.text());
    assert.equal((await json(base+'/status')).state,'settling');
    assert.equal((await db.prepare('SELECT count(*) n FROM messages').first()).n,0,'lease prevents Alarm from publishing new mail to D1');
    await bucket.put(key,fixture,{customMetadata:{ingest_seq:String(pre.ingest_seq),from:'sender@example.org',to:'inbox@mail.example.org',received_at:new Date().toISOString(),raw_size:String(Buffer.byteLength(fixture)),mode:'archive',revision:''},httpMetadata:{contentType:'message/rfc822'}});
    assert.equal((await json(base+'/status')).state,'ready');
    const blocks=new Map();
    async function block(path,name){const response=await call(base+path);const bytes=await response.text();assert.equal(response.status,200,bytes);assert.equal(response.headers.get('X-Content-SHA256'),hash(bytes));blocks.set(name,bytes);return JSON.parse(bytes);}
    const control=await block('/control'+q,'control.json');assert.deepEqual(control.uploads.map(r=>r.key),[key]);assert.equal(control.policy.mode,'archive');
    const schema=await block('/database-schema'+q,'database-schema.json');
    // Additive columns (0010, contracts/ops-v1) travel with the generic schema export.
    for(const column of ['canary_run_id','active_since','messages_canary_idx']) assert.match(JSON.stringify(schema),new RegExp(column));
    for(const table of schema.tables){let offset=0;do{const page=await block('/database'+q+'&table='+encodeURIComponent(table)+'&offset='+offset,`database/${table}/${offset}.json`);offset=page.next_offset;}while(offset!==null);}
    assert.equal((await call(base+'/manifest'+q)).status,409,'all database pages are not enough without object inventory');
    const objects=await json(base+'/objects'+q);assert.equal(objects.complete,true);assert.deepEqual(objects.objects.map(o=>o.key),[key]);
    assert.deepEqual(await json(base+'/objects'+q),objects,'a lost page response can be retried safely');
    const raw=await call(base+'/object'+q+'&key='+encodeURIComponent(key));assert.equal(await raw.text(),fixture);
    const exported=await json(base+'/manifest'+q);assert.equal(hash(canonicalJSON(exported.manifest)),exported.manifest_sha256);
    for(const item of exported.manifest.blocks){assert.equal(hash(blocks.get(item.name)),item.sha256);assert.equal(Buffer.byteLength(blocks.get(item.name)),item.bytes);}
    assert.equal(exported.manifest.credential_key_included,false);
    assert.equal((await call(base+'/finish',{backup_id:id,manifest_sha256:exported.manifest_sha256})).status,409);
    assert.equal((await db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at,null);
    const receipt={backup_id:id,manifest_sha256:exported.manifest_sha256,remote_locator:'synthetic:independently-verified-test-artifact',verified_at:new Date().toISOString()};
    const finish={backup_id:id,manifest_sha256:exported.manifest_sha256,receipt,receipt_mac:createHmac('sha256',Buffer.from(receiptKey,'hex')).update(canonicalJSON(receipt)).digest('hex')};
    assert.equal((await json(base+'/finish',finish)).state,'remote_verified');
    assert.equal((await json(base+'/finish',finish)).state,'remote_verified','lost finish acknowledgement is idempotent');
    assert.equal((await db.prepare('SELECT last_backup_at FROM app_settings').first()).last_backup_at,receipt.verified_at);
    assert.equal((await json(base+'/status')).paused,false);
    assert.equal((await bucket.list()).objects.length,2,'post-cut raw was accepted and remains durable outside this snapshot');
  } finally {await mf.dispose();await rm(temp,{recursive:true,force:true});}
});
