import { describe, expect, it } from 'vitest';
import { contractErrors } from './contract.ts';
import mailHeroOk from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import queued from '../../../contracts/ops-v1/fixtures/StartCanaryResult/queued.json';
import pausedStart from '../../../contracts/ops-v1/fixtures/StartCanaryResult/paused-send-paused.json';
import maintenanceStart from '../../../contracts/ops-v1/fixtures/StartCanaryResult/unavailable-maintenance.json';
import delivered from '../../../contracts/ops-v1/fixtures/CanaryDelivery/delivered.json';
import deliveryFailed from '../../../contracts/ops-v1/fixtures/CanaryDelivery/failed.json';
import deliveryPaused from '../../../contracts/ops-v1/fixtures/CanaryDelivery/paused-endpoint-blocked.json';
import pending from '../../../contracts/ops-v1/fixtures/CanaryDelivery/pending-retrying.json';
import unknown from '../../../contracts/ops-v1/fixtures/CanaryDelivery/unknown.json';
import resultOk from '../../../contracts/ops-v1/fixtures/CanaryResult/ok.json';
import resultFailed from '../../../contracts/ops-v1/fixtures/CanaryResult/failed.json';
import notSeen from '../../../contracts/ops-v1/fixtures/CanaryResult/not-seen.json';
import processing from '../../../contracts/ops-v1/fixtures/CanaryResult/processing.json';
import processingPaused from '../../../contracts/ops-v1/fixtures/CanaryResult/processing-paused.json';
import type { CanaryDelivery, CanaryResult, OpsStatus, StartCanaryResult } from '@ziyixi/proto/ops/v1/ops_wire';
import {
  CANARY_DEADLINE_MS,
  applyDeadline,
  applyDelivery,
  applyResult,
  applyStart,
  holdWhenDisabled,
  isRunId,
  manualRunId,
  newRun,
  nextScheduledAt,
  runView,
  scheduledRunId,
  startPrecondition,
  waitForStatus,
  type CanaryRecord,
} from '../src/canary.ts';
import type { OpsCall } from '../src/ops-client.ts';

const NOW = Date.parse('2026-09-29T16:00:00Z');
const ok = <T>(value: unknown): OpsCall<T> => ({ ok: true, value: value as T });
const err = <T>(code: 'unavailable' | 'busy' | 'invalid_input' | 'timeout'): OpsCall<T> => ({ ok: false, code });

const mh = { status: mailHeroOk as OpsStatus, status_at: NOW - 60_000 };
const td = { status: todofyOk as OpsStatus, status_at: NOW - 60_000 };

function queuedRun(): CanaryRecord {
  return applyStart(newRun('canary-2026-09-29', 'scheduled', NOW), ok<StartCanaryResult>(queued), NOW);
}

describe('run IDs', () => {
  it('are RunIds of the contract', () => {
    expect(scheduledRunId(NOW)).toBe('canary-2026-09-29');
    expect(manualRunId(Date.parse('2026-09-29T16:05:09.123Z'))).toBe('canary-manual-20260929T160509Z');
    for (const id of [scheduledRunId(NOW), manualRunId(NOW)]) {
      expect(isRunId(id)).toBe(true);
      expect(contractErrors('StartCanaryInput', { run_id: id })).toEqual([]);
    }
  });
});

describe('start preconditions', () => {
  it('needs fresh statuses of both apps with their canary capabilities', () => {
    expect(startPrecondition(mh, td, NOW)).toEqual({ kind: 'call' });
    expect(startPrecondition({ status: null, status_at: null }, td, NOW)).toEqual({ kind: 'wait' });
    expect(startPrecondition({ ...mh, status_at: NOW - 61 * 60_000 }, td, NOW)).toEqual({ kind: 'wait' });
    const noProducer = { ...mh, status: { ...mh.status, capabilities: ['guard'] } };
    expect(startPrecondition(noProducer, td, NOW)).toEqual({ kind: 'skip', code: 'canary_producer_missing' });
    const noConsumer = { ...td, status: { ...td.status, capabilities: ['guard', 'ops_digest'] } };
    expect(startPrecondition(mh, noConsumer, NOW)).toEqual({ kind: 'skip', code: 'canary_consumer_missing' });
  });
});

describe('the start phase', () => {
  it('queues: delivering with a new 2 h deadline', () => {
    const run = queuedRun();
    expect(run).toMatchObject({ phase: 'delivering', event_id: queued.event_id, queued_at: NOW, deadline_at: NOW + CANARY_DEADLINE_MS, polls: 1 });
  });

  it('waits on paused/unavailable and is skipped at the deadline with the reason', () => {
    let run = applyStart(newRun('r', 'scheduled', NOW), ok<StartCanaryResult>(pausedStart), NOW);
    expect(run.phase).toBe('starting');
    expect(applyDeadline(run, NOW + 60 * 60_000)).toBe(run);
    expect(applyDeadline(run, NOW + CANARY_DEADLINE_MS)).toMatchObject({ phase: 'done', outcome: 'skipped', stage: 'start', code: 'send_paused' });
    run = applyStart(newRun('r', 'scheduled', NOW), ok<StartCanaryResult>(maintenanceStart), NOW);
    expect(applyDeadline(run, NOW + CANARY_DEADLINE_MS)).toMatchObject({ outcome: 'skipped', code: 'maintenance' });
  });

  it('fails at once on invalid_input, at the deadline on other errors', () => {
    expect(applyStart(newRun('r', 'manual', NOW), err('invalid_input'), NOW)).toMatchObject({ phase: 'done', outcome: 'failed', stage: 'start', code: 'invalid_input' });
    const busy = applyStart(newRun('r', 'manual', NOW), err('busy'), NOW);
    expect(busy.phase).toBe('starting');
    expect(applyDeadline(busy, NOW + CANARY_DEADLINE_MS)).toMatchObject({ outcome: 'failed', stage: 'start', code: 'busy' });
  });

  it('ends a run not yet queued when the canary is switched off, and leaves a queued one alone', () => {
    const waiting = applyStart(newRun('r', 'scheduled', NOW), ok<StartCanaryResult>(pausedStart), NOW);
    expect(holdWhenDisabled(waiting, NOW + 30 * 60_000)).toMatchObject({
      phase: 'done',
      outcome: 'skipped',
      stage: 'start',
      code: 'canary_disabled',
      finished_at: NOW + 30 * 60_000,
      polls: 1,
    });
    const run = queuedRun();
    expect(holdWhenDisabled(run, NOW + 30 * 60_000)).toBe(run);
    const consuming = applyDelivery(run, ok<CanaryDelivery>(delivered), NOW);
    expect(holdWhenDisabled(consuming, NOW)).toBe(consuming);
  });

  it('is skipped with status_unavailable when statuses never arrived', () => {
    const run = waitForStatus(newRun('r', 'scheduled', NOW));
    expect(applyDeadline(run, NOW + CANARY_DEADLINE_MS)).toMatchObject({ outcome: 'skipped', stage: 'start', code: 'status_unavailable' });
    expect(applyDeadline(newRun('r', 'scheduled', NOW), NOW + CANARY_DEADLINE_MS)).toMatchObject({ outcome: 'failed', code: 'timeout' });
  });
});

describe('the delivery phase', () => {
  const later = NOW + 30 * 60_000;

  it('moves to consuming on delivered with Mail Hero\'s time', () => {
    const run = applyDelivery(queuedRun(), ok<CanaryDelivery>(delivered), later);
    expect(run).toMatchObject({ phase: 'consuming', delivered_at: Date.parse(delivered.delivered_at), polls: 2 });
    expect(run.delivery).toEqual({ state: 'delivered', attempts: 1, last_http_status: 204, error_code: null });
  });

  it('fails on failed and on unknown', () => {
    expect(applyDelivery(queuedRun(), ok<CanaryDelivery>(deliveryFailed), later)).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'http_400' });
    expect(applyDelivery(queuedRun(), ok<CanaryDelivery>(unknown), later)).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'unknown_event' });
  });

  it('times out pending, skips paused, and fails an unreachable Mail Hero at the deadline', () => {
    const deadline = NOW + CANARY_DEADLINE_MS;
    const waiting = applyDelivery(queuedRun(), ok<CanaryDelivery>(pending), later);
    expect(waiting.phase).toBe('delivering');
    expect(applyDeadline(waiting, deadline)).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'timeout' });
    const held = applyDelivery(queuedRun(), ok<CanaryDelivery>(deliveryPaused), later);
    expect(applyDeadline(held, deadline)).toMatchObject({ outcome: 'skipped', stage: 'delivery', code: 'http_401' });
    const unreachable = applyDelivery(queuedRun(), err('unavailable'), later);
    expect(unreachable.last_call_error).toBe('unavailable');
    expect(applyDeadline(unreachable, deadline)).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'unreachable' });
  });
});

describe('the consumer phase', () => {
  const later = NOW + 30 * 60_000;
  const consuming = (): CanaryRecord => applyDelivery(queuedRun(), ok<CanaryDelivery>(delivered), later);
  const deadline = NOW + CANARY_DEADLINE_MS;

  it('ends ok with Todofy\'s completion time', () => {
    const run = applyResult(consuming(), ok<CanaryResult>(resultOk), later);
    expect(run).toMatchObject({ phase: 'done', outcome: 'ok', stage: null, code: null, completed_at: Date.parse(resultOk.completed_at), finished_at: later });
  });

  it('fails with Todofy\'s error code', () => {
    expect(applyResult(consuming(), ok<CanaryResult>(resultFailed), later)).toMatchObject({ outcome: 'failed', stage: 'consumer', code: 'llm_quota' });
  });

  it('decides a waiting run at the deadline', () => {
    expect(applyDeadline(applyResult(consuming(), ok<CanaryResult>(processingPaused), later), deadline)).toMatchObject({ outcome: 'skipped', stage: 'consumer', code: 'processing_paused' });
    expect(applyDeadline(applyResult(consuming(), ok<CanaryResult>(processing), later), deadline)).toMatchObject({ outcome: 'failed', code: 'timeout' });
    expect(applyDeadline(applyResult(consuming(), ok<CanaryResult>(notSeen), later), deadline)).toMatchObject({ outcome: 'failed', code: 'not_seen' });
    expect(applyDeadline(applyResult(consuming(), err('timeout'), later), deadline)).toMatchObject({ outcome: 'failed', code: 'unreachable' });
  });
});

describe('views and schedule', () => {
  it('renders ISO times and keeps the counters', () => {
    const view = runView(applyResult(applyDelivery(queuedRun(), ok<CanaryDelivery>(delivered), NOW + 1), ok<CanaryResult>(resultOk), NOW + 2));
    expect(view).toMatchObject({ created_at: '2026-09-29T16:00:00.000Z', delivered_at: '2026-09-29T22:30:04.512Z', outcome: 'ok', polls: 3 });
  });

  it('computes the next scheduled start', () => {
    expect(nextScheduledAt(Date.parse('2026-09-29T10:00:00Z'), 16, false)).toBe(Date.parse('2026-09-29T16:00:00Z'));
    expect(nextScheduledAt(Date.parse('2026-09-29T17:10:00Z'), 16, false)).toBe(Date.parse('2026-09-29T17:30:00Z'));
    expect(nextScheduledAt(Date.parse('2026-09-29T17:10:00Z'), 16, true)).toBe(Date.parse('2026-09-30T16:00:00Z'));
  });
});
