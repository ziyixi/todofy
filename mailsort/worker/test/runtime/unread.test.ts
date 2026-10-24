/** The existing owner batch feeds bounded hourly machine runs without changing Gmail read/star state. */
import { afterEach, expect, it } from 'vitest';
import { Mode, UnreadClassification_State as State } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, classifyUnread, deliver, modifies, setMode } from './helpers.ts';
let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
async function ready(): Promise<void> { h = await startHarness(); await h.step(T0); await setMode(h, Mode.LIVE); await h.api.initializePriorities({ requestId: op() }); }
const progress = async () => (await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification;

it('collects all IDs before any write, limits each model batch to 100 and preserves the explicit all-unread scope across runs', async () => {
  await ready();
  const p4 = h.up.gmail.labelIdByName('P4') ?? '';
  for (let i = 1; i <= 103; i++) deliver(h, { ...MAILS.bankEn, id: `abc${i.toString(16).padStart(13, '0')}`, ...(i > 100 ? { labels: ['UNREAD', p4] } : {}) }, T0 - 30 * DAY);
  const request = { name: 'unreadClassification', requestId: op(), recheckAllUnread: true };
  const first = await h.api.startUnreadClassification(request);
  expect(await h.api.startUnreadClassification(request)).toEqual(first);
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.SCANNING, totalCount: 100 });
  expect(modifies(h)).toEqual([]);
  expect(await classifyUnread(h)).toBe(100);
  expect(await progress()).toMatchObject({ totalCount: 103, pendingCount: 103 });
  for (let i = 2; i <= 21; i++) await h.step(T0 + i * MINUTE);
  expect(modifies(h)).toHaveLength(100);
  expect(await classifyUnread(h)).toBe(3);
  await h.step(T0 + 22 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 103, appliedCount: 103, pendingCount: 0, failedCount: 0 });
  expect(h.up.ai.calls).toEqual([]);
});

it('keeps the pending owner scope through off mode and rejects mixed recheck options', async () => {
  await ready();
  deliver(h, MAILS.bankEn, T0 - DAY);
  await h.api.startUnreadClassification({ name: 'unreadClassification', requestId: op(), recheckAllUnread: true });
  await setMode(h, Mode.OFF); await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.SCANNING, totalCount: 0 });
  await setMode(h, Mode.LIVE);
  for (const flags of [{ recheckAllUnread: true, recheckFallback: true }, { recheckAllUnread: true, recheckInitial100: true }, { recheckFallback: true, recheckInitial100: true }]) {
    expect(reasonOf(await rejection(h.api.startUnreadClassification({ name: 'unreadClassification', requestId: op(), ...flags })))).toBe('BAD_REQUEST');
  }
  expect(await classifyUnread(h)).toBe(1);
  await h.step(T0 + 2 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, appliedCount: 1 });
});

it('does not infer again while an already judged Gmail intent awaits a later run', async () => {
  await ready();
  deliver(h, MAILS.bankEn, T0);
  await classifyUnread(h);
  const before = await h.sql(`SELECT * FROM ledger`);
  await h.api.startUnreadClassification({ name: 'unreadClassification', requestId: op(), recheckAllUnread: true });
  expect(await classifyUnread(h)).toBe(0);
  expect(await h.sql(`SELECT * FROM ledger`)).toEqual(before);
  await h.step(T0 + MINUTE);
  expect(modifies(h)).toHaveLength(1);
});
