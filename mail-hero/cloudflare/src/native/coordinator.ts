import type { Env, Job } from './types.ts';
import { handleDeliveryRequest, runJob, runMaintenance, markInterruptedJob } from './pipeline.ts';
import { CapacityLedger, MAX_PARSE_EXTRA_BYTES } from './capacity.ts';
import { BackupState, readIntakePolicy } from './backup-state.ts';
import { OpsGuardStore } from './ops-guard.ts';
import { DELEGATED_PREFIX, handleDelegated } from './api.ts';

const DAY=86400000;
const WAIT=30_000;
interface StoredJob { [key:string]:SqlStorageValue; id:string; payload:string; due:number; attempts:number; created:number; error:string|null; failed:number; version:number; run_started:number|null; crashes:number }
function jobID(job:Job):string { return job.type==='parse'?`parse:${job.key}`:`deliver:${job.eventID}`; }
function validJob(value:unknown):value is Job {
  if(!value || typeof value!=='object') return false;
  const job=value as Record<string,unknown>;
  return (job.type==='parse' && typeof job.key==='string' && /^raw\/[0-9a-f-]{36}\.eml$/i.test(job.key)) ||
    (job.type==='deliver' && typeof job.eventID==='string' && /^[0-9a-f-]{36}$/i.test(job.eventID));
}
/** A SQLite-backed Durable Object is the durable scheduler, not the content DB.
 * Only alarms perform background work. fetch records intents or wakes it, creates the delivery a Worker request
 * asks for (/deliveries/create: building an event takes more CPU than a Worker request has on Workers Free), and answers
 * the owner API's two heavy reads for the same reason (api.ts DELEGATED). */
export class MailCoordinator {
  private readonly state:DurableObjectState;
  private readonly env:Env;
  private running=false;
  private readonly capacity:CapacityLedger;
  private readonly backup:BackupState;
  private readonly ops:OpsGuardStore;
  constructor(state:DurableObjectState,env:Env) {
    this.state=state; this.env=env;
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,error TEXT,failed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,run_started INTEGER,crashes INTEGER NOT NULL DEFAULT 0)`);
    const columns=new Set(state.storage.sql.exec<{name:string}>('PRAGMA table_info(jobs)').toArray().map(column=>column.name));
    for(const [name,definition] of [['version','INTEGER NOT NULL DEFAULT 1'],['run_started','INTEGER'],['crashes','INTEGER NOT NULL DEFAULT 0']]) {
      if(!columns.has(name)) state.storage.sql.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS ingress_reservations(id TEXT PRIMARY KEY,day TEXT NOT NULL,size INTEGER NOT NULL)');
    state.storage.sql.exec('CREATE INDEX IF NOT EXISTS ingress_day ON ingress_reservations(day)');
    state.storage.sql.exec('CREATE INDEX IF NOT EXISTS jobs_due ON jobs(failed,due)');
    // Picking the next job reads one row instead of sorting every due job by id.
    state.storage.sql.exec('CREATE INDEX IF NOT EXISTS jobs_due_id ON jobs(failed,due,id)');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    state.storage.sql.exec('INSERT OR IGNORE INTO control(id,value) VALUES(1,?)',Date.now()+DAY);
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS intake_control(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    state.storage.sql.exec('INSERT OR IGNORE INTO intake_control VALUES(1,0)');
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ingest_uploads(key TEXT PRIMARY KEY,seq INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL,policy TEXT NOT NULL,created INTEGER NOT NULL,settled INTEGER)`);
    // Backup status (read by every repair pass) counts only unsettled uploads,
    // not the whole intake history kept after a completed snapshot.
    state.storage.sql.exec('CREATE INDEX IF NOT EXISTS ingest_uploads_status ON ingest_uploads(status,seq)');
    this.capacity=new CapacityLedger(state.storage,env);
    this.backup=new BackupState(state.storage,env,()=>this.running);
    this.ops=new OpsGuardStore(state.storage.sql);
  }
  private insert(job:Job,time=Date.now()):void {
    this.state.storage.sql.exec(`INSERT INTO jobs(id,payload,due,created) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET due=min(jobs.due,excluded.due),version=jobs.version+1,crashes=CASE WHEN jobs.failed=1 THEN 0 ELSE jobs.crashes END,failed=0,error=NULL`,jobID(job),JSON.stringify(job),time,Date.now());
  }
  private async schedule():Promise<void> {
    const job=this.state.storage.sql.exec<{due:number|null}>('SELECT min(due) due FROM jobs WHERE failed=0').one();
    const maintenance=this.state.storage.sql.exec<{value:number}>('SELECT value FROM control WHERE id=1').one().value;
    const receiptRetry=this.backup.current()?.receipt_sync_pending ? Date.now()+60_000 : Number.POSITIVE_INFINITY;
    const due=this.backup.nextExpiry() ?? (this.env.MAINTENANCE_MODE==='true'?Date.now()+DAY:Math.min(job.due ?? maintenance,maintenance,receiptRetry));
    await this.state.storage.setAlarm(Math.max(Date.now()+1000,due));
  }
  async fetch(request:Request):Promise<Response> {
    const path=new URL(request.url).pathname;
    // The owner API's heavy reads, which the Worker forwards after authentication (api.ts DELEGATED).
    if(path.startsWith(DELEGATED_PREFIX+'/')) return handleDelegated(request,this.env);
    if (path==='/mutation/begin' || path==='/backup/begin') {
      try { await this.capacity.initialize(); } catch { await this.state.storage.setAlarm(Date.now()+1000); return new Response(null,{status:503}); }
    }
    const backupResponse=await this.backup.fetch(request);
    if(backupResponse) { await this.schedule(); return backupResponse; }
    if(path.startsWith('/capacity/')) {
      try {
        await this.capacity.initialize();
        if(path==='/capacity/reconcile' && request.method==='POST') {
          if(this.backup.paused() || this.backup.status().active_writers || this.state.storage.sql.exec<{n:number}>('SELECT count(*) n FROM jobs WHERE run_started IS NOT NULL').one().n) return new Response(null,{status:409});
          return Response.json(await this.capacity.reconcileAbandoned());
        }
        if(path==='/capacity/status' && request.method==='GET') return Response.json(this.capacity.snapshot());
        if(request.method!=='POST') return new Response(null,{status:405});
        const input=await request.json() as {key?:unknown;bytes?:unknown;legacy_bytes?:unknown;release_key?:unknown};
        const bytes=input.bytes ?? 0,legacy=input.legacy_bytes ?? 0;
        if(typeof input.key!=='string' || input.key.length<1 || input.key.length>512 ||
          !Number.isSafeInteger(bytes) || Number(bytes)<0 || !Number.isSafeInteger(legacy) || Number(legacy)<0 ||
          (input.release_key!==undefined && (typeof input.release_key!=='string' || input.release_key.length>512))) return new Response(null,{status:400});
        const accepted=this.state.storage.transactionSync(()=>{
          if(path==='/capacity/reserve') return this.capacity.reserve(input.key as string,Number(bytes));
          if(path==='/capacity/settle') return this.capacity.settle(input.key as string,Number(bytes),Number(legacy),input.release_key as string|undefined);
          if(path==='/capacity/release') {
            this.capacity.release(input.key as string,Number(legacy));
            this.state.storage.sql.exec("UPDATE ingest_uploads SET status='deleted',settled=? WHERE key=? AND status='uploading'",Date.now(),input.key as string);
            return true;
          }
          return false;
        });
        return new Response(null,{status:accepted?204:429});
      } catch { await this.state.storage.setAlarm(Date.now()+5000); return new Response(null,{status:503}); }
    }
    if(path==='/ingest/settle' && request.method==='POST') {
      const input=await request.json() as {key?:unknown;saved?:unknown};
      if(typeof input.key!=='string' || typeof input.saved!=='boolean') return new Response(null,{status:400});
      const upload=this.state.storage.sql.exec<{seq:number;status:string}>('SELECT seq,status FROM ingest_uploads WHERE key=?',input.key).toArray()[0];
      if(!upload) return new Response(null,{status:404});
      if(upload.status!=='uploading') return new Response(null,{status:204});
      const object=await this.env.MAIL_STORE.head(input.key);
      if(object && object.customMetadata?.ingest_seq!==String(upload.seq)) return new Response(null,{status:409});
      if(input.saved && !object) return new Response(null,{status:503});
      this.state.storage.transactionSync(()=>{
        this.state.storage.sql.exec('UPDATE ingest_uploads SET status=?,settled=? WHERE key=? AND status=\'uploading\'',object?'saved':'failed',Date.now(),input.key as string);
        if(!object) this.capacity.release(input.key as string,0);
      });
      await this.schedule(); return new Response(null,{status:204});
    }
    if(path==='/reserve-ingest' && request.method==='POST') {
      const input=await request.json() as {key?:unknown;size?:unknown};
      if(typeof input.key!=='string' || !validJob({type:'parse',key:input.key}) || !Number.isSafeInteger(input.size) || (input.size as number)<1 || (input.size as number)>25*1024*1024) return new Response(null,{status:400});
      const countLimit=Number(this.env.INGEST_DAILY_MESSAGE_LIMIT ?? 300),bytesLimit=Number(this.env.INGEST_DAILY_BYTE_LIMIT ?? 256*1024*1024);
      if(!Number.isSafeInteger(countLimit) || countLimit<1 || !Number.isSafeInteger(bytesLimit) || bytesLimit<1) return new Response(null,{status:503});
      try { await this.capacity.initialize(); } catch { await this.state.storage.setAlarm(Date.now()+1000); return new Response(null,{status:503}); }
      let policy=this.backup.frozenPolicy();
      if(!policy) {
        try { policy=await readIntakePolicy(this.env); }
        catch { policy={mode:'archive',revision:'',policy_error:'policy_unavailable',lifecycle_policy_version:null,raw_retention_days:null,content_retention_days:null,ledger_retention_days:null}; }
      }
      // A snapshot may have acquired its cut while this D1 read yielded.
      policy=this.backup.frozenPolicy() ?? policy;
      const day=new Date().toISOString().slice(0,10);
      const accepted=this.state.storage.transactionSync(()=>{
        const old=this.state.storage.sql.exec<{size:number}>('SELECT size FROM ingress_reservations WHERE id=?',input.key as string).toArray()[0];
        if(old) return old.size===input.size && this.state.storage.sql.exec<{status:string}>('SELECT status FROM ingest_uploads WHERE key=?',input.key as string).toArray()[0]?.status!=='failed';
        const usage=this.state.storage.sql.exec<{count:number;bytes:number}>('SELECT count(*) count,COALESCE(sum(size),0) bytes FROM ingress_reservations WHERE day=?',day).one();
        if(usage.count>=countLimit || usage.bytes+(input.size as number)>bytesLimit) return false;
        if(!this.capacity.reserve(input.key as string,(input.size as number)+MAX_PARSE_EXTRA_BYTES)) return false;
        this.state.storage.sql.exec('INSERT INTO ingress_reservations(id,day,size) VALUES(?,?,?)',input.key as string,day,input.size as number);
        this.state.storage.sql.exec('UPDATE intake_control SET value=value+1 WHERE id=1');
        const seq=this.state.storage.sql.exec<{value:number}>('SELECT value FROM intake_control WHERE id=1').one().value;
        this.state.storage.sql.exec("INSERT INTO ingest_uploads(key,seq,status,policy,created) VALUES(?,?,'uploading',?,?)",input.key as string,seq,JSON.stringify(policy),Date.now());
        this.insert({type:'parse',key:input.key as string});
        return true;
      });
      if(!accepted) return new Response(null,{status:429});
      await this.schedule();
      const upload=this.state.storage.sql.exec<{seq:number;policy:string}>('SELECT seq,policy FROM ingest_uploads WHERE key=?',input.key as string).toArray()[0];
      if(!upload) return new Response(null,{status:503});
      return Response.json({ingest_seq:upload.seq,...JSON.parse(upload.policy)});
    }
    if(path==='/enqueue' && request.method==='POST') {
      if(Number(request.headers.get('Content-Length') || 0)>1024) return new Response(null,{status:413});
      const input=await request.json();
      if(!validJob(input)) return new Response(null,{status:400});
      this.insert(input);
      await this.schedule();
      return new Response(null,{status:204});
    }
    if(path==='/wake' && request.method==='POST') {
      this.state.storage.sql.exec('UPDATE control SET value=? WHERE id=1',Date.now());
      await this.schedule();
      return new Response(null,{status:204});
    }
    // An owner's send, resend or connection test, or a canary: the Worker's request waits for the event ID.
    if(path==='/deliveries/create') return handleDeliveryRequest(this.env,request);
    // contracts/ops-v1: reached only through the Ops entrypoint (ops-core.ts), never from a public route.
    if(path==='/ops/guard' && request.method==='POST') {
      if(Number(request.headers.get('Content-Length') || 0)>1024) return new Response(null,{status:413});
      let input:unknown;
      try { input=await request.json(); } catch { return new Response(null,{status:400}); }
      try { return Response.json(this.ops.set(input,Date.now())); }
      catch(error) { return new Response(null,{status:error instanceof Error && error.message==='invalid_input'?400:503}); }
    }
    if(path==='/ops/status' && request.method==='GET') return Response.json(this.opsStatus());
    if(path==='/status' && request.method==='GET') {
      if (!this.capacity.snapshot().initialized) {
        try { await this.capacity.initialize(); } catch { await this.state.storage.setAlarm(Date.now()+5000); }
      }
      const stats=this.state.storage.sql.exec<{pending:number;failed:number;oldest:number|null}>(`SELECT sum(CASE WHEN failed=0 THEN 1 ELSE 0 END) pending,sum(failed) failed,min(created) oldest FROM jobs`).one();
      const {policy:_policy,...backup}=this.backup.status();
      return Response.json({pending:stats.pending ?? 0,failed:stats.failed ?? 0,oldest:stats.oldest,next_alarm:await this.state.storage.getAlarm(),backup,capacity:this.capacity.snapshot()});
    }
    return new Response(null,{status:404});
  }
  /** DO-only reads, each bounded: two index counts capped at 10,000 rows, O(1) capacity totals and
   * today's intake reservations (at most INGEST_DAILY_MESSAGE_LIMIT rows). No D1 and no R2. */
  private opsStatus() {
    const now=Date.now(), day=new Date(now).toISOString().slice(0,10);
    const count=(failed:number)=>this.state.storage.sql.exec<{n:number}>('SELECT count(*) n FROM (SELECT 1 FROM jobs WHERE failed=? LIMIT 10000)',failed).one().n;
    const ingest=this.state.storage.sql.exec<{messages:number;bytes:number}>('SELECT count(*) messages,COALESCE(sum(size),0) bytes FROM ingress_reservations WHERE day=?',day).one();
    const capacity=this.capacity.snapshot();
    return {jobs_pending:count(0),jobs_failed:count(1),backup_active:this.backup.paused(),
      capacity:capacity.initialized?{used_bytes:capacity.used_bytes,limit_bytes:capacity.limit_bytes}:null,
      ingest_today:{messages:ingest.messages,bytes:ingest.bytes},guard:this.ops.read(now)};
  }
  async alarm():Promise<void> {
    if(this.running) { await this.state.storage.setAlarm(Date.now()+WAIT); return; }
    this.running=true;
    try {
      try { await this.capacity.initialize(); } catch { await this.state.storage.setAlarm(Date.now()+5000); return; }
      await this.backup.syncReceipt();
      if(this.backup.paused()) { await this.schedule(); return; }
      if(this.env.MAINTENANCE_MODE==='true') { await this.state.storage.setAlarm(Date.now()+DAY); return; }
      // This watchdog is durable before any external call. Isolate termination
      // or an exhausted CPU budget cannot leave an accepted job unscheduled.
      await this.state.storage.setAlarm(Date.now()+60_000);
      const maintenance=this.state.storage.sql.exec<{value:number}>('SELECT value FROM control WHERE id=1').one().value;
      if(maintenance<=Date.now()) {
        try {
          const maintenanceResult=await runMaintenance(this.env,this.ops.deferral(Date.now()));
          for(const job of maintenanceResult.jobs) this.insert(job);
          this.state.storage.sql.exec('DELETE FROM ingress_reservations WHERE day<?',new Date(Date.now()-30*DAY).toISOString().slice(0,10));
          this.state.storage.sql.exec('UPDATE control SET value=? WHERE id=1',Date.now()+(maintenanceResult.nextDelayMS ?? (maintenanceResult.continueSoon?10*60_000:DAY)));
          // Maintenance and message processing have separate invocations so their
          // D1/R2 calls stay within the Free plan's per-invocation query budget.
          await this.schedule(); return;
        } catch {
          this.state.storage.sql.exec('UPDATE control SET value=? WHERE id=1',Date.now()+300_000);
        }
      }
      const job=this.state.storage.sql.exec<StoredJob>('SELECT * FROM jobs WHERE failed=0 AND due<=? ORDER BY due,id LIMIT 1',Date.now()).toArray()[0];
      if(job) {
        try {
          const parsed=JSON.parse(job.payload) as Job;
          if(job.run_started!==null) {
            job.crashes++;
            this.state.storage.sql.exec('UPDATE jobs SET crashes=? WHERE id=?',job.crashes,job.id);
            if(parsed.type==='parse' && job.crashes>=3) {
              await markInterruptedJob(this.env,parsed);
              this.state.storage.sql.exec("UPDATE jobs SET failed=1,run_started=NULL,error='processing_interrupted_limit' WHERE id=? AND version=?",job.id,job.version);
              await this.schedule(); return;
            }
          }
          this.state.storage.sql.exec('UPDATE jobs SET run_started=?,attempts=attempts+1 WHERE id=?',Date.now(),job.id);
          const retry=await runJob(this.env,parsed,job.attempts);
          this.state.storage.sql.exec('UPDATE jobs SET run_started=NULL WHERE id=?',job.id);
          if(retry===null) this.state.storage.sql.exec('DELETE FROM jobs WHERE id=? AND version=?',job.id,job.version);
          else if(parsed.type==='parse' && Date.now()-job.created>DAY && !await this.env.MAIL_STORE.head(parsed.key)) {
            // A pre-registered upload which never completed is not an accepted
            // message. Keep a small diagnostic instead of retrying it forever.
            this.state.storage.transactionSync(()=>{
              this.state.storage.sql.exec("UPDATE jobs SET failed=1,error='raw_not_saved' WHERE id=? AND version=?",job.id,job.version);
              this.state.storage.sql.exec("UPDATE ingest_uploads SET status='failed',settled=? WHERE key=? AND status='uploading'",Date.now(),parsed.key);
              this.capacity.release(parsed.key,0);
            });
          } else if(parsed.type==='deliver' && Date.now()-job.created>DAY && !await this.env.DB.prepare('SELECT event_id FROM deliveries WHERE event_id=?').bind(parsed.eventID).first()) {
            this.state.storage.sql.exec("UPDATE jobs SET failed=1,error='delivery_not_published' WHERE id=? AND version=?",job.id,job.version);
          } else this.state.storage.sql.exec('UPDATE jobs SET due=?,error=NULL WHERE id=? AND version=?',Math.max(Date.now()+1000,retry),job.id,job.version);
        } catch {
          // Infrastructure errors are safe retry; do not log mail, URLs, tokens
          // or exception text supplied by a remote system.
          const delay=Math.min(6*3600_000,WAIT*Math.pow(2,Math.min(job.attempts,10)));
          this.state.storage.sql.exec('UPDATE jobs SET run_started=NULL WHERE id=?',job.id);
          this.state.storage.sql.exec("UPDATE jobs SET due=?,error='processing_unavailable' WHERE id=? AND version=?",Date.now()+delay,job.id,job.version);
        }
      }
      await this.schedule();
    } finally { this.running=false; }
  }
}
