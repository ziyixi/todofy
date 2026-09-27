import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('workerd lifecycle: migrated D1, R2 expiry journal and durable capacity settlement', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mailhero-lifecycle-'))
  const bundle = await build({ stdin: { contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { CapacityLedger } from './src/native/capacity';
    import { expireRawContent, runLifecycle } from './src/native/lifecycle';
    export class LifecycleLedger extends DurableObject {
      constructor(state,env) { super(state,env); this.ledger=new CapacityLedger(state.storage,env); }
      async fetch(request) {
        await this.ledger.initialize();
        if(request.method==='GET') return Response.json(this.ledger.snapshot());
        const x=await request.json(); const ok=this.ledger.settle(x.key,x.bytes,x.legacy_bytes);
        return new Response(null,{status:ok?204:409});
      }
    }
    export default { async fetch(request,env) {
      const x=await request.json();
      if(x.action==='raw') return Response.json({changed:await expireRawContent(env,x.id,x.version,fn=>fn())});
      return Response.json(await runLifecycle(env,{withMutation:fn=>fn(),deleteContent:async()=>{throw new Error('unexpected full deletion')}}));
    }};`, resolveDir: root, sourcefile: 'lifecycle-runtime.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'lifecycle-runtime', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'lifecycle' }, d1Persist: join(temp, 'd1'), r2Buckets: ['MAIL_STORE','BACKUP_STORE'], r2Persist: join(temp,'r2'),
    durableObjects: { COORDINATOR: { className: 'LifecycleLedger', useSQLite: true } }, durableObjectsPersist: join(temp,'do') }))
  try {
    await mf.ready
    const db = await mf.getD1Database('DB'), store = await mf.getR2Bucket('MAIL_STORE'), backup = await mf.getR2Bucket('BACKUP_STORE')
    for (const name of (await readdir(join(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort()) {
      const sql = await readFile(join(root,'migrations',name),'utf8')
      await db.batch(migrationStatements(sql).map(s=>db.prepare(s)))
    }
    const id = crypto.randomUUID(), raw = `raw/${id}.eml`, parsed = `parsed/${id}/message.json`, date = new Date().toISOString()
    await store.put(raw,'raw fixture'); await store.put(parsed,'{"text":"synthetic"}')
    await db.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,content_bytes,receive_mode,parse_state,parsed_key,retention_policy_version,raw_retention_days,content_retention_days)
      VALUES(?,?,?,'fixture@example.org','hero@example.org',?,11,31,'archive','ready',?,1,7,30)`).bind(id,date,date,raw,parsed).run()
    await db.prepare('UPDATE app_settings SET logical_bytes=31').run()
    const namespace = await mf.getDurableObjectNamespace('COORDINATOR'), stub = namespace.get(namespace.idFromName('inbox-v1'))
    assert.equal((await (await stub.fetch('https://coordinator/capacity/status')).json()).used_bytes,31)
    let response = await mf.dispatchFetch('http://localhost/',{method:'POST',body:JSON.stringify({action:'raw',id,version:1})})
    assert.equal(response.status,200); assert.equal((await response.json()).changed,true)
    assert.equal(await store.get(raw),null); assert.ok(await store.get(parsed))
    assert.ok(await backup.get(`deletion-journal/${id}/raw.json`))
    const row = await db.prepare('SELECT raw_expired_at,raw_purged_at,raw_capacity_pending_key,content_deleted_at,content_bytes FROM messages WHERE id=?').bind(id).first()
    assert.ok(row.raw_expired_at); assert.ok(row.raw_purged_at); assert.equal(row.raw_capacity_pending_key,null); assert.equal(row.content_deleted_at,null); assert.equal(row.content_bytes,20)
    assert.equal((await (await stub.fetch('https://coordinator/capacity/status')).json()).used_bytes,20)
    response = await mf.dispatchFetch('http://localhost/',{method:'POST',body:JSON.stringify({action:'raw',id,version:2})})
    assert.equal((await response.json()).changed,false)
    assert.equal((await db.prepare('SELECT logical_bytes FROM app_settings').first()).logical_bytes,20)
  } finally { await mf.dispose(); await rm(temp,{recursive:true,force:true}) }
})
