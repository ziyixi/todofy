import test from 'node:test';
import assert from 'node:assert/strict';
import { emailHandler, MAX_RAW_BYTES } from '../src/native/ingest.ts';
import { parseMail, safeHTML, ParseError } from '../src/native/parser.ts';
import { buildPayload, retryAfter } from '../src/native/pipeline.ts';

// A strict test stand-in for workerd's native FixedLengthStream. The integration
// suite independently runs the actual runtime implementation.
globalThis.FixedLengthStream=class extends TransformStream {
  constructor(expected) {
    let seen=0;
    super({transform(chunk,controller) {
      seen+=chunk.byteLength;
      if(seen>expected) throw new Error('length_overflow');
      controller.enqueue(chunk);
    },flush() {if(seen!==expected) throw new Error('length_underflow');}});
  }
};
const fixture='From: Sender <sender@example.org>\r\nTo: inbox@mail.example.org\r\nSubject: Hello 合成\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body\r\n';
const bytes=new TextEncoder().encode(fixture);
function env(options={}) {
  const objects=new Map(),events=[],promises=[];
  const value={RECEIVE_ADDRESS:'inbox@mail.example.org',
    DB:{prepare(){return {first:async()=>{if(options.dbFail)throw new Error('down');return {mode:'forward',revision_id:'revision',logical_bytes:0,logical_limit_bytes:MAX_RAW_BYTES*2};}};}},
    COORDINATOR:{idFromName:name=>name,get:()=>({fetch:async(url,request)=>{events.push(['schedule',JSON.parse(request.body)]);return new Response(null,{status:204});}})},
    MAIL_STORE:{put:async(key,input,metadata)=>{events.push(['put',key]);if(options.putFail)throw new Error('r2 down');const body=typeof input==='string'?new TextEncoder().encode(input):input instanceof ReadableStream?new Uint8Array(await new Response(input).arrayBuffer()):new Uint8Array(input);objects.set(key,{body,...metadata});return {key};}},
  };
  return {value,objects,events,promises,ctx:{waitUntil(p){promises.push(p);}}};
}
function message(raw=bytes,declared=raw.byteLength) {return {to:'inbox@mail.example.org',from:'sender@example.org',raw:new Blob([raw]).stream(),rawSize:declared,setReject(){assert.fail('unexpected permanent rejection');}};}
test('ingest durably schedules before R2, freezes policy, and preserves fallback archive',async()=>{
  for(const dbFail of [false,true]) {
    const e=env({dbFail});await emailHandler(message(),e.value,e.ctx);await Promise.all(e.promises);
    assert.equal(e.events[0][0],'schedule');assert.equal(e.events[1][0],'put');
    const object=[...e.objects.values()][0];assert.equal(object.customMetadata.mode,dbFail?'archive':'forward');
    assert.equal(object.customMetadata.policy_error,dbFail?'policy_unavailable':'');
    assert.deepEqual(object.body,bytes);
  }
});
test('R2 failure aborts the pipe instead of hanging or acknowledging; truncation never stores raw',{timeout:3000},async()=>{
  const e=env({putFail:true});await assert.rejects(emailHandler(message(new Uint8Array(100_000)),e.value,e.ctx),/raw_storage_failed/);
  assert.equal(e.objects.size,0);assert.equal(e.events[0][0],'schedule');
  const truncated=env();await assert.rejects(emailHandler(message(bytes,bytes.byteLength+1),truncated.value,truncated.ctx),/raw_storage_failed/);
  assert.equal(truncated.objects.size,0);
});
test('maintenance refuses ingestion before scheduling or saving',async()=>{
  const e=env();e.value.MAINTENANCE_MODE='true';await assert.rejects(emailHandler(message(),e.value,e.ctx),/maintenance/);assert.equal(e.events.length,0);
});
test('MIME decode, safe HTML, attachment metadata and frozen webhook contract',async()=>{
  const e=env();const parsed=await parseMail(bytes.buffer,e.value,'parsed/test/claim');
  assert.equal(parsed.mail.subject,'Hello 合成');assert.equal(parsed.mail.text,'Synthetic body');
  const html=safeHTML('<p onclick="bad()">Hello<img src="https://tracker/x"><script>bad()</script><a href="javascript:bad()">x</a><a href="https://example.org/">link</a></p>');
  assert.doesNotMatch(html.html,/onclick|img|script|javascript/);assert.match(html.html,/noopener noreferrer/);
  const event=JSON.parse(buildPayload('event','message','2026-09-25T00:00:00.000Z',parsed.mail,'inbox@mail.example.org'));
  assert.equal(event.type,'mail.received.v1');assert.equal(event.event_id,'event');assert.deepEqual(event.message.to,[]);
  assert.equal(event.message.text,'Synthetic body');assert.equal(event.message.sent_at,null);
});
test('MIME budgets reject deep/too many parts without destroying original fixture',async()=>{
  const raw=['Content-Type: multipart/mixed; boundary=b','','',...Array.from({length:201},()=>['--b','Content-Type: text/plain','','body'].join('\r\n')),'--b--',''].join('\r\n');
  await assert.rejects(parseMail(new TextEncoder().encode(raw).buffer,env().value,'parsed/test/claim'),ParseError);
});
test('Retry-After supports seconds/date and never schedules a past date',()=>{
  const time=Date.parse('2026-09-25T00:00:00Z');
  assert.equal(retryAfter('60',time),time+60000);assert.equal(retryAfter('Fri, 25 Sep 2026 00:02:00 GMT',time),time+120000);
  assert.equal(retryAfter('Fri, 25 Sep 2020 00:02:00 GMT',time),time);assert.equal(retryAfter('nonsense',time),null);
});

import { DatabaseSync } from 'node:sqlite';
import { MailCoordinator } from '../src/native/coordinator.ts';
function coordinatorState() {
  const database=new DatabaseSync(':memory:');let alarm=null;
  const state={storage:{
    sql:{exec(query,...values) {
      const statement=database.prepare(query);const rows=statement.columns().length?statement.all(...values):(statement.run(...values),[]);
      return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];},[Symbol.iterator]:()=>rows[Symbol.iterator]()};
    }},
    transactionSync(fn){database.exec('BEGIN');try{const result=fn();database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}},
    async setAlarm(value){alarm=value;},async getAlarm(){return alarm;},
  }};
  return {state,database,get alarm(){return alarm;}};
}
const key1='raw/11111111-1111-4111-8111-111111111111.eml';
const key2='raw/22222222-2222-4222-8222-222222222222.eml';
function internal(path,value) {return new Request('https://coordinator'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});}
test('durable ingress reservation is atomic, idempotent across reconstruction, and caps count/bytes',async()=>{
  const s=coordinatorState(),e={INGEST_DAILY_MESSAGE_LIMIT:'1',INGEST_DAILY_BYTE_LIMIT:'100'};
  let coordinator=new MailCoordinator(s.state,e);
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key1,size:80}))).status,204);
  coordinator=new MailCoordinator(s.state,e);
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key1,size:80}))).status,204);
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key1,size:81}))).status,429);
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key2,size:1}))).status,429);
  assert.equal(s.database.prepare('SELECT count(*) n FROM jobs').get().n,1);
  assert.equal(s.database.prepare('SELECT sum(size) n FROM ingress_reservations').get().n,80);
  assert.ok(s.alarm>Date.now());s.database.close();
});
test('an alarm preserves a newer enqueue while an older job awaits D1',async()=>{
  const s=coordinatorState();let release,started;
  const waiting=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const e={DB:{prepare(){return {bind(){return this;},async first(){started();await waiting;return null;}};}},MAIL_STORE:{get:async()=>null}};
  const coordinator=new MailCoordinator(s.state,e);
  await coordinator.fetch(internal('/enqueue',{type:'parse',key:key1}));
  const running=coordinator.alarm();await entered;
  await coordinator.fetch(internal('/enqueue',{type:'parse',key:key1}));release();await running;
  const job=s.database.prepare('SELECT * FROM jobs').get();assert.equal(job.version,2);assert.equal(job.attempts,1);assert.equal(job.run_started,null);
  assert.ok(job.due<Date.now()+1000,'new immediate intent must not be postponed by prior result');s.database.close();
});
test('three interrupted parse executions stop automatic retry and retain the raw',async()=>{
  const s=coordinatorState(),updates=[];const messageID=key1.slice(4,-4);
  const e={DB:{prepare(sql){return {bind(...values){this.values=values;return this;},async first(){return sql.includes('ingest_receipts')?{message_id:messageID}:{id:messageID,parse_state:'parsing',content_deleted_at:null};},async run(){updates.push([sql,this.values]);return {meta:{changes:1}};}};}},MAIL_STORE:{delete(){assert.fail('interrupted parse must keep raw');}}};
  let coordinator=new MailCoordinator(s.state,e);
  await coordinator.fetch(internal('/enqueue',{type:'parse',key:key1}));
  s.database.prepare('UPDATE jobs SET run_started=?,crashes=2').run(Date.now()-60000);
  coordinator=new MailCoordinator(s.state,e);await coordinator.alarm();
  const job=s.database.prepare('SELECT * FROM jobs').get();assert.equal(job.failed,1);assert.equal(job.error,'processing_interrupted_limit');
  assert.match(updates[0][0],/parse_state='failed'/);assert.match(updates[0][0],/processing_interrupted_limit/);
  await coordinator.fetch(internal('/enqueue',{type:'parse',key:key1}));
  assert.equal(s.database.prepare('SELECT crashes FROM jobs').get().crashes,0);s.database.close();
});

test('byte quota also rejects before R2 upload and accepts no partial reservation',async()=>{
  const s=coordinatorState(),coordinator=new MailCoordinator(s.state,{INGEST_DAILY_MESSAGE_LIMIT:'3',INGEST_DAILY_BYTE_LIMIT:'100'});
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key1,size:80}))).status,204);
  assert.equal((await coordinator.fetch(internal('/reserve-ingest',{key:key2,size:21}))).status,429);
  assert.equal(s.database.prepare('SELECT count(*) n FROM ingress_reservations').get().n,1);
  const e=env();e.value.COORDINATOR.get=()=>({fetch:async()=>new Response(null,{status:429})});
  await assert.rejects(emailHandler(message(),e.value,e.ctx),/daily_ingest_capacity/);assert.equal(e.objects.size,0);
  assert.equal(s.database.prepare('SELECT count(*) n FROM jobs').get().n,1);s.database.close();
});
test('very large Retry-After values become a finite manual pause instead of overflowing Date',()=>{
  const future=retryAfter('99999999999999999999999999');assert.ok(future>Date.now()+86400000);assert.ok(Number.isFinite(Date.parse(new Date(future).toISOString())));
});
