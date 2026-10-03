import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hash = 'a'.repeat(64), manifestHash = 'b'.repeat(64)

test('real R2: verified native download, durable bounded rotation and abandoned-prefix cleanup', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-backup-artifacts-'))
  const result = await build({ stdin: { resolveDir: root, sourcefile: 'native-artifacts-test.ts', loader: 'ts', contents: `
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
    }};` }, bundle: true, format: 'esm', platform: 'neutral', conditions: ['browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'native-artifacts', modules: true,
    script: result.outputFiles[0].text, compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    r2Buckets: ['BACKUP_STORE'], r2Persist: join(dir, 'r2') }))
  try {
    await mf.ready
    const store = await mf.getR2Bucket('BACKUP_STORE')
    const invoke = (action, value) => mf.dispatchFetch(`http://localhost/${action}`, { method: 'POST', body: JSON.stringify(value) })
    const api = action => mf.dispatchFetch(`http://localhost/api/internal/backup/artifacts/${action}`)
    const now = new Date('2026-10-03T04:17:00Z')
    const backups = []
    for(const age of [0,1,2,3,4,5,6,7,14,21,28,120]) {
      const created = new Date(now.getTime()-age*86400000).toISOString(), id = crypto.randomUUID()
      const key = `snapshots-v2/${created.slice(0,10)}/${id}/manifest.json`
      const marker = {version:2,backup_id:id,key,sha256:hash,manifest_sha256:manifestHash,
        created_at:created,verified_at:created,size_bytes:2048,object_count:1,proof:'native_readback_verified'}
      await store.put(key,'synthetic snapshot',{customMetadata:{backup_id:id,sha256:hash,manifest_sha256:manifestHash}})
      assert.equal((await invoke('mark',marker)).status,204)
      backups.push(marker)
    }
    const current = backups[0], oldest = backups.at(-1)
    const prefix = oldest.key.slice(0,-'manifest.json'.length)
    for(let index=0;index<121;index++) await store.put(`${prefix}objects/${index.toString(16).padStart(64,'0')}.bin`,'ciphertext',{
      customMetadata:{backup_id:oldest.backup_id,sha256:hash}})
    const unknown = `snapshots-v2/2026-01-01/${crypto.randomUUID()}/manifest.json`
    await store.put(unknown,'unverified snapshot')
    const journal = `deletion-journal/${crypto.randomUUID()}/content.json`
    await store.put(journal,'{"scope":"content"}')

    const listed = await (await api('list-v2')).json()
    assert.equal(listed.version,2); assert.equal(listed.items.length,12)
    assert.ok(listed.items.some(item=>item.backup_id===current.backup_id))
    let response = await api(`list-v2-objects?backup_id=${oldest.backup_id}`)
    const inventory = await response.json()
    assert.equal(inventory.objects.length,100); assert.equal(inventory.complete,false)
    assert.ok(inventory.objects.every(item=>Object.keys(item.customMetadata).sort().join(',')==='backup_id,sha256'))
    assert.equal((await api(`list-v2-objects?backup_id=${crypto.randomUUID()}`)).status,409)
    assert.equal((await api('object?key='+encodeURIComponent(current.key))).status,200)
    assert.equal((await api('object?key=snapshots-v2%2F..%2Fsecret')).status,409)
    assert.equal((await invoke('mark',{...current,sha256:'c'.repeat(64)})).status,409)
    assert.equal((await invoke('abandon',{id:current.backup_id,date:current.created_at.slice(0,10)})).status,409)

    let state = await (await invoke('prune',{id:current.backup_id})).json()
    assert.equal(state.done,false)
    assert.ok(state.cursor.targets.some(target=>target.id===oldest.backup_id))
    // The first call only plans. This lets the runner persist the deletion work before doing it.
    assert.ok(await store.head(oldest.key))
    const saved = structuredClone(state.cursor)
    state = await (await invoke('prune',{id:current.backup_id,cursor:saved})).json()
    state = await (await invoke('prune',{id:current.backup_id,cursor:saved})).json()
    let steps = 0
    while(!state.done) {
      assert.ok(++steps<10)
      state = await (await invoke('prune',{id:current.backup_id,cursor:state.cursor})).json()
    }
    assert.equal((await store.list({prefix})).objects.length,0)
    assert.ok(await store.head(current.key)); assert.ok(await store.head(unknown)); assert.ok(await store.head(journal))
    assert.ok((await (await api('list-v2')).json()).items.length<=11)

    const failed = crypto.randomUUID(), date = '2026-10-03', failedPrefix = `snapshots-v2/${date}/${failed}/`
    assert.equal((await invoke('reserve',{id:failed,date,bytes:10000})).status,204)
    assert.equal((await invoke('reserve',{id:failed,date,bytes:10000})).status,204)
    assert.equal((await invoke('reserve',{id:failed,date,bytes:10001})).status,409)
    for(let index=0;index<101;index++) await store.put(`${failedPrefix}objects/${index.toString(16).padStart(64,'0')}.bin`,'failed snapshot')
    assert.equal((await (await invoke('abandon',{id:failed,date})).json()).done,false)
    assert.ok(await store.head(`pending-v2/${failed}.json`))
    assert.equal((await (await invoke('abandon',{id:failed,date})).json()).done,true)
    assert.equal(await store.head(`pending-v2/${failed}.json`),null)
    assert.ok(await store.head(current.key)); assert.ok(await store.head(journal))
  } finally { await mf.dispose(); await rm(dir,{recursive:true,force:true}) }
})
