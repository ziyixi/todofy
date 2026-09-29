import type { Env } from './types.ts';
import { backupStatus } from './backup.ts';
import { HttpError } from './security.ts';

const PART_SIZE=16*1024*1024,MAX_SIZE=8*1024*1024*1024,MAX_BACKUP_BYTES=80*1024*1024*1024;
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
function validKey(key:unknown):string {if(typeof key!=='string' || !KEY.test(key) || !UUID.test(KEY.exec(key)![1])) fail(400,'invalid_backup_key');return key as string}
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
}
function metadata(value:Upload):Record<string,string> {return {backup_id:value.backup_id,sha256:value.sha256,manifest_sha256:value.manifest_sha256,created_at:value.created_at}}
/** The independently stored journal survives loss or rollback of the live D1.
 * It deliberately contains only random IDs, scope and timestamps. */
export async function recordDeletion(env:Env,id:string,scope:'raw'|'content',deletedAt:string):Promise<void> {
  if(!env.BACKUP_STORE) return;
  if(!UUID.test(id) || !Number.isFinite(Date.parse(deletedAt))) throw new Error('invalid_deletion_record');
  await env.BACKUP_STORE.put(`deletion-journal/${id}/${scope}.json`,JSON.stringify({id,scope,deleted_at:deletedAt}),{httpMetadata:{contentType:'application/json'}});
}
export function retainedBackupKeys(objects:Array<{key:string;uploaded:Date;customMetadata?:Record<string,string>}>):Set<string> {
  const sorted=objects.filter(o=>KEY.test(o.key) && HASH.test(o.customMetadata?.manifest_sha256 ?? '')).sort((a,b)=>b.uploaded.getTime()-a.uploaded.getTime());
  const keep=new Set<string>(),days=new Set<string>(),weeks=new Set<string>();
  for(const item of sorted) {
    const date=new Date(item.uploaded),day=date.toISOString().slice(0,10);
    // ISO week identity uses the Thursday belonging to this week.
    date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay() || 7));
    const week=`${date.getUTCFullYear()}-${Math.ceil((((date.getTime()-Date.UTC(date.getUTCFullYear(),0,1))/86400000)+1)/7)}`;
    if(!days.has(day) && days.size<7) {days.add(day);keep.add(item.key)}
    if(!weeks.has(week) && weeks.size<4) {weeks.add(week);keep.add(item.key)}
  }
  return keep;
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
    const uploads=await store.list({prefix:'uploads/',limit:4});
    if(uploads.objects.length>=4 || uploads.truncated) fail(409,'backup_upload_cleanup_required');
    const completed=await store.list({prefix:'snapshots/',limit:100});
    if(completed.truncated || completed.objects.length>=14) fail(409,'backup_inventory_requires_review');
    let reserved=0;
    for(const item of uploads.objects) {
      const record=await store.get(item.key),value=record?await record.json<Upload>():null;
      if(!value || !Number.isSafeInteger(value.size_bytes) || value.size_bytes<1 || value.size_bytes>MAX_SIZE) fail(409,'backup_upload_cleanup_required');
      reserved+=value!.size_bytes;
    }
    if(completed.objects.reduce((bytes,object)=>bytes+object.size,0)+reserved+input.size_bytes>MAX_BACKUP_BYTES) fail(409,'backup_capacity_review_required');
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
    const key=validKey(url.searchParams.get('key'));
    const object=request.method==='HEAD'?await store.head(key):await store.get(key);
    if(!object) return fail(404,'backup_artifact_missing');
    return new Response('body' in object?(object as R2ObjectBody).body:null,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':object.customMetadata?.sha256 ?? '',ETag:object.httpEtag}});
  }
  if(action==='list' && request.method==='GET') {
    const page=await store.list({prefix:'snapshots/',limit:100,cursor:url.searchParams.get('cursor') ?? undefined,include:['customMetadata']});
    return respond({objects:page.objects.map(o=>({key:o.key,size:o.size,uploaded:o.uploaded.toISOString(),customMetadata:o.customMetadata ?? {}})),truncated:page.truncated,cursor:page.truncated?page.cursor:null});
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
