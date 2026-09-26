import type { Env, Job } from './types.ts';
import { runJob, runMaintenance, markInterruptedJob } from './pipeline.ts';

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
 * Only alarms perform background work. fetch only records intents or wakes it. */
export class MailCoordinator {
  private readonly state:DurableObjectState;
  private readonly env:Env;
  private running=false;
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
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    state.storage.sql.exec('INSERT OR IGNORE INTO control(id,value) VALUES(1,?)',Date.now()+DAY);
  }
  private insert(job:Job,time=Date.now()):void {
    this.state.storage.sql.exec(`INSERT INTO jobs(id,payload,due,created) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET due=min(jobs.due,excluded.due),version=jobs.version+1,crashes=CASE WHEN jobs.failed=1 THEN 0 ELSE jobs.crashes END,failed=0,error=NULL`,jobID(job),JSON.stringify(job),time,Date.now());
  }
  private async schedule():Promise<void> {
    const job=this.state.storage.sql.exec<{due:number|null}>('SELECT min(due) due FROM jobs WHERE failed=0').one();
    const maintenance=this.state.storage.sql.exec<{value:number}>('SELECT value FROM control WHERE id=1').one().value;
    const due=this.env.MAINTENANCE_MODE==='true'?Date.now()+DAY:Math.min(job.due ?? maintenance,maintenance);
    await this.state.storage.setAlarm(Math.max(Date.now()+1000,due));
  }
  async fetch(request:Request):Promise<Response> {
    const path=new URL(request.url).pathname;
    if(path==='/reserve-ingest' && request.method==='POST') {
      const input=await request.json() as {key?:unknown;size?:unknown};
      if(typeof input.key!=='string' || !validJob({type:'parse',key:input.key}) || !Number.isSafeInteger(input.size) || (input.size as number)<1 || (input.size as number)>25*1024*1024) return new Response(null,{status:400});
      const countLimit=Number(this.env.INGEST_DAILY_MESSAGE_LIMIT ?? 300),bytesLimit=Number(this.env.INGEST_DAILY_BYTE_LIMIT ?? 256*1024*1024);
      if(!Number.isSafeInteger(countLimit) || countLimit<1 || !Number.isSafeInteger(bytesLimit) || bytesLimit<1) return new Response(null,{status:503});
      const day=new Date().toISOString().slice(0,10);
      const accepted=this.state.storage.transactionSync(()=>{
        const old=this.state.storage.sql.exec<{size:number}>('SELECT size FROM ingress_reservations WHERE id=?',input.key as string).toArray()[0];
        if(old) return old.size===input.size;
        const usage=this.state.storage.sql.exec<{count:number;bytes:number}>('SELECT count(*) count,COALESCE(sum(size),0) bytes FROM ingress_reservations WHERE day=?',day).one();
        if(usage.count>=countLimit || usage.bytes+(input.size as number)>bytesLimit) return false;
        this.state.storage.sql.exec('INSERT INTO ingress_reservations(id,day,size) VALUES(?,?,?)',input.key as string,day,input.size as number);
        this.insert({type:'parse',key:input.key as string});
        return true;
      });
      if(!accepted) return new Response(null,{status:429});
      await this.schedule();
      return new Response(null,{status:204});
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
    if(path==='/status' && request.method==='GET') {
      const stats=this.state.storage.sql.exec<{pending:number;failed:number;oldest:number|null}>(`SELECT sum(CASE WHEN failed=0 THEN 1 ELSE 0 END) pending,sum(failed) failed,min(created) oldest FROM jobs`).one();
      return Response.json({pending:stats.pending ?? 0,failed:stats.failed ?? 0,oldest:stats.oldest,next_alarm:await this.state.storage.getAlarm()});
    }
    return new Response(null,{status:404});
  }
  async alarm():Promise<void> {
    if(this.running) { await this.state.storage.setAlarm(Date.now()+WAIT); return; }
    this.running=true;
    try {
      if(this.env.MAINTENANCE_MODE==='true') { await this.state.storage.setAlarm(Date.now()+DAY); return; }
      // This watchdog is durable before any external call. Isolate termination
      // or an exhausted CPU budget cannot leave an accepted job unscheduled.
      await this.state.storage.setAlarm(Date.now()+60_000);
      const maintenance=this.state.storage.sql.exec<{value:number}>('SELECT value FROM control WHERE id=1').one().value;
      if(maintenance<=Date.now()) {
        try {
          const maintenanceResult=await runMaintenance(this.env);
          for(const job of maintenanceResult.jobs) this.insert(job);
          this.state.storage.sql.exec('DELETE FROM ingress_reservations WHERE day<?',new Date(Date.now()-30*DAY).toISOString().slice(0,10));
          this.state.storage.sql.exec('UPDATE control SET value=? WHERE id=1',Date.now()+(maintenanceResult.continueSoon?10*60_000:DAY));
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
            this.state.storage.sql.exec("UPDATE jobs SET failed=1,error='raw_not_saved' WHERE id=? AND version=?",job.id,job.version);
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
