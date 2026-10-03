import test from 'node:test'
import assert from 'node:assert/strict'
import { assertBackupArtifactCapacity } from '../src/native/backup-artifact-capacity.ts'
import { handleBackupArtifactAPI } from '../src/native/backup-artifacts.ts'

test('capacity includes legacy and native completed/reserved bytes before either upload', async () => {
  const gib = 1024**3, listing = {
    'snapshots/': Array.from({length:7},()=>({size:8*gib})),
    'verified-v2/': [{customMetadata:{size_bytes:String(8*gib)}}],
    'uploads/': [{key:'legacy-reservation'}],
    'pending-v2/': [{customMetadata:{size_bytes:String(4*gib)}}],
  }
  const env = {BACKUP_STORE:{list:async({prefix})=>({objects:listing[prefix],truncated:false}),
    get:async()=>({size:300,json:async()=>({size_bytes:8*gib})})}}
  await assert.rejects(assertBackupArtifactCapacity(env,8*gib),/backup_capacity_review_required/)
  await assertBackupArtifactCapacity(env,4*gib)
  listing['pending-v2/'][0].customMetadata.size_bytes='invalid'
  await assert.rejects(assertBackupArtifactCapacity(env,1),/backup_capacity_inventory_invalid/)
})

test('legacy upload cannot write into the native executor lease', async () => {
  const id=crypto.randomUUID(),env={BACKUP_STORE:{},COORDINATOR:{idFromName:value=>value,
    get:()=>({fetch:async()=>Response.json({backup_id:id,state:'ready',paused:true,executor:'native'})})}}
  await assert.rejects(handleBackupArtifactAPI(new Request('https://fixture.example/api/internal/backup/artifacts/begin',{
    method:'POST',body:JSON.stringify({backup_id:id,sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),size_bytes:1})}),env),
    error=>error.status===409 && error.code==='native_backup_owned')
})
