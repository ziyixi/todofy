/**
 * What the workerd pipeline suites share: the owner's setup through the API, synthetic deliveries, reads of the
 * object's rows and of the fake mailbox, and the check of every request Google got against the independent table
 * (../fakes/table.ts). All data is synthetic (../fakes/fixtures.ts).
 */
import { expect } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { LABELS, message, type SyntheticMail } from '../fakes/fixtures.ts';
import { allowedOperation, FORBIDDEN_LABELS } from '../fakes/table.ts';
import { op, type Harness } from './harness.ts';

export function checkGoogleCalls(h: Harness): void {
  // Owned: the labels mailsort created and the ones a test made for it to adopt; never another label of the owner's.
  const owned = h.up.gmail.mailsortLabelIds();
  for (const call of h.up.gmail.calls) {
    // The modify's ledger state and the store's planned names at send time are checked by the guard itself; here: the
    // table's shapes and owned labels.
    const ledger = () => ({ state: call.body.includes('"addLabelIds":["INBOX"]') || (call.body.includes('removeLabelIds') && !call.body.includes('addLabelIds')) ? 'undo_intended' : 'intended', archived: call.body.includes('INBOX') });
    expect(allowedOperation(call.method, call.url, call.body, { owned, planned: null, ledger }), `${call.method} ${call.url} ${call.body}`).not.toBeNull();
    for (const label of FORBIDDEN_LABELS) expect(call.body).not.toContain(`"${label}"`);
  }
  expect(h.up.strays).toEqual([]);
}

export async function setMode(h: Harness, mode: Mode): Promise<void> {
  await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode }), updateMask: { paths: ['mode'] }, requestId: op() });
}

export async function addLabels(h: Harness, live: readonly string[] = []): Promise<void> {
  for (const label of LABELS) {
    await h.api.createLabel({
      labelId: label.id,
      label: create(LabelSchema, { displayName: label.displayName, description: label.description, enabled: true, live: live.includes(label.id), trustImplying: 'trust' in label && label.trust }),
      requestId: op(),
    });
  }
}

export async function setLabelLive(h: Harness, id: string, live: boolean): Promise<void> {
  await h.api.updateLabel({ label: create(LabelSchema, { name: `labels/${id}`, live }), updateMask: { paths: ['live'] }, requestId: op() });
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
