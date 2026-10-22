/** The existing Watch feed produces facts; relevance decisions stay in each work record. */
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { toWire } from '@ziyixi/proto/wire-json';
import { WatchEventSchema, WatchEvent_Kind } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { createWatchClient, type WatchToolEnv } from './watch.ts';
import type { WorkStorage, WorkStore } from './work-store.ts';

export const WATCH_SOURCE_NAME = 'work.watch';
export const WATCH_POLL_INTERVAL_MS = 60_000;
type SourceRow = { state: string; checked_at: number; error_code: string | null };

export class WorkWatchSource {
  private readonly client;
  private refreshing: Promise<void> | undefined;
  private readonly storage: WorkStorage;
  private readonly work: WorkStore;

  constructor(storage: WorkStorage, work: WorkStore, env: WatchToolEnv) {
    this.storage = storage;
    this.work = work;
    this.client = createWatchClient(env);
  }

  status() {
    const row = this.row();
    return { name: WATCH_SOURCE_NAME, checked_at: row?.checked_at ?? null,
      error_code: row?.error_code ?? (row ? null : 'not_started') };
  }

  hasLinks(): boolean {
    return this.storage.sql.exec(`SELECT 1 FROM work_links l JOIN work w ON w.id=l.work_id
      WHERE l.type='watch' AND w.state IN ('active','waiting') LIMIT 1`).toArray().length > 0;
  }

  /** Establish the starting point before creating a new Watch, not after its first change. */
  async initialize(reset = false): Promise<void> {
    const previous = this.row();
    if (previous?.state && this.hasLinks() && !reset) return;
    const baseline = await this.client.pollWatchEvents({ baseline: true, cursor: '', pageSize: 20 });
    this.storage.sql.exec(`INSERT INTO event_sources VALUES (?,?,?,NULL) ON CONFLICT(name)
      DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,error_code=NULL WHERE state=?`,
    WATCH_SOURCE_NAME, baseline.cursor, Date.now(), previous?.state ?? '');
  }

  async refresh(): Promise<void> {
    if (!this.hasLinks()) return;
    this.refreshing ??= this.poll().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }

  private row() {
    return this.storage.sql.exec<SourceRow>('SELECT state,checked_at,error_code FROM event_sources WHERE name=?', WATCH_SOURCE_NAME).toArray()[0];
  }

  private async poll(): Promise<void> {
    try {
      const previous = this.row();
      if (previous && Date.now() - previous.checked_at < WATCH_POLL_INTERVAL_MS) return;
      await this.initialize();
      const row = this.row();
      if (!row || Date.now() - row.checked_at < WATCH_POLL_INTERVAL_MS) return;
      const page = await this.client.pollWatchEvents({ cursor: row.state, baseline: false, pageSize: 20 });
      for (const event of page.events) {
        const confirmed = event.kind === WatchEvent_Kind.CHANGE_CONFIRMED;
        const wire = toWire(WatchEventSchema, event);
        for (const workId of this.work.linkedWorkIds('watch', event.watch)) this.work.report({
          work_id: workId, report_id: `watch:${event.sequence}`, kind: confirmed ? 'progress' : 'blocked',
          source: { type: 'watch', ref: event.watch },
          summary: confirmed ? 'Watch confirmed a change. Review its evidence against the work goal.'
            : event.kind === WatchEvent_Kind.WATCH_BROKEN ? 'Watch checks are failing. Read its health before relying on this watch.'
              : 'Watch was paused after prolonged failures. Review its health and decide whether to resume.',
          ...(typeof wire['create_time'] === 'string' ? { observed_at: wire['create_time'] } : {}), evidence_ref: event.change,
        });
      }
      // Re-reading a page after a restart is safe: each report and its callback share a transaction,
      // and the source sequence is a stable report_id even if this cursor update was interrupted.
      this.storage.sql.exec('UPDATE event_sources SET state=?,checked_at=?,error_code=NULL WHERE name=? AND state=?',
        page.cursor, Date.now() - (page.hasMore ? WATCH_POLL_INTERVAL_MS - 1000 : 0), WATCH_SOURCE_NAME, row.state);
    } catch (error) {
      const code = error instanceof RpcStatusError && error.status.reason === 'CURSOR_EXPIRED'
        ? 'watch_cursor_expired' : 'watch_source_unavailable';
      this.storage.sql.exec(`INSERT INTO event_sources VALUES (?,'',?,?) ON CONFLICT(name)
        DO UPDATE SET checked_at=excluded.checked_at,error_code=excluded.error_code`, WATCH_SOURCE_NAME, Date.now(), code);
      // Reading work remains possible. The caller also receives this source status, never a false no-change result.
    }
  }
}
