/** Codex decisions use the existing Gmail write/undo rules; Alarm never calls the retired classifier. */
import { afterEach, expect, it } from 'vitest';
import { Priority } from '@ziyixi/proto/mailsort/runner/v1/mailsort_runner_service_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS } from '../fakes/fixtures.ts';
import { MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, classifyUnread, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';
let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
async function ready(): Promise<void> {
  h = await startHarness(); await h.step(T0); await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
}
it.each([Priority.P1, Priority.P2, Priority.P3, Priority.P4])('writes priority %s preserving read, star and unrelated labels', async priority => {
  await ready();
  const own = h.up.gmail.createUserLabel('Personal');
  deliver(h, { ...MAILS.bankEn, labels: ['INBOX', 'UNREAD', 'STARRED', own] }, T0 + MINUTE);
  expect(await classifyUnread(h, priority)).toBe(1);
  await h.step(T0 + 2 * MINUTE);
  const name = `P${String(priority)}`;
  expect(gmailLabels(h, MAILS.bankEn.id)).toEqual(['UNREAD', 'STARRED', own, h.up.gmail.labelIdByName(name), ...(priority === Priority.P1 ? ['INBOX'] : [])].sort());
  expect(await decision(h, MAILS.bankEn.id)).toMatchObject({ outcome: 'applied', label_id: name.toLowerCase(), decider: 'codex', model: 'gpt-6.1-sol', shown: 0 });
  expect(h.up.ai.calls).toEqual([]);
});
it('classifies a later unread reply independently with its thread identity', async () => {
  await ready();
  const threadId = 'thread-synthetic';
  const first = { ...MAILS.bankEn, id: 'abc0000000000901', threadId };
  deliver(h, first, T0); await classifyUnread(h, Priority.P3); await h.step(T0 + MINUTE);
  const reply = { ...MAILS.bankEn, id: 'abc0000000000902', threadId };
  deliver(h, reply, T0 + 2 * MINUTE); await classifyUnread(h, Priority.P1); await h.step(T0 + 3 * MINUTE);
  expect(gmailLabels(h, first.id)).not.toContain('INBOX');
  expect(gmailLabels(h, reply.id)).toContain('INBOX');
  expect(await h.sql(`SELECT thread_id FROM decisions ORDER BY message_id`)).toEqual([{ thread_id: threadId }, { thread_id: threadId }]);
});
it('records explicit shadow decisions without Gmail writes and never fabricates a fallback decision', async () => {
  await ready(); await setMode(h, Mode.SHADOW);
  deliver(h, MAILS.bankEn, T0);
  await h.step(T0 + MINUTE);
  expect(await decision(h, MAILS.bankEn.id)).toBeUndefined();
  await classifyUnread(h, Priority.P3);
  expect(await decision(h, MAILS.bankEn.id)).toMatchObject({ outcome: 'suggested', label_id: 'p3', decider: 'codex', unsure_reason: '' });
  expect(modifies(h)).toEqual([]);
  expect(h.up.ai.calls).toEqual([]);
});
