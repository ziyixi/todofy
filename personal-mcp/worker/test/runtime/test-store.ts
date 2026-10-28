/**
 * The real SubscriptionStore (schema, SQLite, KV) with its own Alarm switched off, so backup.test.ts drives the backup
 * and the restore step by step at fixed clocks through the real BACKUPS bucket. Bundled into workerd; synthetic rows
 * only. `/<object name>` with {method, args} calls one of the methods below on that object.
 */
import { SubscriptionStore } from '../../src/store.ts';
import { BACKUP_KEY, backupStatus, runBackup, storeTables } from '../../src/backup.ts';
import { restoreState, restoreStep, startRestore } from '../../src/restore.ts';

/** R2 calls to let through, then to fail, by method: a stand-in for a flaky bucket. */
const failures = { put: 0, putAfter: 0, get: 0, getAfter: 0 };

function flaky(bucket: R2Bucket): R2Bucket {
  const wrap = (method: 'put' | 'get') => (...args: unknown[]) => {
    const after = method === 'put' ? 'putAfter' : 'getAfter';
    if (failures[method] > 0 && failures[after]-- <= 0) {
      failures[method]--;
      return Promise.reject(new Error(`Synthetic R2 ${method} failure`));
    }
    return (bucket[method] as (...values: unknown[]) => Promise<unknown>)(...args);
  };
  return { put: wrap('put'), get: wrap('get'), head: bucket.head.bind(bucket), list: bucket.list.bind(bucket),
    delete: bucket.delete.bind(bucket) } as unknown as R2Bucket;
}

/** Every value as JSON can hold it, a blob as its bytes. */
function plain(row: unknown[]): unknown[] {
  return row.map(value => value instanceof ArrayBuffer ? { bytes: [...new Uint8Array(value)] } : value);
}

const text = (seed: number, length: number) =>
  `Synthetic “${String(seed)}” it's 汉字\n${'x'.repeat(length)}`.slice(0, Math.max(length, 24));

export class TestStore extends SubscriptionStore {
  override async alarm(): Promise<void> { /* driven by the test */ }

  override async fetch(request: Request): Promise<Response> {
    const { method, args = [] } = await request.json<{ method: string; args?: unknown[] }>();
    try {
      const action = (this as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
      if (typeof action !== 'function') throw new Error(`No method ${method}`);
      return Response.json({ result: (await action.apply(this, args)) ?? null });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  fail(counts: Partial<typeof failures>): void { Object.assign(failures, { put: 0, putAfter: 0, get: 0, getAfter: 0 }, counts); }

  exec(query: string, ...bindings: SqlStorageValue[]): unknown[] { return this.ctx.storage.sql.exec(query, ...bindings).toArray(); }

  tables(): [string, string[]][] { return storeTables(this.ctx.storage.sql).map(table => [table.name, table.columns]); }

  /**
   * Every table of the store with synthetic rows: `deliveries` big enough that a job takes more than one step, rowid
   * gaps, rows replaced to a new rowid, text with quotes, newlines and CJK, NULLs, a blob in a TEXT column, the
   * AUTOINCREMENT sequence, and the KV keys the store keeps.
   */
  async seed(deliveries: number, entries: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const at = 1_793_000_000_000;
    const subscription = (id: number, name: string, args = '{}', expires: number | null = null) => sql.exec(
      'INSERT INTO subscriptions (id, owner, name, url, secret, expires_at, verified_at, arguments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `sub_${String(id).padStart(64, '0')}`, 'owner@example.org', name, `https://receiver.example.org/callback/${String(id)}`,
      `whsec_${btoa(`synthetic-secret-${String(id)}`.padEnd(32, '='))}`, expires, at, args);
    subscription(1, 'personal_cloud.test');
    subscription(2, 'task.changed', '{}', at + 86_400_000);
    subscription(3, 'work.attention', '{"work_id":"00000000-0000-4000-8000-000000000001"}');
    sql.exec("INSERT INTO test_events VALUES ('test_a'), ('test_b')");
    sql.exec('INSERT INTO step_batches VALUES (?, ?, ?)', 'req-1', 'f'.repeat(64), JSON.stringify([{ taskId: 't1', requestId: 'r1' }]));
    sql.exec('INSERT INTO step_batches VALUES (?, ?, ?)', 'req-2', 'e'.repeat(64), '[]');
    for (let index = 0; index < 60; index++) sql.exec('INSERT OR REPLACE INTO own_changes VALUES (?, ?)', `task-${String(index % 40)}`, String(index));
    sql.exec('INSERT INTO event_sources VALUES (?, ?, ?, NULL)', 'task.changed', '{"name":"task.changed","cursor":"41"}', at);
    sql.exec('INSERT INTO event_sources VALUES (?, ?, ?, ?)', 'task.must_start', '{"name":"task.must_start","ids":["a","b"],"revision":7}', at, 'source_unavailable');
    sql.exec('INSERT INTO event_sources VALUES (?, ?, ?, NULL)', 'work.watch', 'watch-cursor-9', at);
    for (let index = 0; index < deliveries; index++) sql.exec(
      'INSERT INTO deliveries (subscription_id, event_id, body, state, attempts, next_at, accepted_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `sub_${String(1 + (index % 3)).padStart(64, '0')}`, `event_${String(index)}`,
      JSON.stringify({ eventId: `event_${String(index)}`, timestamp: new Date(at + index).toISOString(), data: text(index, 1800) }),
      index % 50 === 0 ? 'failed' : index % 7 === 0 ? 'pending' : 'accepted', index % 3, at + index,
      index % 7 === 0 ? null : at + index, index % 50 === 0 ? 'callback_http_400' : null);
    sql.exec("DELETE FROM deliveries WHERE event_id IN ('event_5', 'event_6', 'event_100')");
    sql.exec("UPDATE deliveries SET state='accepted', accepted_at=? WHERE event_id='event_14'", at);
    for (let work = 1; work <= 20; work++) {
      const id = `00000000-0000-4000-8000-${String(work).padStart(12, '0')}`;
      sql.exec(`INSERT INTO work (id, title, goal, scope, completion_criteria, state, checkpoint, next_action, waiting_for,
        review_at, result, etag, created_at, updated_at, last_report_seq, handled_through_report_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`, id, `Synthetic work ${String(work)}`, text(work, 300),
      'Synthetic scope', 'Synthetic criteria', work % 4 === 0 ? 'done' : work % 3 === 0 ? 'waiting' : 'active', text(work, 2000),
      'Next', '', work % 2 ? null : '2026-11-01T00:00:00Z', '', work, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
      sql.exec('INSERT INTO work_links VALUES (?, ?, ?, ?)', id, 'watch', `watches/synthetic-${String(work)}`,
        JSON.stringify({ type: 'watch', ref: `watches/synthetic-${String(work)}`, owned: true }));
      sql.exec('INSERT INTO work_links VALUES (?, ?, ?, ?)', id, 'task', `tasks/synthetic-${String(work)}`, '{"type":"task"}');
    }
    for (let index = 0; index < entries; index++) {
      const work = `00000000-0000-4000-8000-${String(1 + (index % 20)).padStart(12, '0')}`;
      const report = index % 5 === 0;
      sql.exec(`INSERT INTO work_entries (work_id, kind, summary, created_at, observed_at, evidence_ref, source_type, source_ref,
        report_id, request_id, review_json, input_fingerprint, mutation, applied_etag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      work, report ? 'progress' : 'checkpoint', text(index, 700), '2026-10-03T00:00:00Z', report ? '2026-10-03T00:00:00Z' : null,
      index === 3 ? new Uint8Array([0, 1, 2, 255]).buffer : '', report ? 'watch' : null, report ? 'watches/synthetic-1' : null,
      report ? `watch:${String(index)}` : null, report ? null : `request-${String(index)}`,
      index % 9 === 0 ? '{"reason":"Synthetic review"}' : null, `fingerprint-${String(index)}`, report ? null : 'checkpoint',
      report ? null : index);
    }
    sql.exec("UPDATE work SET last_report_seq=(SELECT coalesce(max(seq),0) FROM work_entries e WHERE e.work_id=work.id AND report_id IS NOT NULL)");
    await this.ctx.storage.put('last_tool_at', at);
    await this.ctx.storage.put('last_subscription_at', at - 1);
    await this.ctx.storage.put('last_subscription_request', { method: 'events/subscribe', phase: 'accepted', http_status: 200 });
  }

  /** Every table with its rowids (delivery_totals as its nonzero counts) and every KV key but the backup's own. */
  dump(): Record<string, unknown[]> {
    const sql = this.ctx.storage.sql;
    const out: Record<string, unknown[]> = {};
    for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray())
      out[name] = name === 'delivery_totals'
        ? sql.exec('SELECT state, count FROM delivery_totals WHERE count <> 0 ORDER BY state').toArray()
        : [...sql.exec(`SELECT rowid, * FROM "${name}" ORDER BY rowid`).raw()].map(plain);
    out.kv = [...this.ctx.storage.kv.list()].filter(([key]) => key !== 'backup' && key !== 'restore');
    return out;
  }

  async backupStep(now: number) {
    await runBackup(this.ctx.storage, flaky(this.env.BACKUPS as R2Bucket), now);
    return { state: this.ctx.storage.kv.get(BACKUP_KEY) ?? null, due: backupStatus(this.ctx.storage, this.env.BACKUPS).due };
  }

  beginRestore(backup: unknown, now: number) { return startRestore(this.ctx.storage, flaky(this.env.BACKUPS as R2Bucket), backup, now); }

  async restoreStep(now: number) {
    const next = await restoreStep(this.ctx.storage, flaky(this.env.BACKUPS as R2Bucket), now);
    return { next, state: restoreState(this.ctx.storage) ?? null };
  }

  /** The store's own Alarm, which an object the Worker no longer routes to must not run. */
  async realAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await super.alarm();
    return { alarm: await this.ctx.storage.getAlarm(), backup: this.ctx.storage.kv.get(BACKUP_KEY) ?? null };
  }
}

export default {
  fetch(request: Request, env: { SUBSCRIPTIONS: DurableObjectNamespace<TestStore> }): Promise<Response> {
    return env.SUBSCRIPTIONS.getByName(new URL(request.url).pathname.slice(1)).fetch(request);
  },
};
