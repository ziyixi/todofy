import type { Env } from './types.ts';

export const MAX_PARSED_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PARSE_EXTRA_BYTES = MAX_PARSED_JSON_BYTES + 5 * 1024 * 1024;
export const DEFAULT_CAPACITY_BYTES = 5 * 1024 * 1024 * 1024;

export async function coordinatorRequest(env: Env, path: string, value?: unknown): Promise<Response> {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch(`https://coordinator${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

export async function reserveObjectCapacity(env: Env, key: string, bytes: number): Promise<void> {
  const response = await coordinatorRequest(env, '/capacity/reserve', { key, bytes });
  if (!response.ok) throw new Error(response.status === 429 ? 'logical_capacity' : 'capacity_unavailable');
}
export async function settleObjectCapacity(env: Env, key: string, bytes: number, legacyBytes = 0, releaseKey?: string): Promise<void> {
  const response = await coordinatorRequest(env, '/capacity/settle', { key, bytes, legacy_bytes: legacyBytes, release_key: releaseKey });
  if (!response.ok) throw new Error('capacity_settlement_unavailable');
}
/** Call only AFTER physical object deletion. legacyBytes applies only when this
 * key predates the DO ledger; the released-key tombstone makes retries safe. */
export async function releaseObjectCapacity(env: Env, key: string, legacyBytes = 0): Promise<void> {
  const response = await coordinatorRequest(env, '/capacity/release', { key, legacy_bytes: legacyBytes });
  if (!response.ok) throw new Error('capacity_release_unavailable');
}
export async function capacitySnapshot(env: Env): Promise<Record<string, unknown>> {
  const response = await coordinatorRequest(env, '/capacity/status');
  if (!response.ok) throw new Error('capacity_unavailable');
  return response.json();
}

export async function reconcileCapacity(env: Env): Promise<{ checked: number; released: number }> {
  const response = await coordinatorRequest(env, '/capacity/reconcile', {});
  if (response.status === 409) return { checked: 0, released: 0 };
  if (!response.ok) throw new Error('capacity_reconciliation_unavailable');
  return response.json();
}

type Allocation = { [key: string]: SqlStorageValue; key: string; bytes: number; released: number; created: number };
export class CapacityLedger {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private initialization: Promise<void> | null = null;
  constructor(storage: DurableObjectStorage, env: Env) {
    this.storage = storage; this.env = env;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_control
      (id INTEGER PRIMARY KEY,baseline INTEGER NOT NULL,limit_bytes INTEGER NOT NULL,initialized INTEGER NOT NULL)`);
    storage.sql.exec('INSERT OR IGNORE INTO capacity_control(id,baseline,limit_bytes,initialized) VALUES(1,0,?,0)', DEFAULT_CAPACITY_BYTES);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_allocations
      (key TEXT PRIMARY KEY,bytes INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL DEFAULT 0,checked INTEGER NOT NULL DEFAULT 0)`);
    const columns = new Set(storage.sql.exec<{ name: string }>('PRAGMA table_info(capacity_allocations)').toArray().map(row => row.name));
    if (!columns.has('created')) storage.sql.exec('ALTER TABLE capacity_allocations ADD COLUMN created INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('checked')) storage.sql.exec('ALTER TABLE capacity_allocations ADD COLUMN checked INTEGER NOT NULL DEFAULT 0');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS capacity_active_bytes ON capacity_allocations(released,bytes)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS capacity_reconcile ON capacity_allocations(released,checked,created)');
    // Raw keys are never reconciled and never marked checked; keep them out of the scan.
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS capacity_reconcile_nonraw ON capacity_allocations(checked,created,key)
      WHERE released=0 AND substr(key,1,4)<>'raw/'`);
    // Running total of active allocations, so every snapshot reads two rows. It has
    // its own table: the previous release inserts capacity_control positionally,
    // so adding columns there would break its constructor after a code rollback.
    storage.sql.exec('CREATE TABLE IF NOT EXISTS capacity_totals(id INTEGER PRIMARY KEY CHECK(id=1),allocated INTEGER NOT NULL,checked INTEGER NOT NULL)');
    if (!storage.sql.exec('SELECT 1 FROM capacity_totals WHERE id=1').toArray().length) this.recount();
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_bootstrap
      (id INTEGER PRIMARY KEY,cursor TEXT,bytes INTEGER NOT NULL,logical_bytes INTEGER NOT NULL,limit_bytes INTEGER NOT NULL)`);
  }
  async initialize(): Promise<void> {
    if (this.snapshot().initialized) return;
    if (!this.initialization) this.initialization = this.initializePage().finally(() => { this.initialization = null; });
    await this.initialization;
  }
  private async initializePage(): Promise<void> {
    let progress = this.storage.sql.exec<{ cursor: string | null; bytes: number; logical_bytes: number; limit_bytes: number }>(
      'SELECT * FROM capacity_bootstrap WHERE id=1').toArray()[0];
    if (!progress) {
      const settings = await this.env.DB.prepare('SELECT logical_bytes,logical_limit_bytes FROM app_settings WHERE id=1')
        .first<{ logical_bytes: number; logical_limit_bytes: number }>();
      if (!settings || !Number.isSafeInteger(settings.logical_bytes) || settings.logical_bytes < 0 ||
          !Number.isSafeInteger(settings.logical_limit_bytes) || settings.logical_limit_bytes < 1) throw new Error('capacity_bootstrap_unavailable');
      this.storage.sql.exec('INSERT OR IGNORE INTO capacity_bootstrap VALUES(1,NULL,0,?,?)', settings.logical_bytes, settings.logical_limit_bytes);
      progress = this.storage.sql.exec<typeof progress>('SELECT * FROM capacity_bootstrap WHERE id=1').one();
    }
    // All normal writers are gated by initialize(). This is a physical baseline
    // for existing objects, including unindexed raw and orphans, not R2 billing.
    const page = await this.env.MAIL_STORE.list({ cursor: progress.cursor ?? undefined, limit: 100 });
    const bytes = progress.bytes + page.objects.reduce((sum, object) => sum + object.size, 0);
    this.storage.transactionSync(() => {
      if (page.truncated) this.storage.sql.exec('UPDATE capacity_bootstrap SET cursor=?,bytes=? WHERE id=1', page.cursor, bytes);
      else this.storage.sql.exec('UPDATE capacity_control SET baseline=?,limit_bytes=?,initialized=1 WHERE id=1 AND initialized=0',
        Math.max(progress.logical_bytes, bytes), progress.limit_bytes);
    });
    if (page.truncated) throw new Error('capacity_bootstrap_in_progress');
  }
  /** One full O(active) sum; the running total is adjusted synchronously by every writer. */
  private recount(): void {
    this.storage.sql.exec(`INSERT INTO capacity_totals(id,allocated,checked) SELECT 1,COALESCE(sum(bytes),0),? FROM capacity_allocations WHERE released=0
      ON CONFLICT(id) DO UPDATE SET allocated=excluded.allocated,checked=excluded.checked`, Date.now());
  }
  private adjust(bytes: number): void {
    if (bytes) this.storage.sql.exec('UPDATE capacity_totals SET allocated=max(0,allocated+?) WHERE id=1', bytes);
  }
  async reconcileAbandoned(): Promise<{ checked: number; released: number }> {
    // Daily self-heal of the running total, also after a rollback whose older
    // writers did not adjust it.
    const checked = this.storage.sql.exec<{ checked: number }>('SELECT checked FROM capacity_totals WHERE id=1').one().checked;
    if (!checked || Date.now() - checked > 86_400_000) this.recount();
    // A stale parse cannot still run concurrently with maintenance: only this
    // coordinator's serial Alarm starts MIME parsing. Never reclaim the current
    // D1 claim, even if its timestamp has expired, and never delete R2 here.
    const rows = this.storage.sql.exec<Allocation>(`SELECT * FROM capacity_allocations INDEXED BY capacity_reconcile_nonraw
      WHERE released=0 AND substr(key,1,4)<>'raw/' AND (key LIKE 'parsed/%' OR key LIKE 'payload/%') AND created<? ORDER BY checked,created,key LIMIT 4`, Date.now() - 3600_000).toArray();
    let released = 0;
    for (const row of rows) {
      this.storage.sql.exec('UPDATE capacity_allocations SET checked=? WHERE key=?', Date.now(), row.key);
      const payload = /^payload\/([0-9a-f-]{36})\.json$/i.exec(row.key);
      if (payload) {
        if (await this.env.DB.prepare('SELECT event_id FROM deliveries WHERE event_id=?').bind(payload[1]).first()) continue;
        if (await this.env.MAIL_STORE.head(row.key)) continue;
        this.storage.transactionSync(() => { this.release(row.key, 0); }); released++; continue;
      }
      const match = /^parsed\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(row.key);
      if (!match) continue;
      const message = await this.env.DB.prepare('SELECT claim_token FROM messages WHERE id=?').bind(match[1]).first<{ claim_token: string | null }>();
      if (message?.claim_token === match[2]) continue;
      const objects = await this.env.MAIL_STORE.list({ prefix: row.key + '/', limit: 1 });
      if (objects.objects.length || objects.truncated) continue;
      this.storage.transactionSync(() => { this.release(row.key, 0); }); released++;
    }
    return { checked: rows.length, released };
  }
  snapshot(): { used_bytes: number; baseline_bytes: number; reserved_bytes: number; limit_bytes: number; initialized: boolean } {
    const row = this.storage.sql.exec<{ baseline: number; limit_bytes: number; initialized: number; allocated: number }>(
      'SELECT c.baseline,c.limit_bytes,c.initialized,t.allocated FROM capacity_control c JOIN capacity_totals t ON t.id=1 WHERE c.id=1').one();
    const allocated = row.allocated;
    return { used_bytes: row.baseline + allocated, baseline_bytes: row.baseline, reserved_bytes: allocated,
      limit_bytes: row.limit_bytes, initialized: !!row.initialized };
  }
  reserve(key: string, bytes: number): boolean {
    const previous = this.storage.sql.exec<Allocation>('SELECT * FROM capacity_allocations WHERE key=?', key).toArray()[0];
    if (previous) return previous.released === 0 && previous.bytes === bytes;
    const usage = this.snapshot();
    if (!usage.initialized || usage.used_bytes + bytes > usage.limit_bytes) return false;
    this.storage.sql.exec('INSERT INTO capacity_allocations(key,bytes,created) VALUES(?,?,?)', key, bytes, Date.now());
    this.adjust(bytes);
    return true;
  }
  settle(key: string, bytes: number, legacyBytes = 0, releaseKey?: string): boolean {
    const previous = this.storage.sql.exec<Allocation>('SELECT * FROM capacity_allocations WHERE key=?', key).toArray()[0];
    if (previous?.released) return bytes === 0;
    const transferred = releaseKey && releaseKey !== key
      ? this.storage.sql.exec<Allocation>('SELECT * FROM capacity_allocations WHERE key=? AND released=0', releaseKey).toArray()[0] : null;
    if (previous && bytes > previous.bytes + (transferred?.bytes ?? 0)) return false;
    if (!previous && legacyBytes === 0) return false;
    const usage = this.snapshot();
    if (usage.used_bytes - (previous?.bytes ?? legacyBytes) - (transferred?.bytes ?? 0) + bytes > usage.limit_bytes) return false;
    if (!previous) this.storage.sql.exec('UPDATE capacity_control SET baseline=max(0,baseline-?) WHERE id=1', legacyBytes);
    this.storage.sql.exec('INSERT INTO capacity_allocations(key,bytes,created) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes', key, bytes, Date.now());
    this.adjust(bytes - (previous?.bytes ?? 0));
    if (transferred) this.release(transferred.key, 0);
    return true;
  }
  release(key: string, legacyBytes: number): void {
    const previous = this.storage.sql.exec<Allocation>('SELECT * FROM capacity_allocations WHERE key=?', key).toArray()[0];
    if (previous?.released) return;
    if (previous) {
      this.storage.sql.exec('UPDATE capacity_allocations SET bytes=0,released=1 WHERE key=?', key);
      this.adjust(-previous.bytes);
    } else {
      this.storage.sql.exec('UPDATE capacity_control SET baseline=max(0,baseline-?) WHERE id=1', legacyBytes);
      this.storage.sql.exec('INSERT INTO capacity_allocations(key,bytes,released,created) VALUES(?,0,1,?)', key, Date.now());
    }
  }
}
