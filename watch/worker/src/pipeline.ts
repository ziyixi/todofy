/**
 * One scheduled check of one watch (../../docs/design.md §5): the deterministic noise pipeline from the fetch to the
 * recorded change, in order.
 *
 *   0. fetch and health gate (obtain.ts, extract/, health.ts): a failure counts toward BROKEN (3 in a row; its digest
 *      line once per run of failures) and pauses the watch after 14 days; it is never "no change";
 *   1. short-circuit: a 304, or the same raw bytes read with the same settings, skips the parse and the snapshot and
 *      writes only the scheduling rows (the watch and its host);
 *   2. extraction (extract/), 3. normalization and masks (content.ts, normalize.ts);
 *   4. the diff against the notified state, 5. the typed trigger (triggers.ts);
 *   6. the confirmation fetch about 15 minutes later, for HTML sources only: the same new text confirms; the page back at
 *      its notified state within the window is a flicker (suppressed for AnyChangeTrigger, confirmed as `reverted` for
 *      typed triggers); a third version is evaluated again, and decided as it stands after CONFIRM_ATTEMPTS_MAX. The
 *      window is CONFIRM_WINDOW_DELAYS delays from the detection: a confirmation that keeps failing is retried at the
 *      confirmation pace only within it, and after it the change is confirmed as it was seen (with a note), never
 *      dropped; a revert seen after it is a confirmed, reverted change, never a flicker;
 *   7. the AI judge: off in v1 (judge.ts);
 *   8. the record: every suppressed difference keeps its reason; a confirmed one moves the notified state and goes to
 *      the notification outbox (notify.ts). In shadow mode a difference the rules would drop is confirmed anyway, with
 *      the reason it would have had.
 *
 * A difference is recorded once: the text last processed (`seen_sha`) is not evaluated again until it changes, so a page
 * that stays below its threshold does not fill the drawer. The first check after creation, and after a change of what
 * is read, only sets the notified state; a change still pending then is confirmed as it was seen, with a note (the
 * owner hears of it; its confirmation cannot be compared any more). The owner's ignored lines are dropped from both
 * sides of every comparison (content.ts viewOf): ignoring a line keeps the notified state and a pending change, which
 * the confirmation fetch evaluates again under the new settings.
 *
 * The request is recorded on the watch as soon as it was made (`last_fetch_at`), whatever follows: a later error, or
 * the owner's edit meanwhile. The check's other writes go in one transaction after every await (the page was fetched
 * and parsed, the snapshot gzipped), and only if the watch's settings did not change meanwhile (an owner's update wins;
 * the result is dropped). A check that throws after its fetch is recorded as INTERNAL_ERROR (`recordInternalError`):
 * it counts toward BROKEN and the auto-pause, and waits at least the URL's 15 minutes. Nothing here logs: the alarm
 * logs counts.
 */
import { readConfig, settingsWatch, type WatchConfig } from './config.ts';
import { buildContent, contentSha, viewOf, type Content } from './content.ts';
import { confirmAt, earliestFetch, nextCheckAt, nextUtcMidnight } from './etiquette.ts';
import { extract } from './extract/index.ts';
import type { FailureCode } from './health.ts';
import { changeId } from './ids.ts';
import type { ChangeJudge } from './judge.ts';
import { ALARM_ERROR_RETRY_MS, AUTO_PAUSE_AFTER_MS, BROKEN_AFTER_FAILURES, CONFIRM_ATTEMPTS_MAX, CONFIRM_DELAY, CONFIRM_WINDOW_DELAYS, MINUTE, URL_MIN_SPACING_MS } from './limits.ts';
import { browserNextAt, obtain, type Budget, type ObtainDeps } from './obtain.ts';
import { decodeSnapshot, encodeSnapshot } from './snapshot.ts';
import type { ChangeRow, WatchRow } from './store.ts';
import { evaluate, keptDiff, LATE_REVERT_SUMMARY, NOTE_SETTINGS_CHANGED, NOTE_UNCONFIRMED, REVERTED_SUMMARY, type Evaluation, type SuppressionCode } from './triggers.ts';

export interface CheckDeps extends ObtainDeps {
  /** Runs `fn` as one SQLite transaction (ctx.storage.transactionSync). */
  readonly transact: <T>(fn: () => T) => T;
  /** The AI judge (null in v1). */
  readonly judge: ChangeJudge | null;
}

export type CheckOutcome = 'missing' | 'deferred' | 'stale' | 'failed' | 'not_modified' | 'unchanged' | 'changed';

/** A config read back from storage: it was checked when saved, so only its shape matters here. */
export function storedConfig(row: Pick<WatchRow, 'settings'>): WatchConfig {
  const config = readConfig(settingsWatch(row.settings), { selectorOk: () => true, browserEnabled: true });
  if (typeof config === 'string') throw new Error('stored_settings_invalid');
  return config;
}

interface Scheduling {
  /** When the check started. */
  readonly now: number;
  /** When its request to the watched URL started (null: none was sent). */
  readonly fetchedAt: number | null;
}

/** How long after its detection a pending change is decided at the confirmation pace. */
export function confirmWindowMs(config: WatchConfig): number {
  return CONFIRM_WINDOW_DELAYS * (config.confirmDelayMinutes ?? CONFIRM_DELAY.defaultMinutes) * MINUTE + URL_MIN_SPACING_MS;
}

/** The next check after a successful one (a pending change's confirmation comes first). */
function nextAfterSuccess(row: WatchRow, config: WatchConfig, at: Scheduling, confirmTime: number | null, paused: boolean): number | null {
  const lastFetch = at.fetchedAt ?? row.last_fetch_at;
  if (confirmTime !== null) return Math.max(confirmTime, (lastFetch ?? 0) + URL_MIN_SPACING_MS);
  if (paused) return null;
  return nextCheckAt(row.id, at.now, config.intervalMinutes, lastFetch);
}

/** The writes of a successful check that every outcome shares. */
function successFields(row: WatchRow, config: WatchConfig, at: Scheduling, outcome: 'changed' | 'unchanged' | 'not_modified', status: number, confirmTime: number | null): Partial<WatchRow> {
  const paused = row.state === 'paused';
  return {
    state: paused ? 'paused' : 'active',
    last_check_at: at.now,
    last_success_at: at.now,
    last_outcome: outcome,
    last_failure: null,
    last_http_status: status,
    failures: 0,
    failure_start: null,
    check_requested: 0,
    next_check_at: nextAfterSuccess(row, config, at, confirmTime, paused),
    ...(at.fetchedAt !== null ? { last_fetch_at: at.fetchedAt } : {}),
  };
}

/** Applies a failed check: counts, BROKEN, the auto-pause, the next try, and a pending change past its window. */
function applyFailure(deps: CheckDeps, row: WatchRow, config: WatchConfig, at: Scheduling, failure: FailureCode, status: number, retryAfter: number | null): void {
  const failures = row.failures + 1;
  const start = row.failure_start ?? at.now;
  let state = row.state;
  let pauseReason = row.pause_reason;
  const events: ('watch_broken' | 'watch_paused')[] = [];
  if (state !== 'paused' && at.now - start >= AUTO_PAUSE_AFTER_MS) {
    state = 'paused';
    pauseReason = 'broken_too_long';
    events.push('watch_paused');
  } else if (state === 'active' && failures >= BROKEN_AFTER_FAILURES) {
    state = 'broken';
    events.push('watch_broken');
  }
  const lastFetch = at.fetchedAt ?? row.last_fetch_at;
  const pending = row.pending_change === null ? undefined : deps.store.change(row.id, row.pending_change);
  const windowOpen = pending !== undefined && at.now <= pending.detect_time + confirmWindowMs(config);
  let next: number | null = state === 'paused' ? null : nextCheckAt(row.id, at.now, config.intervalMinutes, lastFetch);
  if (next !== null && windowOpen && config.confirmDelayMinutes !== null) {
    // Within its window a pending change is retried at its confirmation pace, not the regular one.
    next = Math.min(next, Math.max(at.now + config.confirmDelayMinutes * MINUTE, (lastFetch ?? 0) + URL_MIN_SPACING_MS));
  }
  if (next !== null && failure === 'INTERNAL_ERROR') {
    // A bug must not become a fetch loop: the delay doubles with every failure in a row, up to the regular interval.
    next = Math.min(next, Math.max(at.now + ALARM_ERROR_RETRY_MS * 2 ** Math.min(row.failures, 8), (lastFetch ?? 0) + URL_MIN_SPACING_MS));
  }
  if (next !== null && retryAfter !== null) next = Math.max(next, at.now + retryAfter);
  if (next !== null && failure === 'JS_QUOTA_EXHAUSTED') next = Math.max(next, nextUtcMidnight(at.now));
  deps.transact(() => {
    deps.store.updateWatch(row.id, {
      state,
      pause_reason: pauseReason,
      last_check_at: at.now,
      last_outcome: 'failed',
      last_failure: failure,
      last_http_status: status,
      failures,
      failure_start: start,
      check_requested: 0,
      next_check_at: next,
      ...(at.fetchedAt !== null ? { last_fetch_at: at.fetchedAt } : {}),
    });
    for (const kind of events) deps.store.enqueue(kind, row.id, null, 'digest', at.now);
    // Past its window the change is decided as it was seen: the page showed it, and nothing refuted it.
    if (pending !== undefined && !windowOpen) decideAsSeen(deps, row, config, pending, at.now, NOTE_UNCONFIRMED);
  });
}

/** Confirms a pending change as it was seen (no confirmation fetch could compare it), with `note` in its summary. */
function decideAsSeen(deps: CheckDeps, row: WatchRow, config: WatchConfig, pending: ChangeRow, now: number, note: string): void {
  deps.store.updateChange(pending.id, { state: 'confirmed', resolve_time: now, summary: `${pending.summary}${note}`, before_snapshot_id: null });
  deps.store.updateWatch(row.id, { pending_change: null, ...(pending.snapshot_id === null ? {} : { baseline_id: pending.snapshot_id }) });
  deps.store.enqueue('change_confirmed', row.id, pending.id, config.notify, now);
}

/**
 * Records a check that threw after it started (a bug, a storage error) as a failure of its own, INTERNAL_ERROR: it
 * counts toward BROKEN and the auto-pause like any failure, and is retried with a growing delay, never sooner than
 * URL_MIN_SPACING_MS after the watch's last request (written as soon as the request was made).
 */
export function recordInternalError(deps: CheckDeps, id: string, now: number): void {
  const row = deps.store.watch(id);
  if (row === undefined) return;
  let config: WatchConfig;
  try {
    config = storedConfig(row);
  } catch {
    deps.store.updateWatch(id, { next_check_at: Math.max(now + ALARM_ERROR_RETRY_MS, (row.last_fetch_at ?? 0) + URL_MIN_SPACING_MS), check_requested: 0 });
    return;
  }
  applyFailure(deps, row, config, { now, fetchedAt: null }, 'INTERNAL_ERROR', row.last_http_status, null);
}

/** A new change row (its fields from an evaluation). */
function changeRow(row: WatchRow, now: number, evaluation: Evaluation, state: ChangeRow['state'], suppression: SuppressionCode | null, shadow: boolean, snapshotId: number | null): ChangeRow {
  const kept = keptDiff(evaluation.diff);
  return {
    id: changeId(now),
    watch_id: row.id,
    state,
    suppression,
    shadow: shadow ? 1 : 0,
    classifier: 'RULE',
    trigger_kind: evaluation.kind,
    summary: evaluation.summary,
    added: evaluation.added,
    removed: evaluation.removed,
    diff: JSON.stringify(kept.lines),
    truncated: kept.truncated ? 1 : 0,
    reverted: 0,
    previous_value: evaluation.previous,
    current_value: evaluation.current,
    detect_time: now,
    resolve_time: state === 'pending' ? null : now,
    ack_time: null,
    snapshot_id: snapshotId,
    before_snapshot_id: null,
    attempts: 0,
  };
}

/** Whether shadow mode runs for the watch at `now`. */
function shadowOn(row: WatchRow, now: number): boolean {
  return row.shadow_end !== null && row.shadow_end > now;
}

/** The SHA of a compared text: the stored one when the view dropped nothing. */
async function viewSha(view: Content, content: Content, sha: string): Promise<string> {
  return view === content ? sha : contentSha(view);
}

/** One check of the watch `id`, started at `now`. */
export async function runCheck(deps: CheckDeps, id: string, now: number, budget: Budget): Promise<CheckOutcome> {
  const row = deps.store.watch(id);
  if (row === undefined) return 'missing';
  const config = storedConfig(row);

  // Etiquette: the host's spacing and backoff, the page's own 15 minutes (a preview's fetch too), the browser's spacing.
  let earliest = earliestFetch(now, deps.store.host(row.host) ?? null, row.last_fetch_at);
  const urlFetched = deps.store.urlFetchedAt(config.uri, now);
  if (urlFetched !== null) earliest = Math.max(earliest, urlFetched + URL_MIN_SPACING_MS);
  if (config.fetcher === 'browser') earliest = Math.max(earliest, browserNextAt(deps.store));
  if (earliest > now) {
    deps.store.updateWatch(id, { next_check_at: earliest });
    return 'deferred';
  }

  const sameSettings = row.raw_check_hash === row.check_hash;
  const conditional = sameSettings && (row.http_etag !== null || row.http_last_modified !== null) ? { etag: row.http_etag, lastModified: row.http_last_modified } : null;
  const obtained = await obtain(deps, config, budget, conditional);

  // The request counts for the URL's 15 minutes at once, whatever follows (an error below, the owner's edit meanwhile).
  const current = deps.store.watch(id);
  if (current !== undefined && obtained.fetchedAt !== null && sameUri(current, row)) deps.store.updateWatch(id, { last_fetch_at: obtained.fetchedAt });
  // The owner may have changed or deleted the watch while it was fetched: their write wins.
  if (current?.check_hash !== row.check_hash) return 'stale';
  const at: Scheduling = { now, fetchedAt: obtained.fetchedAt };

  if (obtained.kind === 'deferred') {
    // A host on the way was busy or backing off (no failure of the page).
    deps.store.updateWatch(id, { next_check_at: Math.max(obtained.until, (obtained.fetchedAt ?? current.last_fetch_at ?? 0) + (obtained.fetched ? URL_MIN_SPACING_MS : 0)) });
    return 'deferred';
  }
  if (obtained.kind === 'failed') {
    applyFailure(deps, current, config, at, obtained.failure, obtained.status, obtained.retryAfter);
    return 'failed';
  }

  // Stage 1: the short-circuit.
  let rawSha: string | null = null;
  if (obtained.kind === 'answer') {
    const digest = await crypto.subtle.digest('SHA-256', obtained.body);
    rawSha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const sameBytes = obtained.kind === 'not_modified' || (rawSha === current.raw_sha && sameSettings);
  const validators = obtained.kind === 'answer' ? { http_etag: obtained.etag, http_last_modified: obtained.lastModified, raw_sha: rawSha, raw_check_hash: current.check_hash } : {};
  const outcomeOfSame = obtained.kind === 'not_modified' ? 'not_modified' : 'unchanged';

  let content: Content;
  let sha: string;
  if (sameBytes && current.pending_change === null && current.seen_check_hash === current.check_hash && current.baseline_id !== null && current.baseline_read_hash === current.read_hash) {
    deps.store.updateWatch(id, { ...successFields(current, config, at, outcomeOfSame, obtained.status, null), ...validators });
    return outcomeOfSame;
  }
  if (sameBytes && current.pending_change !== null) {
    // The pending candidate came from these very bytes.
    const pending = deps.store.change(id, current.pending_change);
    const snapshot = pending?.snapshot_id === null || pending === undefined ? undefined : deps.store.snapshot(pending.snapshot_id);
    if (snapshot === undefined) throw new Error('pending_snapshot_missing');
    content = await decodeSnapshot(snapshot.body);
    sha = snapshot.sha;
  } else {
    if (obtained.kind !== 'answer') {
      // A 304 for settings whose text was never read (cannot happen: validators are sent only with the same settings).
      deps.store.updateWatch(id, { ...successFields(current, config, at, 'not_modified', obtained.status, null) });
      return 'not_modified';
    }
    // Stages 2 and 3.
    const extraction = await extract({ source: config.source, contentType: obtained.contentType, body: obtained.body, url: obtained.finalUrl, blocks: false });
    if (!extraction.ok) {
      applyFailure(deps, current, config, at, extraction.failure, obtained.status, null);
      return 'failed';
    }
    const built = buildContent(extraction.page, config.normalize, config.trigger);
    if (!built.ok) {
      applyFailure(deps, current, config, at, built.failure, obtained.status, null);
      return 'failed';
    }
    content = built.content;
    sha = await contentSha(content);
  }
  const masked = !sameBytes && sha === current.seen_sha && current.seen_check_hash === current.check_hash ? 1 : 0;
  const seen = { seen_sha: sha, seen_check_hash: current.check_hash, ...validators };
  const insert = (encoded: { bytes: Uint8Array; lines: number }) => deps.store.insertSnapshot(id, now, sha, encoded.lines, encoded.bytes);

  // No notified state yet, or what is read changed: this text becomes the notified state, without a change. A change
  // still pending was found with the old settings and cannot be confirmed against the new ones: it is confirmed as
  // it was seen, with a note, rather than dropped.
  if (current.baseline_id === null || current.baseline_read_hash !== current.read_hash) {
    const pending = current.pending_change === null ? undefined : deps.store.change(id, current.pending_change);
    const encoded = await encodeSnapshot(content);
    deps.transact(() => {
      if (pending !== undefined) decideAsSeen(deps, current, config, pending, now, NOTE_SETTINGS_CHANGED);
      const snapshotId = insert(encoded);
      deps.store.updateWatch(id, {
        ...successFields(current, config, at, 'unchanged', obtained.status, null),
        ...seen,
        seen_snapshot_id: snapshotId,
        baseline_id: snapshotId,
        baseline_read_hash: current.read_hash,
        pending_change: null,
      });
    });
    return 'unchanged';
  }
  const baselineRow = deps.store.snapshot(current.baseline_id);
  if (baselineRow === undefined) throw new Error('baseline_missing');
  const ignored = config.normalize.ignoredLines;
  const baselineText = await decodeSnapshot(baselineRow.body);
  const baseline = viewOf(baselineText, ignored).content;
  const baselineSha = await viewSha(baseline, baselineText, baselineRow.sha);
  const view = viewOf(content, ignored).content;
  const shaOfView = await viewSha(view, content, sha);
  const shadow = shadowOn(current, now);
  /** A stored text as compared: the notified state's when the snapshot is gone (it never is: prune keeps it). */
  const textOf = async (snapshotId: number | null): Promise<Content> => {
    if (snapshotId === null || snapshotId === baselineRow.id) return baseline;
    const row = deps.store.snapshot(snapshotId);
    return row === undefined ? baseline : viewOf(await decodeSnapshot(row.body), ignored).content;
  };

  // Stage 6: a pending change's confirmation.
  if (current.pending_change !== null) {
    const pending = deps.store.change(id, current.pending_change);
    const candidate = pending?.snapshot_id == null ? undefined : deps.store.snapshot(pending.snapshot_id);
    if (pending === undefined || candidate === undefined) {
      deps.store.updateWatch(id, { pending_change: null, next_check_at: now });
      return 'stale';
    }
    const candidateText = await decodeSnapshot(candidate.body);
    const candidateView = viewOf(candidateText, ignored).content;
    const candidateSha = await viewSha(candidateView, candidateText, candidate.sha);
    // The owner changed the trigger, the confirmation or the ignored lines since the change was found.
    const settingsChanged = current.seen_check_hash !== current.check_hash;
    const windowOpen = now <= pending.detect_time + confirmWindowMs(config);
    const fieldsOf = (evaluation: Evaluation) => {
      const kept = keptDiff(evaluation.diff);
      return {
        summary: evaluation.summary,
        added: evaluation.added,
        removed: evaluation.removed,
        diff: JSON.stringify(kept.lines),
        truncated: kept.truncated ? 1 : 0,
        previous_value: evaluation.previous,
        current_value: evaluation.current,
      };
    };
    if (shaOfView === candidateSha) {
      // The same new text: confirmed, and the notified state moves to it. Under changed settings it is evaluated again
      // first (the same edge, from the text before it): what the new rules drop is suppressed with its reason.
      const evaluation = settingsChanged ? evaluate(config.trigger, baseline, await textOf(pending.before_snapshot_id), view) : null;
      deps.transact(() => {
        const seenNow = { ...seen, seen_snapshot_id: candidate.id };
        if (evaluation === null) confirmIn(deps, current, config, at, obtained.status, pending, candidate.id, seenNow, {});
        else if (evaluation.fired || shadow) confirmIn(deps, current, config, at, obtained.status, pending, candidate.id, seenNow, { ...fieldsOf(evaluation), ...(evaluation.fired ? {} : { shadow: 1, suppression: evaluation.reason }) });
        else {
          deps.store.updateChange(pending.id, { ...fieldsOf(evaluation), state: 'suppressed', suppression: evaluation.reason, resolve_time: now, snapshot_id: null, before_snapshot_id: null });
          deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, null), ...seenNow, pending_change: null });
        }
      });
      return 'changed';
    }
    if (shaOfView === baselineSha) {
      const typed = config.trigger.kind !== 'any_change';
      deps.transact(() => {
        if (!windowOpen) {
          // B stayed longer than the window (its confirmation could not be fetched): it happened, and it went back.
          confirmIn(deps, current, config, at, obtained.status, pending, null, { ...seen, seen_snapshot_id: baselineRow.id }, { reverted: 1, summary: LATE_REVERT_SUMMARY });
        } else if (typed || shadow) {
          // A -> B -> A within the window: the notified state stays.
          confirmIn(deps, current, config, at, obtained.status, pending, null, { ...seen, seen_snapshot_id: baselineRow.id }, {
            reverted: 1,
            summary: REVERTED_SUMMARY,
            ...(typed ? {} : { shadow: 1, suppression: 'FLICKER' as const }),
          });
        } else {
          deps.store.updateChange(pending.id, { state: 'suppressed', suppression: 'FLICKER', resolve_time: now, summary: REVERTED_SUMMARY, snapshot_id: null, before_snapshot_id: null });
          deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, null), ...seen, seen_snapshot_id: baselineRow.id, pending_change: null });
        }
      });
      return 'changed';
    }
    // A third version: evaluated again, from the text before the pending change.
    const evaluation = evaluate(config.trigger, baseline, await textOf(pending.before_snapshot_id), view);
    const encoded = await encodeSnapshot(content);
    const fields = fieldsOf(evaluation);
    deps.transact(() => {
      const snapshotId = insert(encoded);
      const seenNow = { ...seen, seen_snapshot_id: snapshotId };
      if (evaluation.fired && pending.attempts + 1 < CONFIRM_ATTEMPTS_MAX && windowOpen) {
        deps.store.updateChange(pending.id, { ...fields, snapshot_id: snapshotId, attempts: pending.attempts + 1 });
        const confirmTime = confirmAt(id, at.fetchedAt ?? now, config.confirmDelayMinutes ?? CONFIRM_DELAY.defaultMinutes);
        deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, confirmTime), ...seenNow });
      } else if (evaluation.fired || shadow) {
        confirmIn(deps, current, config, at, obtained.status, pending, snapshotId, seenNow, { ...fields, ...(evaluation.fired ? {} : { shadow: 1, suppression: evaluation.reason }) });
      } else {
        deps.store.updateChange(pending.id, { ...fields, state: 'suppressed', suppression: evaluation.reason, resolve_time: now, snapshot_id: null, before_snapshot_id: null });
        deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, null), ...seenNow, pending_change: null });
      }
    });
    return 'changed';
  }

  // Nothing new since the previous check.
  if (sha === current.seen_sha && current.seen_check_hash === current.check_hash) {
    deps.store.updateWatch(id, { ...successFields(current, config, at, 'unchanged', obtained.status, null), ...seen, masked_count: current.masked_count + masked });
    return 'unchanged';
  }
  const previous = await textOf(current.seen_snapshot_id);
  // Back at the notified state (but for ignored lines): nothing to record, and it is the previous check's text from now on.
  if (shaOfView === baselineSha) {
    deps.store.updateWatch(id, { ...successFields(current, config, at, 'unchanged', obtained.status, null), ...seen, seen_snapshot_id: baselineRow.id });
    return 'unchanged';
  }

  // Stages 4 and 5 (step 7, the AI judge, is off in v1: `deps.judge` is null and no watch may enable it).
  const evaluation = evaluate(config.trigger, baseline, previous, view);
  const encoded = await encodeSnapshot(content);
  deps.transact(() => {
    const snapshotId = insert(encoded);
    const seenNow = { ...seen, seen_snapshot_id: snapshotId };
    if (!evaluation.fired && !shadow) {
      deps.store.insertChange(changeRow(current, now, evaluation, 'suppressed', evaluation.reason, false, null));
      deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, null), ...seenNow });
    } else if (evaluation.fired && config.confirmDelayMinutes !== null) {
      const change = { ...changeRow(current, now, evaluation, 'pending', null, false, snapshotId), before_snapshot_id: current.seen_snapshot_id ?? baselineRow.id };
      deps.store.insertChange(change);
      const confirmTime = confirmAt(id, at.fetchedAt ?? now, config.confirmDelayMinutes);
      deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, confirmTime), ...seenNow, pending_change: change.id });
    } else {
      // Confirmed at once: a feed or structured source, skip_confirmation, or shadow mode keeping what would be dropped.
      const change = changeRow(current, now, evaluation, 'confirmed', evaluation.fired ? null : evaluation.reason, !evaluation.fired, snapshotId);
      deps.store.insertChange(change);
      deps.store.updateWatch(id, { ...successFields(current, config, at, 'changed', obtained.status, null), ...seenNow, baseline_id: snapshotId });
      deps.store.enqueue('change_confirmed', id, change.id, config.notify, now);
    }
  });
  return 'changed';
}

/** Whether two rows of a watch fetch the same URL (the stored settings hold the checked URI). */
function sameUri(a: Pick<WatchRow, 'settings'>, b: Pick<WatchRow, 'settings'>): boolean {
  if (a.settings === b.settings) return true;
  return (JSON.parse(a.settings) as { uri?: string }).uri === (JSON.parse(b.settings) as { uri?: string }).uri;
}

/**
 * Confirms a pending change inside a transaction: the change becomes CONFIRMED, the notified state moves to
 * `baselineId` (null: a revert keeps it), and the outbox gets the event.
 */
function confirmIn(deps: CheckDeps, row: WatchRow, config: WatchConfig, at: Scheduling, status: number, pending: ChangeRow, baselineId: number | null, seen: Partial<WatchRow>, fields: Partial<ChangeRow>): void {
  deps.store.updateChange(pending.id, { ...fields, state: 'confirmed', resolve_time: at.now, snapshot_id: baselineId, before_snapshot_id: null });
  deps.store.updateWatch(row.id, {
    ...successFields(row, config, at, 'changed', status, null),
    ...seen,
    pending_change: null,
    ...(baselineId === null ? {} : { baseline_id: baselineId }),
  });
  deps.store.enqueue('change_confirmed', row.id, pending.id, config.notify, at.now);
}
