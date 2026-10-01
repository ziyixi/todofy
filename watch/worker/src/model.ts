/**
 * Rows as watch.ui.v1 messages (../../docs/design.md §6): a watch row (its stored settings plus the scheduler's state)
 * as a Watch, a change row as a Change. Pure; times are epoch milliseconds in the rows and Timestamps on the wire.
 */
import { Change_Classifier, Change_State, Change_SuppressionReason, Change_TriggerKind, ChangeSchema, DiffLine_Kind, type Change } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { FailureReason, Watch_PauseReason, Watch_State, WatchHealth_Outcome, WatchHealthSchema, WatchSchema, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { settingsWatch } from './config.ts';
import type { FailureCode } from './health.ts';
import type { ChangeRow, ChangeStateName, WatchRow } from './store.ts';

export const WATCH_STATE: Readonly<Record<WatchRow['state'], Watch_State>> = { active: Watch_State.ACTIVE, paused: Watch_State.PAUSED, broken: Watch_State.BROKEN };

export const CHANGE_STATE: Readonly<Record<ChangeStateName, Change_State>> = {
  pending: Change_State.PENDING_CONFIRMATION,
  confirmed: Change_State.CONFIRMED,
  suppressed: Change_State.SUPPRESSED,
  acknowledged: Change_State.ACKNOWLEDGED,
};

const OUTCOME: Readonly<Record<string, WatchHealth_Outcome>> = {
  changed: WatchHealth_Outcome.CHANGED,
  unchanged: WatchHealth_Outcome.UNCHANGED,
  not_modified: WatchHealth_Outcome.NOT_MODIFIED,
  failed: WatchHealth_Outcome.FAILED,
};

const TRIGGER_KIND: Readonly<Record<string, Change_TriggerKind>> = {
  any_change: Change_TriggerKind.ANY_CHANGE,
  text_appears: Change_TriggerKind.TEXT_APPEARS,
  text_disappears: Change_TriggerKind.TEXT_DISAPPEARS,
  new_item: Change_TriggerKind.NEW_ITEM,
  number: Change_TriggerKind.NUMBER,
  availability: Change_TriggerKind.AVAILABILITY,
};

const SUPPRESSION: Readonly<Record<string, Change_SuppressionReason>> = {
  BELOW_THRESHOLD: Change_SuppressionReason.BELOW_THRESHOLD,
  TRIGGER_NOT_MET: Change_SuppressionReason.TRIGGER_NOT_MET,
  FLICKER: Change_SuppressionReason.FLICKER,
};

/** The FailureReason value of a failure code (the codes are its names). */
export function failureReason(code: FailureCode | null): FailureReason {
  if (code === null) return FailureReason.UNSPECIFIED;
  return (FailureReason as Record<string, FailureReason>)[code] ?? FailureReason.UNSPECIFIED;
}

/** The trigger kind of the Change enum. */
export function triggerKind(kind: string): Change_TriggerKind {
  return TRIGGER_KIND[kind] ?? Change_TriggerKind.UNSPECIFIED;
}

/** The suppression reason of the Change enum. */
export function suppressionReason(code: string | null): Change_SuppressionReason {
  return code === null ? Change_SuppressionReason.UNSPECIFIED : (SUPPRESSION[code] ?? Change_SuppressionReason.UNSPECIFIED);
}

const ts = (ms: number | null) => (ms === null ? undefined : timestampFromMs(ms));

/** A watch row as the API's Watch. */
export function watchMessage(row: WatchRow, now: number, newChangeCount: number): Watch {
  const watch = settingsWatch(row.settings);
  const shadow = row.shadow_end !== null && row.shadow_end > now;
  return create(WatchSchema, {
    ...watch,
    name: `watches/${row.id}`,
    shadowMode: shadow,
    state: WATCH_STATE[row.state],
    pauseReason: row.pause_reason === 'owner' ? Watch_PauseReason.OWNER : row.pause_reason === 'broken_too_long' ? Watch_PauseReason.BROKEN_TOO_LONG : Watch_PauseReason.UNSPECIFIED,
    health: create(WatchHealthSchema, {
      lastCheckTime: ts(row.last_check_at),
      lastSuccessTime: ts(row.last_success_at),
      nextCheckTime: ts(row.next_check_at),
      lastOutcome: row.last_outcome === null ? WatchHealth_Outcome.UNSPECIFIED : (OUTCOME[row.last_outcome] ?? WatchHealth_Outcome.UNSPECIFIED),
      lastFailure: failureReason(row.last_failure as FailureCode | null),
      lastHttpStatus: row.last_http_status,
      consecutiveFailureCount: row.failures,
      failureStartTime: ts(row.failure_start),
      maskedChangeCount: row.masked_count,
      pendingConfirmation: row.pending_change !== null,
    }),
    shadowEndTime: shadow ? ts(row.shadow_end) : undefined,
    createTime: ts(row.create_time),
    updateTime: ts(row.update_time),
    etag: row.etag,
    newChangeCount,
  });
}

/** The site's backoff of a watch's host, set on its health (the API adds it from the hosts table). */
export function withBackoff(watch: Watch, backoffUntil: number | null, now: number): Watch {
  if (backoffUntil !== null && backoffUntil > now && watch.health !== undefined) watch.health.backoffEndTime = timestampFromMs(backoffUntil);
  return watch;
}

/** A change row as the API's Change. */
export function changeMessage(row: ChangeRow, displayName: string): Change {
  const lines = JSON.parse(row.diff) as { kind: 'added' | 'removed'; text: string }[];
  return create(ChangeSchema, {
    name: `watches/${row.watch_id}/changes/${row.id}`,
    state: CHANGE_STATE[row.state],
    suppressionReason: suppressionReason(row.suppression),
    shadow: row.shadow === 1,
    classifier: row.classifier === 'AI' ? Change_Classifier.AI : Change_Classifier.RULE,
    triggerKind: triggerKind(row.trigger_kind),
    summary: row.summary,
    addedLineCount: row.added,
    removedLineCount: row.removed,
    diffLines: lines.map((line) => ({ kind: line.kind === 'added' ? DiffLine_Kind.ADDED : DiffLine_Kind.REMOVED, text: line.text })),
    diffTruncated: row.truncated === 1,
    reverted: row.reverted === 1,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    detectTime: ts(row.detect_time),
    resolveTime: ts(row.resolve_time),
    acknowledgeTime: ts(row.ack_time),
    watchDisplayName: displayName,
  });
}
