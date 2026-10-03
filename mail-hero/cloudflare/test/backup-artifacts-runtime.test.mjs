import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const token = 'synthetic-backup-token-'.repeat(3)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('workerd backup artifact: authenticated lease, streamed multipart, verified download, conservative pruning and deletion journal', {timeout:90000}, async () => {
  const temp = await mkdtemp(join(tmpdir(),'mailhero-artifacts-'))
  const bundle = await build({stdin:{contents:`
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
    }};`,resolveDir:root,sourcefile:'artifact-runtime.ts',loader:'ts'},bundle:true,format:'esm',platform:'neutral',conditions:['browser'],external:['cloudflare:workers'],write:false})
  const mf = new Miniflare(convertV4MiniflareOptions({name:'artifact-runtime',modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-09-07',host:'127.0.0.1',port:0,r2Buckets:['BACKUP_STORE'],r2Persist:join(temp,'r2'),
    durableObjects:{COORDINATOR:{className:'TestStatus',useSQLite:true}},durableObjectsPersist:join(temp,'do'),bindings:{BACKUP_TOKEN:token}}))
  try {
    await mf.ready
    const bucket = await mf.getR2Bucket('BACKUP_STORE'), id = crypto.randomUUID(), manifest = 'b'.repeat(64)
    const bytes = Buffer.alloc(16*1024*1024+123,0x61), hash = digest(bytes)
    const input = {backup_id:id,manifest_sha256:manifest,sha256:hash,size_bytes:bytes.length}
    const route = '/api/internal/backup/artifacts/'
    async function api(path, method='GET', body, headers={}) {
      return mf.dispatchFetch('http://localhost'+route+path,{method,headers:{Authorization:`Bearer ${token}`,...headers},body:body===undefined?undefined:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})
    }
    async function status(value) { const response=await mf.dispatchFetch('http://localhost/__test/status',{method:'POST',body:JSON.stringify(value)});assert.equal(response.status,204) }
    assert.equal((await api('list','GET',undefined,{Authorization:'Bearer wrong'})).status,401)
    assert.equal((await api('begin','POST',input)).status,409,'no active ready lease')
    await status({state:'ready',paused:true,backup_id:id})
    assert.equal((await api('begin','POST',{...input,size_bytes:8*1024**3+1})).status,400)
    assert.equal((await api('begin','POST','x'.repeat(65537))).status,413)
    assert.equal((await api('begin','POST','{')).status,400)
    let response=await api('begin','POST',input);assert.equal(response.status,201)
    const upload=await response.json();assert.equal(upload.part_size,16*1024*1024)
    response=await api('begin','POST',input);assert.equal(response.status,200);assert.equal((await response.json()).upload_id,upload.upload_id)
    assert.equal((await api('begin','POST',{...input,sha256:'c'.repeat(64)})).status,409)
    const query=new URLSearchParams({key:upload.key,upload_id:upload.upload_id})
    assert.equal((await api(`part?${query}&part_number=0`,'PUT','a',{'Content-Length':'1'})).status,400)
    assert.equal((await api(`part?${query}&part_number=1`,'PUT','a',{'Content-Length':'1'})).status,400)
    assert.equal((await api('complete','POST',{key:upload.key,upload_id:upload.upload_id,parts:[null,null]})).status,400)
    const parts=[]
    for(let number=1;number<=2;number++) {
      const data=bytes.subarray((number-1)*upload.part_size,number*upload.part_size)
      response=await api(`part?${query}&part_number=${number}`,'PUT',data,{'Content-Length':String(data.length)})
      assert.equal(response.status,200,await response.clone().text());parts.push(await response.json())
    }
    response=await api('complete','POST',{key:upload.key,upload_id:upload.upload_id,parts});assert.equal(response.status,200,await response.clone().text())
    response=await api('object?'+new URLSearchParams({key:upload.key}));assert.equal(response.status,200)
    const downloaded=new Uint8Array(await response.arrayBuffer())
    assert.equal(downloaded.byteLength,bytes.length);assert.equal(digest(downloaded),hash)
    assert.equal(response.headers.get('x-content-sha256'),hash);assert.equal(response.headers.get('cache-control'),'no-store')
    response=await api('object?'+new URLSearchParams({key:upload.key}),'HEAD');assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(await response.text(),'')
    assert.equal((await api('object?key=deletion-journal%2Fprivate.json')).status,400)
    const deletionID=crypto.randomUUID()
    response=await mf.dispatchFetch('http://localhost/__test/deletion',{method:'POST',body:JSON.stringify({id:deletionID,scope:'raw',deleted_at:'2026-09-26T12:00:00Z'})});assert.equal(response.status,204)
    const journal=await (await api('deletions')).json();assert.deepEqual(journal.items,[{id:deletionID,scope:'raw',deleted_at:'2026-09-26T12:00:00Z'}]);assert.equal(journal.complete,true)
    assert.equal((await api('prune','POST',{backup_id:id,manifest_sha256:manifest})).status,409)
    // Unrecognized object metadata must never become automatic prune candidates.
    const unknown=`snapshots/2026-09-01/${crypto.randomUUID()}.tar.gz.gpg`
    await bucket.put(unknown,'unknown',{customMetadata:{sha256:'a'.repeat(64)}})
    const unverifiedID=crypto.randomUUID(),unverified=`snapshots/2026-09-01/${unverifiedID}.tar.gz.gpg`
    await bucket.put(unverified,'unverified',{customMetadata:{backup_id:unverifiedID,sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64)}})
    for(let i=0;i<3;i++) {
      const oldID=crypto.randomUUID(),key=`snapshots/2026-09-01/${oldID}.tar.gz.gpg`,metadata={backup_id:oldID,sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64)}
      await bucket.put(key,'old',{customMetadata:metadata});await bucket.put(`verified/${oldID}.json`,'{}',{customMetadata:{...metadata,key}})
    }
    await status({state:'remote_verified',paused:false,backup_id:id,manifest_sha256:manifest,remote_locator:upload.key})
    assert.equal((await api('prune','POST',{backup_id:id,manifest_sha256:'c'.repeat(64)})).status,409)
    response=await api('prune','POST',{backup_id:id,manifest_sha256:manifest});assert.equal(response.status,200)
    assert.ok((await response.json()).deleted>=2);assert.ok(await bucket.get(upload.key));assert.ok(await bucket.get(unknown));assert.ok(await bucket.get(unverified))
    assert.ok(await bucket.get(`deletion-journal/${deletionID}/raw.json`))
  } finally {await mf.dispose();await rm(temp,{recursive:true,force:true})}
})
