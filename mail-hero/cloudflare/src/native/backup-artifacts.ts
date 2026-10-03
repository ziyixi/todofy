import type { Env } from './types.ts';
import { backupStatus } from './backup.ts';
import { HttpError } from './security.ts';
import { isNativeBackupKey, retainedBackupKeys } from './backup-retention.ts';
export { retainedBackupKeys } from './backup-retention.ts';
import { validNativeMarker } from './native-backup-artifacts.ts';
import { assertBackupArtifactCapacity } from './backup-artifact-capacity.ts';

const PART_SIZE=16*1024*1024,MAX_SIZE=8*1024*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY=/^snapshots\/\d{4}-\d{2}-\d{2}\/([0-9a-f-]{36})\.tar\.gz\.gpg$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=(status:number,code:string):never=>{throw new HttpError(status,code,code)};
function bucket(env:Env):R2Bucket {return env.BACKUP_STORE ?? fail(503,'backup_store_unconfigured')}
async function body(request:Request):Promise<Record<string,any>> {
  const reader=request.body?.getReader(); if(!reader) return fail(400,'invalid_backup_request');
  const chunks:Uint8Array[]=[];let length=0;
  for(;;) {
    const next=await reader.read();if(next.done) break;
    length+=next.value.byteLength;
    if(length>64*1024) {await reader.cancel();return fail(413,'backup_request_too_large')}
    chunks.push(next.value);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength}
  try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value || Array.isArray(value) || typeof value!=='object') fail(400,'invalid_backup_request');return value;}
  catch {return fail(400,'invalid_backup_request')}
}
function validKey(key:unknown):string {if(typeof key!=='string' || key.trim()!==key || !KEY.test(key) || !UUID.test(KEY.exec(key)![1])) fail(400,'invalid_backup_key');return key as string}
interface Upload {key:string;upload_id:string;backup_id:string;size_bytes:number;sha256:string;manifest_sha256:string;created_at:string}
async function upload(env:Env,key:unknown,uploadID:unknown):Promise<Upload> {
  const valid=validKey(key),record=await bucket(env).get(`uploads/${KEY.exec(valid)![1]}.json`);
  if(!record) return fail(404,'backup_upload_not_found');
  const value=await record.json<Upload>();
  if(value.key!==valid || value.upload_id!==uploadID) fail(409,'backup_upload_mismatch');
  return value;
}
async function ready(env:Env,id:string):Promise<void> {
  const value=await backupStatus(env);
  if(value.backup_id!==id || value.state!=='ready' || !value.paused) fail(409,'backup_not_ready_or_expired');
  if(value.executor==='native') fail(409,'native_backup_owned');
}
function metadata(value:Upload):Record<string,string> {return {backup_id:value.backup_id,sha256:value.sha256,manifest_sha256:value.manifest_sha256,created_at:value.created_at}}
/** The independently stored journal survives loss or rollback of the live D1.
 * It deliberately contains only random IDs, scope and timestamps. */
export async function recordDeletion(env:Env,id:string,scope:'raw'|'content',deletedAt:string):Promise<void> {
  if(!env.BACKUP_STORE) return;
  if(!UUID.test(id) || !Number.isFinite(Date.parse(deletedAt))) throw new Error('invalid_deletion_record');
  await env.BACKUP_STORE.put(`deletion-journal/${id}/${scope}.json`,JSON.stringify({id,scope,deleted_at:deletedAt}),{httpMetadata:{contentType:'application/json'}});
}
/** Caller already authenticated the dedicated backup credential. These routes
 * cannot alter the application bucket or send mail. */
export async function handleBackupArtifactAPI(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url),action=url.pathname.split('/artifacts/')[1],store=bucket(env);
  const respond=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(action==='begin' && request.method==='POST') {
    const input=await body(request);
    if(!UUID.test(input.backup_id) || !HASH.test(input.sha256) || !HASH.test(input.manifest_sha256) || !Number.isSafeInteger(input.size_bytes) || input.size_bytes<1 || input.size_bytes>MAX_SIZE) fail(400,'invalid_backup_artifact');
    await ready(env,input.backup_id);
    const existing=await store.get(`uploads/${input.backup_id}.json`);
    if(existing) {
      const value=await existing.json<Upload>();
      if(value.sha256!==input.sha256 || value.size_bytes!==input.size_bytes || value.manifest_sha256!==input.manifest_sha256) fail(409,'backup_upload_conflict');
      return respond({...value,part_size:PART_SIZE});
    }
    // Bound abandoned uploads and temporary storage. Recovery uses /abort;
    // normal failure cleanup does not touch completed snapshots.
    try { await assertBackupArtifactCapacity(env,input.size_bytes); }
    catch(error) { fail(409,error instanceof Error && /^backup_[a-z_]+$/.test(error.message)?error.message:'backup_capacity_unavailable'); }
    const created=new Date().toISOString(),key=`snapshots/${created.slice(0,10)}/${input.backup_id}.tar.gz.gpg`;
    if(await store.head(key)) fail(409,'backup_artifact_already_exists');
    const value:Upload={key,upload_id:'',backup_id:input.backup_id,size_bytes:input.size_bytes,sha256:input.sha256,manifest_sha256:input.manifest_sha256,created_at:created};
    const multi=await store.createMultipartUpload(key,{httpMetadata:{contentType:'application/octet-stream'},customMetadata:metadata(value)});
    value.upload_id=multi.uploadId;
    await store.put(`uploads/${input.backup_id}.json`,JSON.stringify(value));
    return respond({...value,part_size:PART_SIZE},201);
  }
  if(action==='part' && request.method==='PUT') {
    const value=await upload(env,url.searchParams.get('key'),url.searchParams.get('upload_id'));
    await ready(env,value.backup_id);
    const part=Number(url.searchParams.get('part_number')),count=Math.ceil(value.size_bytes/PART_SIZE);
    if(!Number.isInteger(part) || part<1 || part>count || !request.body) fail(400,'invalid_backup_part');
    const expected=part===count?value.size_bytes-(count-1)*PART_SIZE:PART_SIZE;
    if(Number(request.headers.get('Content-Length'))!==expected) fail(400,'backup_part_size_mismatch');
    // FixedLengthStream catches under/overflow without buffering archive bytes
    // in the 128 MiB Worker isolate.
    const fixed=new FixedLengthStream(expected),pipe=request.body!.pipeTo(fixed.writable);pipe.catch(()=>{});
    try {
      const result=await store.resumeMultipartUpload(value.key,value.upload_id).uploadPart(part,fixed.readable);
      await pipe;return respond(result);
    } catch(error) {fixed.readable.cancel().catch(()=>{});throw error}
  }
  if(action==='complete' && request.method==='POST') {
    const input=await body(request),value=await upload(env,input.key,input.upload_id);
    await ready(env,value.backup_id);
    const count=Math.ceil(value.size_bytes/PART_SIZE);
    if(!Array.isArray(input.parts) || input.parts.length!==count || input.parts.some((part:any,index:number)=>!part || typeof part!=='object' || part.partNumber!==index+1 || typeof part.etag!=='string' || !/^[\w-]{1,200}$/.test(part.etag))) fail(400,'invalid_backup_parts');
    const result=await store.resumeMultipartUpload(value.key,value.upload_id).complete(input.parts);
    if(result.size!==value.size_bytes) fail(409,'backup_artifact_size_mismatch');
    await store.delete(`uploads/${value.backup_id}.json`);
    return respond({key:value.key,size_bytes:result.size,sha256:value.sha256,manifest_sha256:value.manifest_sha256});
  }
  if(action==='abort' && request.method==='POST') {
    const input=await body(request),value=await upload(env,input.key,input.upload_id);
    await store.resumeMultipartUpload(value.key,value.upload_id).abort();
    await store.delete(`uploads/${value.backup_id}.json`);return respond({aborted:true});
  }
  if(action==='object' && ['GET','HEAD'].includes(request.method)) {
    const requested=url.searchParams.get('key'),key=isNativeBackupKey(requested)?requested:validKey(requested);
    const object=request.method==='HEAD'?await store.head(key):await store.get(key);
    if(!object) return fail(404,'backup_artifact_missing');
    return new Response('body' in object?(object as R2ObjectBody).body:null,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':object.customMetadata?.sha256 ?? '',ETag:object.httpEtag}});
  }
  if(action==='list' && request.method==='GET') {
    const page=await store.list({prefix:'snapshots/',limit:100,cursor:url.searchParams.get('cursor') ?? undefined,include:['customMetadata']});
    return respond({objects:page.objects.map(o=>({key:o.key,size:o.size,uploaded:o.uploaded.toISOString(),customMetadata:o.customMetadata ?? {}})),truncated:page.truncated,cursor:page.truncated?page.cursor:null});
  }
  if(action==='list-v2' && request.method==='GET') {
    const page=await store.list({prefix:'verified-v2/',limit:100,cursor:url.searchParams.get('cursor') ?? undefined,include:['customMetadata']});
    const items=page.objects.map(o=>{
      const m=o.customMetadata ?? {};
      return {version:2 as const,backup_id:m.backup_id,key:m.key,sha256:m.sha256,manifest_sha256:m.manifest_sha256,
        created_at:m.created_at,verified_at:m.verified_at,size_bytes:Number(m.size_bytes),object_count:Number(m.object_count),
        proof:m.proof as 'native_readback_verified'};
    }).filter(m=>validNativeMarker(m));
    return respond({version:2,items,cursor:page.truncated?page.cursor:null,complete:!page.truncated});
  }
  if(action==='list-v2-objects' && request.method==='GET') {
    const id=url.searchParams.get('backup_id') ?? '';
    if(!UUID.test(id)) fail(400,'invalid_native_backup_identity');
    const receipt=await store.get(`verified-v2/${id}.json`);
    if(!receipt || receipt.size>4096) fail(404,'verified_native_backup_missing');
    const marker=await receipt!.json<import('./native-backup-format.ts').NativeBackupMarker>();
    if(!validNativeMarker(marker) || marker.backup_id!==id) fail(409,'native_backup_marker_invalid');
    const prefix=marker.key.slice(0,-'manifest.json'.length);
    const page=await store.list({prefix,limit:100,cursor:url.searchParams.get('cursor') ?? undefined,include:['customMetadata']});
    if(page.objects.some(o=>!isNativeBackupKey(o.key) || !o.key.startsWith(prefix) ||
      o.customMetadata?.backup_id!==id || !HASH.test(o.customMetadata?.sha256 ?? ''))) fail(409,'native_backup_inventory_invalid');
    return respond({version:2,objects:page.objects.map(o=>({key:o.key,size:o.size,customMetadata:{
      backup_id:id,sha256:o.customMetadata!.sha256}})),cursor:page.truncated?page.cursor:null,complete:!page.truncated});
  }
  if(action==='deletions' && request.method==='GET') {
    const page=await store.list({prefix:'deletion-journal/',limit:20,cursor:url.searchParams.get('cursor') ?? undefined});
    const items=[];
    for(const object of page.objects) {const value=await store.get(object.key);if(!value) fail(503,'deletion_journal_incomplete');items.push(await value!.json());}
    return respond({items,cursor:page.truncated?page.cursor:null,complete:!page.truncated});
  }
  if(action==='prune' && request.method==='POST') {
    const input=await body(request),status=await backupStatus(env);
    if(status.state!=='remote_verified' || status.backup_id!==input.backup_id || status.manifest_sha256!==input.manifest_sha256) fail(409,'verified_backup_required');
    const currentKey=validKey(status.remote_locator),current=await store.head(currentKey);
    if(KEY.exec(currentKey)![1]!==status.backup_id || !current || current.customMetadata?.backup_id!==status.backup_id || current.customMetadata?.manifest_sha256!==status.manifest_sha256 ||
      !HASH.test(current.customMetadata?.sha256 ?? '')) fail(409,'verified_backup_artifact_mismatch');
    // A completed upload is not yet a verified backup. Preserve independent
    // receipt markers so an unverified newer upload cannot displace a good one.
    await store.put(`verified/${status.backup_id}.json`,JSON.stringify({backup_id:status.backup_id,key:currentKey,manifest_sha256:status.manifest_sha256}),{
      customMetadata:{key:currentKey,backup_id:status.backup_id,manifest_sha256:status.manifest_sha256,sha256:current!.customMetadata!.sha256}});
    const page=await store.list({prefix:'snapshots/',limit:100,include:['customMetadata']});
    const receipts=await store.list({prefix:'verified/',limit:100,include:['customMetadata']});
    if(page.truncated || receipts.truncated) fail(409,'backup_inventory_requires_review');
    const verified=new Map(receipts.objects.filter(o=>o.customMetadata?.backup_id && o.key===`verified/${o.customMetadata.backup_id}.json`).map(o=>[o.customMetadata!.key,o.customMetadata!]));
    const confirmed=page.objects.filter(o=>{
      const proof=verified.get(o.key),meta=o.customMetadata;
      return KEY.test(o.key) && proof && meta?.backup_id===KEY.exec(o.key)![1] && proof.backup_id===meta.backup_id &&
        HASH.test(meta.sha256 ?? '') && HASH.test(meta.manifest_sha256 ?? '') && proof.sha256===meta.sha256 && proof.manifest_sha256===meta.manifest_sha256;
    });
    const keep=retainedBackupKeys(confirmed);keep.add(currentKey);
    const remove=confirmed.filter(o=>!keep.has(o.key)).map(o=>o.key);
    if(remove.length) {
      await store.delete(remove);
      await store.delete(remove.map(key=>`verified/${KEY.exec(key)![1]}.json`));
    }
    return respond({deleted:remove.length,retained:page.objects.length-remove.length});
  }
  return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
}
