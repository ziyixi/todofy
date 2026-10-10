/**
 * What the workerd pipeline suites share: the owner's setup through the API, synthetic deliveries, reads of the
 * object's rows and of the fake mailbox, and the check of every request Google got against the independent table
 * (../fakes/table.ts). All data is synthetic (../fakes/fixtures.ts).
 */
import { expect } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { LABELS, message, type SyntheticMail } from '../fakes/fixtures.ts';
import { allowedOperation, FORBIDDEN_LABELS } from '../fakes/table.ts';
import { op, type Harness } from './harness.ts';

export function checkGoogleCalls(h: Harness): void {
  // Owned: the leaf labels mailsort created and the ones a test made for it to adopt; never another of the owner's.
  const owned = h.up.gmail.mailsortLabelIds();
  for (const call of h.up.gmail.calls) {
    // A label's name against the store's paths when it was sent (FakeUpstream.plannedPaths). The modify's ledger state
    // at send time is the guard's own check; here: the table's shapes and owned labels.
    const planned = new Set(call.planned ?? []);
    const ledger = () => ({ state: call.body.includes('"addLabelIds":["INBOX"]') || (call.body.includes('removeLabelIds') && !call.body.includes('addLabelIds')) ? 'undo_intended' : 'intended', archived: call.body.includes('INBOX') });
    expect(allowedOperation(call.method, call.url, call.body, { owned, planned, ledger }), `${call.method} ${call.url} ${call.body}`).not.toBeNull();
    for (const label of FORBIDDEN_LABELS) expect(call.body).not.toContain(`"${label}"`);
  }
  expect(h.up.strays).toEqual([]);
}

export async function setMode(h: Harness, mode: Mode): Promise<void> {
  await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode }), updateMask: { paths: ['mode'] }, requestId: op() });
}

export async function addLabels(h: Harness): Promise<void> {
  for (const label of LABELS) {
    await h.api.createLabel({
      labelId: label.id,
      label: create(LabelSchema, { displayName: label.displayName, description: label.description, enabled: true, trustImplying: 'trust' in label && label.trust }),
      requestId: op(),
    });
  }
}

export async function setLabelEnabled(h: Harness, id: string, enabled: boolean): Promise<void> {
  await h.api.updateLabel({ label: create(LabelSchema, { name: `labels/${id}`, enabled }), updateMask: { paths: ['enabled'] }, requestId: op() });
}

/**
 * Makes room in the review queue: a week of 100 decided mails a day before `at`, so the day's quota is its most (5) and
 * a test can show more than one uncertain mail on one day.
 */
export async function roomInReview(h: Harness, at: number): Promise<void> {
  for (let day = 1; day <= 7; day++) {
    const date = new Date(at - day * 86_400_000).toISOString().slice(0, 10);
    await h.sql(`INSERT INTO usage (day, decided) VALUES (?, 100) ON CONFLICT (day) DO UPDATE SET decided = 100`, date);
  }
}

/** The Clef calls since `from` (view 1 and view 2 of each mail), with their option keys in the order offered. */
export function clefCalls(h: Harness, from = 0): { model: string; options: string[]; state: Record<string, unknown> }[] {
  return h.up.ai.calls.slice(from).flatMap((call) => {
    if (!call.model.includes('clef')) return [];
    const questions = call.input['questions'] as Record<string, { criteria?: Record<string, string> }>;
    return [{ model: call.model, options: Object.keys(questions['label']?.criteria ?? {}), state: call.input['state'] as Record<string, unknown> }];
  });
}

export function deliver(h: Harness, mail: SyntheticMail, at: number): void {
  h.up.gmail.deliver(message({ ...mail, receivedAt: at }));
}

export async function decision(h: Harness, id: string): Promise<Record<string, unknown> | undefined> {
  return (await h.sql(`SELECT * FROM decisions WHERE message_id = ?`, id))[0];
}

export function gmailLabels(h: Harness, id: string): string[] {
  return [...(h.up.gmail.messages.get(id)?.labelIds ?? [])].sort();
}

export const modifies = (h: Harness) => h.up.gmail.calls.filter((call) => call.url.endsWith('/modify'));

/** Answers Gmail's modify with `status` while the returned switch is on. */
export function failModifies(h: Harness, status: number): { off: () => void } {
  let on = true;
  h.up.gmail.failWhen = (method, url) => (on && method === 'POST' && url.pathname.endsWith('/modify') ? status : null);
  return {
    off: () => {
      on = false;
    },
  };
}
