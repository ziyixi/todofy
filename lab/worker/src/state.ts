/**
 * LabState (docs/design.md §4–§10): the single SQLite-backed Durable Object "lab-v1". It owns scheduling
 * (setAlarm only, no cron), job cursors, vectors, the neuron ledger and the guard, and is the only writer
 * to D1. Owner mutations run one at a time (a promise chain: D1 calls would otherwise interleave), and so
 * do pipeline slices. Every method returns plain values; the Worker maps them to HTTP.
 */
import { DurableObject } from 'cloudflare:workers';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { DECK_OFFER_DAYS } from './limits.ts';
import {
  type BuildPhase,
  type Decision,
  type DeckMutationResponse,
  type DeckPointer,
  type DeckSummary,
  type FeedbackResponse,
  type SeedsResponse,
  type SendMode,
  type SendStatus,
  type Settings,
  type SettingsResponse,
  type StatusResponse,
  type TodayResponse,
} from './model.ts';
import { MINUTE, addDays, buildSha, iso, utcDay } from './config.ts';
import type { Env } from './env.ts';
import { labStatus, guardState, setGuard, FEED_STALE_MS } from './ops-status.ts';
import * as owner from './owner.ts';
import type { DeckMutationInput, OwnerDeps, OwnerResult } from './owner.ts';
import { activeGuard, aiStopped, runAlarm, type Deps } from './pipeline.ts';
import { Store } from './store.ts';

/** Name of the single object instance. */
export const LAB_OBJECT = 'lab-v1';
/** Delay of a woken alarm. */
const WAKE_MS = 1_000;
/** Next attempt after an unexpected alarm failure. */
const ALARM_ERROR_RETRY_MS = 5 * MINUTE;

export class LabState extends DurableObject<Env> {
  private readonly store: Store;
  private ownerChain: Promise<unknown> = Promise.resolve();
  private pipelineChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    void ctx.blockConcurrencyWhile(() => {
      this.store.migrate();
      return Promise.resolve();
    });
  }

  private serial<T>(chain: 'owner' | 'pipeline', fn: () => Promise<T>): Promise<T> {
    const previous = chain === 'owner' ? this.ownerChain : this.pipelineChain;
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    if (chain === 'owner') this.ownerChain = settled;
    else this.pipelineChain = settled;
    return run;
  }

  private manualAlarms(): boolean {
    return this.env.DEV_MANUAL_ALARMS === 'true';
  }

  private deps(): Deps {
    return { store: this.store, db: this.env.DB, ai: this.env.AI, env: this.env, fetcher: fetch.bind(globalThis) };
  }

  private ownerDeps(): OwnerDeps {
    return { store: this.store, db: this.env.DB, env: this.env, todofy: this.env.TODOFY };
  }

  // ---- scheduling ------------------------------------------------------------------------------------

  /**
   * Arms the alarm if none is set: every GetToday and every ops-v1 status() (the dashboard's
   * 30-minute tick), so the pipeline starts after a deploy without the owner opening the UI. The deploy
   * probe cannot do it: Access answers its unauthenticated requests before they reach the Worker.
   */
  async ensureAlarm(): Promise<void> {
    if (this.manualAlarms()) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WAKE_MS);
  }

  /** Brings the next alarm forward (new seeds, settings changed, guard lifted). */
  private async wake(): Promise<void> {
    if (this.manualAlarms()) return;
    const at = await this.ctx.storage.getAlarm();
    const soon = Date.now() + WAKE_MS;
    if (at === null || at > soon) await this.ctx.storage.setAlarm(soon);
  }

  override async alarm(): Promise<void> {
    await this.step(Date.now());
  }

  /**
   * One pipeline slice at `now`, then re-arm. The alarm handler calls it with the clock; the workerd tests
   * call it through the object binding (never reachable over HTTP) with DEV_MANUAL_ALARMS=true.
   */
  async step(now: number): Promise<{ next: number }> {
    return this.serial('pipeline', async () => {
      let next = now + ALARM_ERROR_RETRY_MS;
      try {
        next = (await runAlarm(this.deps(), now)).next;
      } catch (error) {
        console.log(JSON.stringify({ event: 'alarm_failed', code: error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'error' }));
      }
      if (!this.manualAlarms()) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + WAKE_MS));
      return { next };
    });
  }

  // ---- views -------------------------------------------------------------------------------------------

  async today(): Promise<TodayResponse> {
    await this.ensureAlarm();
    const now = Date.now();
    const { results } = await this.env.DB.prepare(
      `SELECT d.deck_id, d.kind, d.size, d.finished_at,
         (SELECT count(*) FROM deck_cards c WHERE c.deck_id = d.deck_id AND c.decision IS NOT NULL) AS decided
       FROM decks d WHERE d.ready_at IS NOT NULL ORDER BY d.deck_id DESC LIMIT 8`,
    ).all<{ deck_id: string; kind: 'ranked' | 'explore'; size: number; finished_at: number | null; decided: number }>();
    const pointers: DeckPointer[] = results.map((row) => ({
      deck_id: row.deck_id,
      kind: row.kind,
      total: row.size,
      decided: row.decided,
      finished: row.finished_at !== null,
    }));
    const [deck, ...older] = pointers;
    const oldest = addDays(utcDay(now), -DECK_OFFER_DAYS);
    const store = this.store;
    const fetchNext = store.getNumber('fetch_next_at');
    const paused = store.get('mirror_ingest_paused') === '1' || activeGuard(store, now) !== null;
    const capped = aiStopped(store, now);
    const lastOk = store.getNumber('fetch_last_ok_at') ?? store.getNumber('bootstrap_at');
    const stale = lastOk !== null && now - lastOk > FEED_STALE_MS;
    const job = store.one<{ day: string; phase: string }>("SELECT day, phase FROM jobs WHERE phase IN ('embedding', 'ranking', 'briefing') ORDER BY day LIMIT 1");
    let building: TodayResponse['building'] = null;
    if (job !== undefined) {
      const phase: BuildPhase = paused ? 'paused' : capped && job.phase !== 'ranking' ? 'cap_hit' : job.phase === 'embedding' ? 'embedding' : job.phase === 'ranking' ? 'ranking' : 'summarizing';
      building = { day: job.day, phase };
    } else if (paused) {
      building = { day: null, phase: 'paused' };
    } else if ((store.getNumber('fetch_failures') ?? 0) > 0 || store.get('fetch_last_error') !== null) {
      building = { day: null, phase: 'failed' };
    } else if (fetchNext !== null && fetchNext <= now) {
      building = { day: null, phase: 'fetching' };
    } else if (deck === undefined) {
      building = { day: null, phase: 'waiting' };
    }
    const liked = store.one("SELECT paper_id FROM labels WHERE label = 'like' LIMIT 1") !== undefined;
    const seeded = store.one("SELECT paper_id FROM seed_ids WHERE state = 'resolved' LIMIT 1") !== undefined;
    return {
      deck: deck ?? null,
      building,
      next_run_at: fetchNext === null ? null : iso(fetchNext),
      cold_start: !liked && !seeded,
      older_unfinished: older.filter((p) => !p.finished && p.deck_id >= oldest),
      notice: capped ? 'cap_hit' : paused ? 'paused' : stale ? 'feed_stale' : null,
    };
  }

  statusView(): StatusResponse {
    const now = Date.now();
    const status = labStatus(this.store, this.env, now);
    const guard = guardState(this.store, now);
    const lastOk = this.store.getNumber('fetch_last_ok_at');
    const counters = status.counters as Record<string, number | undefined>;
    return {
      counters: {
        ingested_24h: counters['ingested_24h'] ?? 0,
        ranked_24h: counters['ranked_24h'] ?? 0,
        liked_7d: counters['liked_7d'] ?? 0,
        decided_7d: counters['decided_7d'] ?? 0,
        neurons_today: counters['neurons_today'] ?? 0,
        neuron_cap: counters['neuron_cap'] ?? 0,
      },
      last_fetch_at: lastOk === null ? null : iso(lastOk),
      last_fetch_error: this.store.get('fetch_last_error'),
      guard: { level: guard.level, until: guard.until },
      build: buildSha(this.env),
    };
  }

  // ---- ops-v1 -------------------------------------------------------------------------------------------

  async opsStatus(): Promise<wire.OpsStatus> {
    await this.ensureAlarm();
    return labStatus(this.store, this.env, Date.now());
  }

  /** The armed alarm's time, or null (workerd tests and diagnostics; never reachable over HTTP). */
  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async opsSetGuard(input: unknown): Promise<{ ok: wire.GuardState } | { error: 'invalid_input' }> {
    const result = setGuard(this.store, input, Date.now());
    if ('ok' in result && result.ok.level === 'normal') await this.wake();
    return result;
  }

  // ---- owner mutations (one at a time) ----------------------------------------------------------------

  mutateDeck(deckId: string, input: DeckMutationInput): Promise<OwnerResult<DeckMutationResponse>> {
    return this.serial('owner', () => owner.mutateDeck(this.ownerDeps(), deckId, input, Date.now()));
  }

  exclude(deckId: string, opId: string, paperId: string, excluded: boolean): Promise<OwnerResult<DeckSummary>> {
    return this.serial('owner', () => owner.exclude(this.ownerDeps(), deckId, opId, paperId, excluded, Date.now()));
  }

  later(deckId: string, opId: string): Promise<OwnerResult<{ readonly later_at: string }>> {
    return this.serial('owner', () => owner.later(this.ownerDeps(), deckId, opId, Date.now()));
  }

  send(deckId: string, opId: string, mode: SendMode): Promise<OwnerResult<SendStatus>> {
    return this.serial('owner', () => owner.send(this.ownerDeps(), deckId, opId, mode, Date.now()));
  }

  pollSend(deckId: string): Promise<OwnerResult<SendStatus | null>> {
    return this.serial('owner', () => owner.pollSend(this.ownerDeps(), deckId, Date.now()));
  }

  feedback(opId: string, paperId: string, label: Decision | null, create = false): Promise<OwnerResult<FeedbackResponse>> {
    return this.serial('owner', () => owner.feedback(this.ownerDeps(), opId, paperId, label, Date.now(), create));
  }

  async addSeeds(opId: string, ids: readonly string[]): Promise<OwnerResult<SeedsResponse>> {
    const result = await this.serial('owner', () => owner.addSeeds(this.ownerDeps(), opId, ids, Date.now()));
    if (result.ok) await this.wake();
    return result;
  }

  removeSeed(opId: string, paperId: string): Promise<OwnerResult<SeedsResponse>> {
    return this.serial('owner', () => owner.removeSeed(this.ownerDeps(), opId, paperId, Date.now()));
  }

  async putSettings(opId: string, patch: Partial<Settings>): Promise<OwnerResult<SettingsResponse>> {
    const result = await this.serial('owner', () => owner.putSettings(this.ownerDeps(), opId, patch, Date.now()));
    if (result.ok) await this.wake();
    return result;
  }
}
