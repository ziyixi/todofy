/** The existing Watch feed produces facts; relevance decisions stay in each work record. */
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { toWire } from '@ziyixi/proto/wire-json';
import { WatchEventSchema, WatchEvent_Kind } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { createWatchClient, type WatchToolEnv } from './watch.ts';
import type { WorkStorage, WorkStore } from './work-store.ts';

export const WATCH_SOURCE_NAME = 'work.watch';
export const WATCH_POLL_INTERVAL_MS = 60_000;
/** The feed's maximum page; a full page is followed a second later instead of a minute. */
const PAGE_SIZE = 100;
const HEALTH_SUMMARIES: Partial<Record<WatchEvent_Kind, string>> = {
  [WatchEvent_Kind.WATCH_BROKEN]: 'Watch checks are failing. Read its health before relying on this watch.',
  [WatchEvent_Kind.WATCH_PAUSED]: 'Watch was paused after prolonged failures. Review its health and decide whether to resume.',
};
const GAP_SUMMARY = 'Watch events expired before they were read, so changes in that period were not reported here. '
  + 'Read watch_changes for the linked Watches before relying on this work.';
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
  async initialize(): Promise<void> {
    const previous = this.row();
    if (previous?.state && this.hasLinks()) return;
    await this.baseline(previous?.state ?? '');
  }

  async refresh(): Promise<void> {
    if (!this.hasLinks()) return;
    this.refreshing ??= this.poll().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }

  private row() {
    return this.storage.sql.exec<SourceRow>('SELECT state,checked_at,error_code FROM event_sources WHERE name=?', WATCH_SOURCE_NAME).toArray()[0];
  }

  /** Moves the cursor to the feed's head, unless another call already moved it from `expected`. */
  private async baseline(expected: string): Promise<void> {
    const baseline = await this.client.pollWatchEvents({ baseline: true, cursor: '', pageSize: PAGE_SIZE });
    this.storage.sql.exec(`INSERT INTO event_sources VALUES (?,?,?,NULL) ON CONFLICT(name)
      DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,error_code=NULL WHERE state=?`,
    WATCH_SOURCE_NAME, baseline.cursor, Date.now(), expected);
  }

  /**
   * The feed's retention outran the cursor: each open Work with a Watch gets one blocked report about the gap, then the
   * cursor starts again from now. The report ID comes from the expired cursor, so a retry repeats the same reports.
   */
  private async recoverGap(expired: string): Promise<void> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expired)));
    const reportId = `watch-gap:${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const linked = this.storage.sql.exec<{ work_id: string; ref: string }>(`SELECT l.work_id, min(l.ref) AS ref FROM work_links l
      JOIN work w ON w.id=l.work_id WHERE l.type='watch' AND w.state IN ('active','waiting') GROUP BY l.work_id ORDER BY l.work_id`).toArray();
    for (const { work_id, ref } of linked) this.work.report({ work_id, report_id: reportId, kind: 'blocked',
      source: { type: 'watch', ref }, summary: GAP_SUMMARY });
    await this.baseline(expired);
  }

  private async poll(): Promise<void> {
    try {
      const previous = this.row();
      if (previous && Date.now() - previous.checked_at < WATCH_POLL_INTERVAL_MS) return;
      await this.initialize();
      const row = this.row();
      if (!row || Date.now() - row.checked_at < WATCH_POLL_INTERVAL_MS) return;
      let page;
      try {
        page = await this.client.pollWatchEvents({ cursor: row.state, baseline: false, pageSize: PAGE_SIZE });
      } catch (error) {
        if (!(error instanceof RpcStatusError && error.status.reason === 'CURSOR_EXPIRED')) throw error;
        await this.recoverGap(row.state);
        return;
      }
      for (const event of page.events) {
        const changed = event.kind === WatchEvent_Kind.EVIDENCE_CHANGED;
        const summary = changed ? `Watch captured changed page evidence. Before snapshot: ${event.beforeSnapshot || 'unavailable'}. After snapshot: ${event.afterSnapshot || 'unavailable'}. Review it against the work goal.`
          : HEALTH_SUMMARIES[event.kind];
        // A kind this build does not know (a newer Watch) is left for a newer build, never guessed.
        if (summary === undefined) continue;
        const wire = toWire(WatchEventSchema, event);
        for (const workId of this.work.linkedWorkIds('watch', event.watch)) this.work.report({
          work_id: workId, report_id: `watch:${event.sequence}`, kind: changed ? 'progress' : 'blocked',
          source: { type: 'watch', ref: event.watch }, summary,
          ...(typeof wire['create_time'] === 'string' ? { observed_at: wire['create_time'] } : {}), evidence_ref: changed ? event.afterSnapshot : '',
        });
      }
      // Re-reading a page after a restart is safe: each report and its callback share a transaction,
      // and the source sequence is a stable report_id even if this cursor update was interrupted.
      this.storage.sql.exec('UPDATE event_sources SET state=?,checked_at=?,error_code=NULL WHERE name=? AND state=?',
        page.cursor, Date.now() - (page.hasMore ? WATCH_POLL_INTERVAL_MS - 1000 : 0), WATCH_SOURCE_NAME, row.state);
    } catch {
      this.storage.sql.exec(`INSERT INTO event_sources VALUES (?,'',?,?) ON CONFLICT(name)
        DO UPDATE SET checked_at=excluded.checked_at,error_code=excluded.error_code`, WATCH_SOURCE_NAME, Date.now(), 'watch_source_unavailable');
      // Reading work remains possible. The caller also receives this source status, never a false no-change result.
    }
  }
}
