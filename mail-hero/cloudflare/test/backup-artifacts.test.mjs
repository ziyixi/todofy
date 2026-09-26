import test from 'node:test'
import assert from 'node:assert/strict'
import { retainedBackupKeys, handleBackupArtifactAPI } from '../src/native/backup-artifacts.ts'

test('backup retention keeps seven distinct latest days and four ISO weeks, never unrecognized metadata', () => {
  const objects = Array.from({length:40}, (_, index) => {
    const date = new Date(Date.UTC(2026,8,26-index)), id = crypto.randomUUID()
    return { key: `snapshots/${date.toISOString().slice(0,10)}/${id}.tar.gz.gpg`, uploaded: date, customMetadata: {manifest_sha256:'a'.repeat(64)} }
  })
  const duplicate = {...objects[0],key:`snapshots/2026-09-26/${crypto.randomUUID()}.tar.gz.gpg`,uploaded:new Date(objects[0].uploaded.getTime()+1000)}
  const malformed = {...objects[1],key:`snapshots/2026-09-25/${crypto.randomUUID()}.tar.gz.gpg`,customMetadata:{manifest_sha256:'invalid'}}
  const keep = retainedBackupKeys([...objects,duplicate,malformed])
  assert.equal(keep.has(duplicate.key),true);assert.equal(keep.has(objects[0].key),false)
  for(let i=1;i<7;i++) assert.equal(keep.has(objects[i].key),true)
  assert.equal(keep.has(objects[13].key),true);assert.equal(keep.has(objects[20].key),true)
  assert.equal(keep.has(objects[26].key),false);assert.equal(keep.has(malformed.key),false)
  assert.ok(keep.size<=11)
})

test('new backup upload refuses excessive completed count or aggregate reserved storage', async () => {
  const id=crypto.randomUUID(),input={backup_id:id,sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),size_bytes:8*1024**3}
  for(const objects of [Array.from({length:14},()=>({size:1})),Array.from({length:10},()=>({size:8*1024**3}))]) {
    const env={COORDINATOR:{idFromName:value=>value,get:()=>({fetch:async()=>Response.json({state:'ready',paused:true,backup_id:id})})},BACKUP_STORE:{
      get:async()=>null,list:async({prefix})=>({objects:prefix==='snapshots/'?objects:[],truncated:false}),
      createMultipartUpload:async()=>assert.fail('capacity failure must happen before upload creation'),
    }}
    await assert.rejects(handleBackupArtifactAPI(new Request('https://mail.example.org/api/internal/backup/artifacts/begin',{method:'POST',body:JSON.stringify(input)}),env),error=>error.status===409)
  }
})
