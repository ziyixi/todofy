import type { Env, Job } from './types.ts';
import { HttpError, sha256, decryptCredential, validateTarget } from './security.ts';
import { parseMail, ParseError, type ParsedMail } from './parser.ts';
import { MAX_RAW_BYTES, RAW_KEY } from './ingest.ts';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const stamp = (time: number) => new Date(time).toISOString();
const utf8 = new TextEncoder();
const DAY = 86400000;
const claimMS = 5 * 60_000;
const error = (status: number, code: string): never => { throw new HttpError(status, code, code); };
async function first(env: Env, query: string, ...args: any[]): Promise<Row | null> {
  return env.DB.prepare(query).bind(...args).first<Row>();
}
async function all(env: Env, query: string, ...args: any[]): Promise<Row[]> {
  return (await env.DB.prepare(query).bind(...args).all<Row>()).results;
}
export async function reserveIngress(env:Env,key:string,size:number):Promise<void> {
  const response=await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch('https://coordinator/reserve-ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,size})});
  if(!response.ok) throw new Error(response.status===429?'daily_ingest_capacity':'scheduler_unavailable');
}
export async function enqueue(env: Env, job: Job): Promise<void> {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch('https://coordinator/enqueue', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(job),
  });
  if (!response.ok) throw new Error('scheduler_unavailable');
}
export async function wake(env: Env): Promise<void> {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch('https://coordinator/wake', {method:'POST'});
  if (!response.ok) throw new Error('scheduler_unavailable');
}

export interface CreateOptions {
  messageID: string; revisionID: string; eventID?: string; actionID?: string;
  replayOf?: string; retryMode?: 'auto'|'once'; expectedMessageVersion?: number;
}
export function buildPayload(eventID: string, messageID: string, receivedAt: string, parsed: ParsedMail, address: string, currentAddress=address): string {
  if (utf8.encode(parsed.subject).length > 4096 || utf8.encode(parsed.text).length > 256*1024 ||
      parsed.from.length > 50 || parsed.to.length > 50 || parsed.attachments.length > 100 || (!parsed.subject.trim() && !parsed.text.trim())) error(422,'invalid_payload');
  const payload = JSON.stringify({type:'mail.received.v1', event_id:eventID, received_at:receivedAt, message:{
    id:messageID, from:parsed.from.map(a=>({address:a.address,name:a.name ?? ''})),
    to:parsed.to.filter(a=>a.address.toLowerCase() !== address.toLowerCase() && a.address.toLowerCase() !== currentAddress.toLowerCase()).map(a=>({address:a.address,name:a.name ?? ''})),
    subject:parsed.subject, sent_at:parsed.sent_at, rfc_message_id:parsed.rfc_message_id, text:parsed.text,
    attachments:parsed.attachments.map(a=>({filename:a.filename,content_type:a.content_type,size:a.size})),
  }});
  if (utf8.encode(payload).length > 1024*1024) error(422,'invalid_payload');
  return payload;
}
export async function createDelivery(env: Env, options: CreateOptions): Promise<string> {
  if (options.actionID) {
    const existing = await first(env,'SELECT * FROM deliveries WHERE action_request_id=?',options.actionID);
    if (existing) {
      if (existing.message_id!==options.messageID || existing.endpoint_revision_id!==options.revisionID || (existing.replay_of_event_id ?? '')!==(options.replayOf ?? '')) error(409,'action_conflict');
      await enqueue(env,{type:'deliver',eventID:existing.event_id});
      return existing.event_id;
    }
  }
  const message = await first(env,'SELECT * FROM messages WHERE id=?',options.messageID);
  if (!message) error(404,'message_not_found');
  if (message!.content_deleted_at) error(410,'content_deleted');
  if (message!.parse_state!=='ready' || !message!.parsed_key) error(409,'message_not_ready');
  if (options.expectedMessageVersion && options.expectedMessageVersion!==message!.version) error(409,'version_conflict');
  const previous = await first(env,'SELECT COALESCE(MAX(generation),0) AS generation FROM deliveries WHERE message_id=?', options.messageID);
  const generation = Number(previous!.generation) + 1;
  if (!options.replayOf && generation!==1) {
    // Automatic recovery and concurrent generation-one requests return the
    // original identity. Manual requests using a different action conflict.
    const existing=await first(env,'SELECT * FROM deliveries WHERE message_id=? AND generation=1',options.messageID);
    if (!options.actionID && existing) return existing.event_id;
    error(409,'delivery_exists');
  }
  if (options.replayOf && !await first(env,'SELECT event_id FROM deliveries WHERE event_id=? AND message_id=?',options.replayOf,options.messageID)) error(409,'invalid_replay');
  if (!await first(env,'SELECT r.id FROM endpoint_revisions r JOIN webhook_endpoints e ON e.id=r.endpoint_id WHERE r.id=? AND e.archived_at IS NULL',options.revisionID)) error(409,'endpoint_unavailable');
  const object = await env.MAIL_STORE.get(message!.parsed_key);
  if (!object) error(503,'parsed_content_unavailable');
  const parsed = await object!.json<ParsedMail>();
  const eventID = options.eventID ?? crypto.randomUUID();
  let payload = '', payloadError: string | null = null;
  try { if(!options.actionID && parsed.needs_review) payloadError='message_needs_review';
    else payload=buildPayload(eventID,options.messageID,message!.received_at,parsed,message!.envelope_recipient || env.RECEIVE_ADDRESS,env.RECEIVE_ADDRESS); }
  catch (err) {
    if (options.actionID || !(err instanceof HttpError) || err.code!=='invalid_payload') throw err;
    payloadError='invalid_payload';
  }
  const size = utf8.encode(payload).length, hash=await sha256(payload), key=payload ? `payload/${eventID}.json` : null;
  if (key) await env.MAIL_STORE.put(key,payload,{httpMetadata:{contentType:'application/json'}});
  // Schedule before the D1 record. Missing rows are retried, so an interrupted
  // publish is repairable and a successful publication never lacks an alarm.
  await enqueue(env,{type:'deliver',eventID});
  const created=now();
  try {
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,replay_of_event_id,action_request_id,payload_key,payload_sha256,payload_size_bytes,state,retry_mode,next_attempt_at,created_at,last_error)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM messages m WHERE m.id=? AND m.content_deleted_at IS NULL AND m.parse_state='ready' AND m.parsed_key=? AND m.version=?
       AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.generation=?)
       AND EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND logical_bytes+?<=logical_limit_bytes)`)
        .bind(eventID,options.messageID,options.revisionID,generation,options.replayOf ?? null,options.actionID ?? null,key,hash,size,payloadError?'failed':'pending',options.retryMode ?? 'auto',created,created,payloadError,options.messageID,message!.parsed_key,message!.version,generation,size),
      env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_bytes+? WHERE id=1 AND changes()>0').bind(size),
    ]);
    if (!result[0].meta.changes) error(409,'message_changed');
  } catch (err) {
    // A concurrent identical action may have won. Read first; never delete an
    // object whose D1 commit result is uncertain.
    const existing = options.actionID
      ? await first(env,'SELECT * FROM deliveries WHERE action_request_id=?',options.actionID)
      : await first(env,'SELECT * FROM deliveries WHERE message_id=? AND generation=?',options.messageID,generation);
    if (existing && existing.message_id===options.messageID && existing.endpoint_revision_id===options.revisionID && (existing.replay_of_event_id ?? '')===(options.replayOf ?? '')) {
      if (key && existing.event_id!==eventID) await env.MAIL_STORE.delete(key);
      return existing.event_id;
    }
    const published=await first(env,'SELECT event_id FROM deliveries WHERE event_id=?',eventID);
    if(!published && key) await env.MAIL_STORE.delete(key);
    throw err;
  }
  return eventID;
}

async function deleteKeys(env:Env,keys:string[]):Promise<void> {
  const unique=[...new Set(keys)];
  for(let i=0;i<unique.length;i+=200) await env.MAIL_STORE.delete(unique.slice(i,i+200));
}
async function deletePrefix(env:Env,prefix:string):Promise<void> {
  let cursor:string|undefined;
  do {
    const page=await env.MAIL_STORE.list({prefix,cursor,limit:200});
    if(page.objects.length) await env.MAIL_STORE.delete(page.objects.map(o=>o.key));
    cursor=page.truncated?page.cursor:undefined;
  } while(cursor);
}
export async function deleteMessageContent(env:Env,messageID:string,expectedVersion?:number):Promise<void> {
  const message=await first(env,'SELECT * FROM messages WHERE id=?',messageID);
  if(!message) error(404,'message_not_found');
  if(message!.content_deleted_at) { await purgeDeletedContent(env,messageID); return; }
  const version=expectedVersion ?? message!.version;
  const date=now(), deleteMarker=`delete:${crypto.randomUUID()}`;
  // The tombstone wins first. Late parse and queued delivery publications have
  // state predicates and cannot restore content after this transaction.
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET content_deleted_at=?,version=version+1,claim_token=NULL,lease_until=NULL,
      raw_key=NULL,parsed_key=NULL,subject=NULL,from_text=NULL,search_text=NULL,has_attachment=0,
      parse_error=NULL,parsed_size_bytes=0,content_bytes=0 WHERE id=? AND version=? AND content_deleted_at IS NULL`).bind(date,messageID,version),
    env.DB.prepare('INSERT INTO maintenance(id,value) SELECT ?,? WHERE changes()>0').bind(deleteMarker,messageID),
    env.DB.prepare(`UPDATE app_settings SET logical_bytes=max(0,logical_bytes-?-COALESCE((SELECT sum(payload_size_bytes) FROM deliveries WHERE message_id=?),0))
      WHERE id=1 AND EXISTS(SELECT 1 FROM maintenance WHERE id=?)`).bind(message!.content_bytes,messageID,deleteMarker),
    env.DB.prepare(`UPDATE deliveries SET payload_key=NULL,payload_size_bytes=0,state=CASE WHEN state='sending' THEN state WHEN state='delivered' THEN state ELSE 'cancelled' END,
      last_error=CASE WHEN state='sending' THEN 'content_deleted_inflight' ELSE last_error END
      WHERE message_id=? AND EXISTS(SELECT 1 FROM maintenance WHERE id=?)`).bind(messageID,deleteMarker),
    env.DB.prepare('DELETE FROM message_search WHERE message_id=? AND EXISTS(SELECT 1 FROM maintenance WHERE id=?)').bind(messageID,deleteMarker),
    env.DB.prepare('UPDATE delivery_attempts SET response_preview=NULL WHERE event_id IN(SELECT event_id FROM deliveries WHERE message_id=?) AND EXISTS(SELECT 1 FROM maintenance WHERE id=?)').bind(messageID,deleteMarker),
    env.DB.prepare('DELETE FROM maintenance WHERE id=?').bind(deleteMarker),
  ]);
  if(!result[0].meta.changes) error(409,'version_conflict');
  // Purge uses identities rather than cleared pointers so a crash is resumable.
  await purgeDeletedContent(env,messageID);
  await env.DB.prepare('INSERT OR IGNORE INTO maintenance(id,value) VALUES(?,?)').bind(`purged:${messageID}`,now()).run();
}
async function purgeDeletedContent(env:Env,messageID:string):Promise<void> {
  const receipts=await all(env,'SELECT external_id FROM ingest_receipts WHERE message_id=?',messageID);
  await deleteKeys(env,[`raw/${messageID}.eml`,...receipts.map(r=>`raw/${r.external_id}.eml`)]);
  await deletePrefix(env,`parsed/${messageID}/`);
  const events=await all(env,'SELECT event_id FROM deliveries WHERE message_id=?',messageID);
  if(events.length) await deleteKeys(env,events.map(e=>`payload/${e.event_id}.json`));
}

async function registerRaw(env:Env,key:string):Promise<Row|null> {
  const id=RAW_KEY.exec(key)?.[1]; if(!id) return null;
  const receipt=await first(env,'SELECT message_id FROM ingest_receipts WHERE source=\'cloudflare\' AND external_id=?',id);
  if(receipt) {
    const existing=await first(env,'SELECT * FROM messages WHERE id=?',receipt.message_id);
    if(existing && (existing.id!==id || existing.content_deleted_at)) await env.MAIL_STORE.delete(key);
    return existing;
  }
  const object=await env.MAIL_STORE.get(key);
  if(!object) return null;
  const metadata=object.customMetadata ?? {};
  if(object.size>MAX_RAW_BYTES || String(object.size)!==metadata.raw_size || !/^[^\s@]+@[^\s@]+$/.test(metadata.to ?? '') || (metadata.to?.length ?? 0)>254 || !Number.isFinite(Date.parse(metadata.received_at))) {
    // A damaged object must be visible and retain its raw bytes, rather than
    // spending an unlimited alarm budget repeating a deterministic failure.
    const keyHash=await sha256(`invalid-metadata:${key}`),date=now();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO messages(id,ingest_key,origin,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,parse_state,parse_error,content_bytes)
        VALUES(?,?,'cloudflare',?,?,'','',?,?,'archive','failed','raw_metadata_invalid',?)`).bind(id,keyHash,date,date,key,object.size,object.size),
      env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_bytes+? WHERE id=1 AND changes()>0').bind(object.size),
      env.DB.prepare(`INSERT OR IGNORE INTO ingest_receipts(source,external_id,message_id,ingest_key,received_at,created_at) VALUES('cloudflare',?,?,?,?,?)`).bind(id,id,keyHash,date,date),
    ]);
    return first(env,'SELECT * FROM messages WHERE id=?',id);
  }
  const raw=await object.arrayBuffer(), hash=await sha256(raw);
  const ingestKey=await sha256(`${hash}\0${metadata.from ?? ''}\0${metadata.to.toLowerCase()}`);
  let revision=metadata.mode==='forward' && metadata.revision ? metadata.revision : null;
  let policyError=metadata.policy_error || null;
  if(revision && !await first(env,'SELECT id FROM endpoint_revisions WHERE id=?',revision)) { revision=null; policyError='policy_revision_missing'; }
  const date=now(), received=new Date(metadata.received_at).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages(id,ingest_key,origin,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,raw_sha256,size_bytes,receive_mode,endpoint_revision_id,policy_error,content_bytes)
      VALUES(?,?,'cloudflare',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ingest_key) DO NOTHING`).bind(id,ingestKey,received,received,metadata.from ?? '',metadata.to,key,hash,raw.byteLength,revision?'forward':'archive',revision,policyError,raw.byteLength),
    env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_bytes+? WHERE id=1 AND changes()>0').bind(raw.byteLength),
    env.DB.prepare(`INSERT INTO ingest_receipts(source,external_id,message_id,ingest_key,received_at,created_at)
      SELECT 'cloudflare',?,id,?,?,? FROM messages WHERE ingest_key=? ON CONFLICT(source,external_id) DO NOTHING`).bind(id,ingestKey,received,date,ingestKey),
    env.DB.prepare(`UPDATE messages SET arrival_count=arrival_count+1,last_received_at=max(last_received_at,?) WHERE ingest_key=? AND id<>? AND changes()>0`).bind(received,ingestKey,id),
  ]);
  const saved=await first(env,'SELECT * FROM messages WHERE ingest_key=?',ingestKey);
  if(saved && (saved.id!==id || saved.content_deleted_at)) await env.MAIL_STORE.delete(key);
  return saved;
}
async function parseJob(env:Env,key:string,attempts=0):Promise<number|null> {
  const message=await registerRaw(env,key);
  if(!message) return Date.now()+Math.min(6*3600_000,30_000*2**Math.min(attempts,10));
  if(message.content_deleted_at) { await purgeDeletedContent(env,message.id); return null; }
  if(message.parse_state==='ready') {
    if(message.receive_mode==='forward' && message.endpoint_revision_id && !await first(env,'SELECT event_id FROM deliveries WHERE message_id=?',message.id)) {
      await createDelivery(env,{messageID:message.id,revisionID:message.endpoint_revision_id});
    }
    return null;
  }
  if(message.parse_state==='failed') return null;
  const token=crypto.randomUUID(), date=now();
  const claimed=await env.DB.prepare(`UPDATE messages SET parse_state='parsing',claim_token=?,lease_until=? WHERE id=? AND content_deleted_at IS NULL
    AND (parse_state='pending' OR (parse_state='parsing' AND lease_until<?))`).bind(token,stamp(Date.now()+claimMS),message.id,date).run();
  if(!claimed.meta.changes) return Date.parse(message.lease_until ?? stamp(Date.now()+claimMS));
  const prefix=`parsed/${message.id}/${token}`;
  try {
    const raw=await env.MAIL_STORE.get(message.raw_key);
    if(!raw || raw.size!==message.size_bytes) throw new ParseError('raw_content_unavailable');
    const parsed=await parseMail(await raw.arrayBuffer(),env,prefix);
    const json=JSON.stringify(parsed.mail), parsedKey=`${prefix}/message.json`, jsonSize=utf8.encode(json).length;
    await env.MAIL_STORE.put(parsedKey,json,{httpMetadata:{contentType:'application/json'}});
    const fullSearch=`${parsed.mail.subject}\n${parsed.mail.from.map(a=>`${a.name} ${a.address}`).join(' ')}\n${parsed.mail.text}`.toLocaleLowerCase();
    const searchBytes=utf8.encode(fullSearch), truncated=searchBytes.length>16384;
    const search=new TextDecoder().decode(searchBytes.subarray(0,16384));
    const contentBytes=message.size_bytes+jsonSize+parsed.bytes;
    const statements=[
      env.DB.prepare(`UPDATE messages SET parse_state='ready',parsed_key=?,parsed_size_bytes=?,content_bytes=?,parser_version='postal-mime-v1',
        subject=?,from_text=?,search_text=?,has_attachment=?,search_index_truncated=?,parse_error=NULL,claim_token=NULL,lease_until=NULL,version=version+1
        WHERE id=? AND claim_token=? AND content_deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND logical_bytes+?<=logical_limit_bytes)`).bind(parsedKey,jsonSize,contentBytes,parsed.mail.subject,parsed.mail.from.map(a=>a.name?`${a.name} <${a.address}>`:a.address).join(', '),search.slice(0,2000),parsed.mail.attachments.length?1:0,truncated?1:0,message.id,token,contentBytes-message.content_bytes),
      env.DB.prepare('UPDATE app_settings SET logical_bytes=max(0,logical_bytes+?) WHERE id=1 AND changes()>0').bind(contentBytes-message.content_bytes),
      env.DB.prepare('DELETE FROM message_search WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND parsed_key=?)').bind(message.id,message.id,parsedKey),
    ];
    // Overlap preserves substring searches crossing a chunk boundary; each row
    // stays well below D1's 2 MB row cap, including non-ASCII UTF-8 text.
    for(let offset=0,index=0;offset<search.length;offset+=32000,index++) statements.push(env.DB.prepare(`INSERT INTO message_search(message_id,chunk_no,body)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND parsed_key=? AND content_deleted_at IS NULL)`).bind(message.id,index,search.slice(offset,offset+32200),message.id,parsedKey));
    const result=await env.DB.batch(statements);
    if(!result[0].meta.changes) {
      await env.DB.prepare("UPDATE messages SET parse_state='failed',parse_error='logical_capacity',claim_token=NULL,lease_until=NULL WHERE id=? AND claim_token=? AND content_deleted_at IS NULL").bind(message.id,token).run();
      await deletePrefix(env,prefix+'/'); return null;
    }
    if(message.parsed_key) await deletePrefix(env,message.parsed_key.slice(0,message.parsed_key.lastIndexOf('/')+1));
    if(message.receive_mode==='forward' && message.endpoint_revision_id) await createDelivery(env,{messageID:message.id,revisionID:message.endpoint_revision_id});
    return null;
  } catch(err) {
    if(err instanceof ParseError) {
      await env.DB.prepare(`UPDATE messages SET parse_state='failed',parse_error=?,claim_token=NULL,lease_until=NULL,version=version+1 WHERE id=? AND claim_token=? AND content_deleted_at IS NULL`).bind(err.message,message.id,token).run();
      await deletePrefix(env,prefix+'/');
      return null;
    }
    // Storage failures retain the lease and immutable content for later recovery.
    throw err;
  }
}

export async function createSyntheticTestDelivery(env:Env,revisionID:string,actionID:string):Promise<string> {
  const old=await first(env,'SELECT event_id FROM deliveries WHERE action_request_id=?',actionID);
  if(old) return old.event_id;
  // Deterministic identity lets a retry resume after raw/D1 publication but
  // before the API received its result. This is synthetic content only.
  const hash=await sha256(`synthetic:${actionID}`);
  const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const date=now(), key=`parsed/${id}/synthetic/message.json`;
  const parsed:ParsedMail={subject:'Mail Hero webhook test',text:'This is a synthetic Mail Hero connection test.',html:'',from:[{address:'synthetic@example.org',name:'Mail Hero'}],to:[],cc:[],reply_to:[],sent_at:null,rfc_message_id:null,headers:[],attachments:[],needs_review:false,warnings:[]};
  const content=JSON.stringify(parsed), size=utf8.encode(content).length;
  await env.MAIL_STORE.put(key,content,{httpMetadata:{contentType:'application/json'}});
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO messages(id,origin,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,parse_state,parsed_key,parsed_size_bytes,content_bytes,subject,from_text)
      SELECT ?,'synthetic_test',?,?,'synthetic@example.org','',0,'archive','ready',?,?,?,?,'Mail Hero' WHERE EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND logical_bytes+?<=logical_limit_bytes)`).bind(id,date,date,key,size,size,parsed.subject,size),
    env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_bytes+? WHERE id=1 AND changes()>0').bind(size),
  ]);
  return createDelivery(env,{messageID:id,revisionID,actionID,retryMode:'once'});
}

export function retryAfter(value:string|null,time=Date.now()):number|null {
  if(!value) return null;
  if(/^\d+$/.test(value.trim())) {
    const seconds=Number(value);
    // Extremely large valid delays pause the endpoint; they must not overflow
    // Date and accidentally turn a configuration pause into repeated sends.
    if(!Number.isFinite(seconds) || seconds>86400) return time+2*DAY;
    return time+seconds*1000;
  }
  const parsed=Date.parse(value); return Number.isFinite(parsed)?Math.max(time,parsed):null;
}
async function deliverJob(env:Env,eventID:string,attempts=0):Promise<number|null> {
  const row=await first(env,`SELECT d.*,m.content_deleted_at,r.url,r.auth_type,r.credential_ciphertext,r.credential_key_id,r.timeout_ms,
    r.blocked_reason,e.id endpoint_id,e.paused,e.archived_at,e.rate_per_minute,e.next_send_at endpoint_next,
    s.send_paused,s.next_send_at global_next FROM deliveries d JOIN messages m ON m.id=d.message_id
    JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id JOIN webhook_endpoints e ON e.id=r.endpoint_id
    JOIN app_settings s ON s.id=1 WHERE d.event_id=?`,eventID);
  if(!row) return Date.now()+Math.min(6*3600_000,30_000*2**Math.min(attempts,10));
  if(['delivered','failed','cancelled'].includes(row.state)) return null;
  if(row.state==='sending') {
    if(row.lease_until && Date.parse(row.lease_until)>Date.now()) return Date.parse(row.lease_until);
    const date=now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE delivery_attempts SET finished_at=?,outcome='interrupted',error_code='result_unknown' WHERE event_id=? AND finished_at IS NULL
        AND EXISTS(SELECT 1 FROM deliveries WHERE event_id=? AND state='sending' AND (lease_until IS NULL OR lease_until<=?))`).bind(date,eventID,eventID,date),
      env.DB.prepare(`UPDATE deliveries SET state=CASE WHEN payload_key IS NULL THEN 'cancelled' WHEN retry_mode='once' THEN 'failed' ELSE 'retry_wait' END,
        last_error='result_unknown',claim_token=NULL,lease_until=NULL,next_attempt_at=? WHERE event_id=? AND state='sending' AND (lease_until IS NULL OR lease_until<=?)`).bind(stamp(Date.now()+30_000),eventID,date),
    ]);
    return Date.now()+30_000;
  }
  if(row.content_deleted_at || !row.payload_key) {
    await env.DB.prepare(`UPDATE deliveries SET state='cancelled',last_error='content_deleted' WHERE event_id=? AND state IN('pending','retry_wait')`).bind(eventID).run();
    return null;
  }
  if(env.FORCE_SEND_PAUSED==='true' || env.FORCE_SEND_PAUSED==='1' || row.send_paused || row.paused || row.archived_at || row.blocked_reason) return null;
  const age=Date.now()-Date.parse(row.created_at);
  if((row.retry_mode==='auto' && (age>=7*DAY || row.attempt_count>=48)) || age>=30*DAY) {
    await env.DB.prepare(`UPDATE deliveries SET state='failed',last_error='retry_window_expired' WHERE event_id=? AND state IN('pending','retry_wait')`).bind(eventID).run();
    return null;
  }
  const due=Math.max(Date.parse(row.next_attempt_at),row.endpoint_next?Date.parse(row.endpoint_next):0,row.global_next?Date.parse(row.global_next):0);
  if(due>Date.now()) return due;
  let headers:Headers,target:URL;
  try {
    target=validateTarget(env,row.url);
    if(!row.credential_ciphertext || !['bearer','basic'].includes(row.auth_type)) throw new Error('credential_invalid');
    const credential=await decryptCredential(env,row.endpoint_revision_id,row.url,row.credential_ciphertext);
    if(!credential || /[\r\n]/.test(credential)) throw new Error('credential_invalid');
    // Identify the webhook client explicitly; some public ingress filters reject
    // an absent/default User-Agent before the consumer receives authentication.
    headers=new Headers({'Content-Type':'application/json','Idempotency-Key':eventID,'User-Agent':'MailHero/1.0'});
    if(row.auth_type==='bearer') headers.set('Authorization',`Bearer ${credential}`);
    else {
      if(!credential.includes(':')) throw new Error('credential_invalid');
      let binary=''; for(const b of utf8.encode(credential)) binary+=String.fromCharCode(b);
      headers.set('Authorization',`Basic ${btoa(binary)}`);
    }
    if(env.ACCESS_SERVICE_ORIGIN && target.origin===new URL(env.ACCESS_SERVICE_ORIGIN).origin) {
      if(new URL(env.ACCESS_SERVICE_ORIGIN).protocol!=='https:' || !env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) throw new Error('service_auth_invalid');
      headers.set('CF-Access-Client-Id',env.ACCESS_CLIENT_ID); headers.set('CF-Access-Client-Secret',env.ACCESS_CLIENT_SECRET);
    }
  } catch {
    await env.DB.batch([
      env.DB.prepare(`UPDATE endpoint_revisions SET blocked_reason='credential_or_target_invalid' WHERE id=?`).bind(row.endpoint_revision_id),
      env.DB.prepare(`UPDATE deliveries SET last_error='credential_or_target_invalid' WHERE event_id=?`).bind(eventID),
    ]);
    return null;
  }
  const object=await env.MAIL_STORE.get(row.payload_key);
  if(!object) throw new Error('payload_unavailable');
  const payload=await object.arrayBuffer();
  if(await sha256(payload)!==row.payload_sha256) {
    await env.DB.prepare(`UPDATE deliveries SET state='failed',last_error='payload_integrity' WHERE event_id=? AND state IN('pending','retry_wait')`).bind(eventID).run();
    return null;
  }
  const token=crypto.randomUUID(), date=now(), attemptID=crypto.randomUUID();
  const claimed=await env.DB.batch([
    env.DB.prepare(`UPDATE deliveries SET state='sending',claim_token=?,lease_until=?,attempt_count=attempt_count+1 WHERE event_id=?
      AND state IN('pending','retry_wait') AND next_attempt_at<=? AND payload_key IS NOT NULL
      AND EXISTS(SELECT 1 FROM messages WHERE id=deliveries.message_id AND content_deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM endpoint_revisions r JOIN webhook_endpoints e ON e.id=r.endpoint_id WHERE r.id=deliveries.endpoint_revision_id AND r.blocked_reason IS NULL AND e.paused=0 AND e.archived_at IS NULL AND (e.next_send_at IS NULL OR e.next_send_at<=?))
      AND EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND send_paused=0 AND (next_send_at IS NULL OR next_send_at<=?))`).bind(token,stamp(Date.now()+claimMS),eventID,date,date,date),
    env.DB.prepare(`UPDATE webhook_endpoints SET next_send_at=? WHERE id=? AND EXISTS(SELECT 1 FROM deliveries WHERE event_id=? AND claim_token=?)`).bind(stamp(Date.now()+Math.ceil(60_000/row.rate_per_minute)),row.endpoint_id,eventID,token),
    env.DB.prepare(`UPDATE app_settings SET next_send_at=? WHERE id=1 AND EXISTS(SELECT 1 FROM deliveries WHERE event_id=? AND claim_token=?)`).bind(stamp(Date.now()+6000),eventID,token),
    env.DB.prepare(`INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,credential_key_id) SELECT ?,event_id,attempt_count,?,? FROM deliveries WHERE event_id=? AND claim_token=?`).bind(attemptID,date,row.credential_key_id,eventID,token),
  ]);
  if(!claimed[0].meta.changes) return Date.now()+6000;
  // Last check after loading content/decrypting: mutations during those awaits
  // must stop an unstarted HTTP request. A later in-flight delete is not recall.
  const allowed=await first(env,`SELECT d.event_id FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id
    JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1 WHERE d.event_id=? AND d.claim_token=? AND d.state='sending'
    AND m.content_deleted_at IS NULL AND s.send_paused=0 AND e.paused=0 AND e.archived_at IS NULL AND r.blocked_reason IS NULL`,eventID,token);
  if(!allowed || env.MAINTENANCE_MODE==='true') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE delivery_attempts SET finished_at=?,outcome='not_sent',error_code='state_changed' WHERE id=?`).bind(now(),attemptID),
      env.DB.prepare(`UPDATE deliveries SET state=CASE WHEN payload_key IS NULL THEN 'cancelled' ELSE 'retry_wait' END,last_error='state_changed',claim_token=NULL,lease_until=NULL WHERE event_id=? AND claim_token=?`).bind(eventID,token),
    ]);
    return null;
  }
  let status:number|null=null, code='network_error', responseAfter:number|null=null;
  const start=Date.now();
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),Math.min(row.timeout_ms,120_000));
  try {
    const response=await fetch(target!,{method:'POST',headers:headers!,body:payload,redirect:'manual',signal:controller.signal});
    status=response.status; responseAfter=retryAfter(response.headers.get('Retry-After')); code=`http_${status}`;
    // Response bodies are untrusted, unneeded for the acknowledgement contract,
    // and can echo credentials. Never retain them in the mail UI or logs.
    await response.body?.cancel();
  } catch { code=controller.signal.aborted?'timeout':'network_error'; }
  finally { clearTimeout(timer); }
  const success=status!==null && status>=200 && status<300;
  const transient=status===null || status===408 || status===429 || status>=500;
  const blocked=status!==null && ([401,403,404,405].includes(status) || (status>=300 && status<400));
  const attempt=Number(row.attempt_count)+1;
  const backoff=Math.min(6*3600_000,30_000*Math.pow(2,Math.min(attempt-1,16)))*(0.8+Math.random()*0.4);
  const next=Math.max(Date.now()+Math.round(backoff),responseAfter ?? 0);
  let state=success?'delivered':transient && row.retry_mode==='auto' && attempt<48 && next<Date.parse(row.created_at)+7*DAY?'retry_wait':'failed';
  if(blocked) state='retry_wait';
  const finished=now();
  const statements=[
    env.DB.prepare(`UPDATE delivery_attempts SET finished_at=?,http_status=?,duration_ms=?,outcome=?,error_code=? WHERE id=? AND finished_at IS NULL`).bind(finished,status,Date.now()-start,success?'delivered':transient?'retryable':'rejected',success?null:code,attemptID),
    env.DB.prepare(`UPDATE deliveries SET state=CASE WHEN payload_key IS NULL AND ?<>'delivered' THEN 'cancelled' ELSE ? END,delivered_at=?,last_error=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL WHERE event_id=? AND claim_token=?`).bind(state,state,success?finished:null,success?null:code,stamp(next),eventID,token),
  ];
  if(blocked) statements.push(env.DB.prepare('UPDATE endpoint_revisions SET blocked_reason=? WHERE id=?').bind(code,row.endpoint_revision_id));
  if(!success && responseAfter!==null) {
    if(responseAfter>Date.now()+DAY) statements.push(env.DB.prepare(`UPDATE webhook_endpoints SET paused=1,paused_reason='retry_after_over_24h',version=version+1,updated_at=? WHERE id=?`).bind(finished,row.endpoint_id));
    else statements.push(env.DB.prepare('UPDATE webhook_endpoints SET next_send_at=max(COALESCE(next_send_at,?),?) WHERE id=?').bind(finished,stamp(responseAfter),row.endpoint_id));
  }
  await env.DB.batch(statements);
  return state==='retry_wait' && !blocked && !(responseAfter!==null && responseAfter>Date.now()+DAY)?next:null;
}

export async function runJob(env:Env,job:Job,attempts=0):Promise<number|null> {
  if(env.MAINTENANCE_MODE==='true') return Date.now()+DAY;
  return job.type==='parse'?parseJob(env,job.key,attempts):deliverJob(env,job.eventID,attempts);
}

/** Low-frequency repair, never mailbox polling. Only one bounded page of raw
 * keys and D1 work is inspected per maintenance pass. */
export async function runMaintenance(env:Env):Promise<{jobs:Job[];continueSoon:boolean}> {
  if(env.MAINTENANCE_MODE==='true') return {jobs:[],continueSoon:false};
  let continueSoon=false;
  const jobs:Job[]=[];
  const messages=await all(env,`SELECT raw_key FROM messages WHERE content_deleted_at IS NULL AND raw_key IS NOT NULL
    AND (parse_state='pending' OR (parse_state='parsing' AND lease_until<=?) OR (parse_state='ready' AND receive_mode='forward'
    AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=messages.id))) ORDER BY received_at LIMIT 100`,now());
  for(const message of messages) jobs.push({type:'parse',key:message.raw_key});
  const deliveries=await all(env,`SELECT d.event_id FROM deliveries d JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id
    JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1 WHERE
    d.state='sending' OR (d.state IN('pending','retry_wait') AND e.paused=0 AND r.blocked_reason IS NULL AND e.archived_at IS NULL AND s.send_paused=0)
    ORDER BY d.next_attempt_at LIMIT 100`);
  for(const delivery of deliveries) jobs.push({type:'deliver',eventID:delivery.event_id});
  const cursor=(await first(env,`SELECT value FROM maintenance WHERE id='raw_reconcile_cursor'`))?.value;
  const raw=await env.MAIL_STORE.list({prefix:'raw/',cursor:cursor || undefined,limit:100});
  const candidates=raw.objects.map(o=>({id:RAW_KEY.exec(o.key)?.[1],key:o.key})).filter(o=>o.id);
  if(candidates.length) {
    const known=await all(env,`SELECT i.external_id,i.message_id,m.content_deleted_at FROM ingest_receipts i JOIN messages m ON m.id=i.message_id WHERE i.external_id IN(${candidates.map(()=>'?').join(',')})`,...candidates.map(o=>o.id));
    const seen=new Set(known.map(row=>row.external_id)),deletedKeys:string[]=[];
    const deletedIDs=new Set(known.filter(row=>row.content_deleted_at || row.message_id!==row.external_id).map(row=>row.external_id));
    for(const object of candidates) {
      if(!seen.has(object.id)) jobs.push({type:'parse',key:object.key});
      else if(deletedIDs.has(object.id)) deletedKeys.push(object.key);
    }
    if(deletedKeys.length) await env.MAIL_STORE.delete(deletedKeys);
  }
  await env.DB.prepare(`INSERT INTO maintenance(id,value) VALUES('raw_reconcile_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).bind(raw.truncated?raw.cursor:'').run();
  const retention=await first(env,'SELECT retention_days FROM app_settings WHERE id=1');
  if(retention?.retention_days) {
    const expired=await all(env,`SELECT id,version FROM messages WHERE origin='cloudflare' AND content_deleted_at IS NULL AND parse_state='ready' AND received_at<?
      AND (receive_mode='archive' OR EXISTS(SELECT 1 FROM deliveries WHERE message_id=messages.id AND state='delivered'))
      AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=messages.id AND state<>'delivered') ORDER BY received_at LIMIT 1`,stamp(Date.now()-retention.retention_days*DAY));
    continueSoon=expired.length===1;
    for(const message of expired) { try { await deleteMessageContent(env,message.id,message.version); } catch(err) { if(!(err instanceof HttpError) || err.status!==409) throw err; } }
  }
  // Tombstones make repeated purge safe. Cycle pages to finish after crashes.
  const deleted=await all(env,`SELECT id FROM messages WHERE content_deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM maintenance WHERE id='purged:'||messages.id) LIMIT 1`);
  for(const message of deleted) {
    await purgeDeletedContent(env,message.id);
    await env.DB.prepare(`INSERT OR IGNORE INTO maintenance(id,value) VALUES(?,?)`).bind(`purged:${message.id}`,now()).run();
  }
  await collectOrphans(env);
  return {jobs,continueSoon:continueSoon || deleted.length===1 || raw.truncated};
}

async function collectOrphans(env:Env):Promise<void> {
  for(const prefix of ['parsed/','payload/']) {
    const cursorID=`gc:${prefix}`,cursor=(await first(env,'SELECT value FROM maintenance WHERE id=?',cursorID))?.value;
    const page=await env.MAIL_STORE.list({prefix,cursor:cursor || undefined,limit:50});
    const candidates=page.objects.filter(object=>Date.now()-object.uploaded.getTime()>3600_000);
    const ids=[...new Set(candidates.map(object=>prefix==='parsed/'?object.key.split('/')[1]:object.key.slice(8,-5)))];
    if(ids.length) {
      const rows=await all(env,prefix==='parsed/'
        ?`SELECT id,parsed_key,claim_token,lease_until,content_deleted_at FROM messages WHERE id IN(${ids.map(()=>'?').join(',')})`
        :`SELECT event_id id,payload_key FROM deliveries WHERE event_id IN(${ids.map(()=>'?').join(',')})`,...ids);
      const records=new Map(rows.map(row=>[row.id,row]));
      const remove=candidates.filter(object=>{
        if(prefix==='payload/') return records.get(object.key.slice(8,-5))?.payload_key!==object.key;
        const parts=object.key.split('/'),record=records.get(parts[1]);
        if(!record || record.content_deleted_at) return true;
        if(record.parsed_key?.startsWith(`${parts.slice(0,3).join('/')}/`)) return false;
        return !(record.claim_token===parts[2] && Date.parse(record.lease_until)>Date.now());
      }).map(object=>object.key);
      if(remove.length) await env.MAIL_STORE.delete(remove);
    }
    await env.DB.prepare('INSERT INTO maintenance(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(cursorID,page.truncated?page.cursor:'').run();
  }
}

export async function markInterruptedJob(env:Env,job:Job):Promise<void> {
  if(job.type!=='parse') return;
  const message=await registerRaw(env,job.key);
  if(!message) return;
  await env.DB.prepare("UPDATE messages SET parse_state='failed',parse_error='processing_interrupted_limit',claim_token=NULL,lease_until=NULL,version=version+1 WHERE id=? AND parse_state IN('pending','parsing') AND content_deleted_at IS NULL").bind(message.id).run();
}
