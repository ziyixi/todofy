/**
 * The safety model by construction (../../docs/design.md §2): gmail.ts's closed table. Three angles:
 *
 * 1. every operation outside the table (trash, delete, send, drafts, filters, settings, a system label, a label mailsort
 *    does not own, a modify without its ledger row) throws GmailRefused and never reaches fetch;
 * 2. every request GmailClient's methods make, recorded by a fake fetch, is one an independent copy of the table
 *    (fakes/table.ts) allows;
 * 3. random operations (a seeded fuzz) never pass the guard unless the independent table allows them, and never carry a
 *    forbidden label.
 */
import { describe, expect, it } from 'vitest';
import { checkRequest, GmailClient, GmailRefused, MESSAGE_FIELDS, type LedgerView, type Ownership } from '../src/gmail.ts';
import { allowedOperation, FORBIDDEN_LABELS } from './fakes/table.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OWNED = 'Label_7';
const MESSAGE = '18c0ffee0000aaaa';

function ownership(rows: Record<string, LedgerView> = {}): Ownership & { readonly rows: Record<string, LedgerView> } {
  return {
    rows,
    ownedLabelIds: () => new Set([OWNED]),
    ledger: (messageId, labelId) => rows[`${messageId}:${labelId}`] ?? null,
  };
}

function refused(method: string, url: string, body?: string, own = ownership()): string {
  try {
    checkRequest({ method, url, ...(body === undefined ? {} : { body }) }, own);
  } catch (error) {
    if (error instanceof GmailRefused) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('the closed table refuses everything outside it', () => {
  const mutations: [string, string, string?][] = [
    ['POST', `${BASE}/messages/${MESSAGE}/trash`],
    ['POST', `${BASE}/messages/${MESSAGE}/untrash`],
    ['DELETE', `${BASE}/messages/${MESSAGE}`],
    ['POST', `${BASE}/messages/batchDelete`, JSON.stringify({ ids: [MESSAGE] })],
    ['POST', `${BASE}/messages/batchModify`, JSON.stringify({ ids: [MESSAGE], addLabelIds: [OWNED] })],
    ['POST', `${BASE}/messages/send`, JSON.stringify({ raw: 'x' })],
    ['POST', `${BASE}/drafts`, JSON.stringify({ message: { raw: 'x' } })],
    ['POST', `${BASE}/drafts/send`, '{}'],
    ['POST', `${BASE}/settings/filters`, JSON.stringify({ action: { addLabelIds: [OWNED] } })],
    ['PUT', `${BASE}/settings/autoForwarding`, '{}'],
    ['POST', `${BASE}/settings/forwardingAddresses`, '{}'],
    ['PUT', `${BASE}/settings/vacation`, '{}'],
    ['DELETE', `${BASE}/labels/${OWNED}`],
    ['PUT', `${BASE}/labels/${OWNED}`, JSON.stringify({ name: '分拣/x' })],
    ['POST', `${BASE}/threads/t1/modify`, JSON.stringify({ addLabelIds: [OWNED] })],
    ['POST', `${BASE}/threads/t1/trash`],
    ['POST', `${BASE}/messages/import`, '{}'],
    ['POST', `${BASE}/messages`, '{}'],
    ['GET', `${BASE}/messages/${MESSAGE}/attachments/a1`],
    ['GET', `${BASE}/messages/${MESSAGE}?format=raw&fields=${encodeURIComponent(MESSAGE_FIELDS)}`],
    ['GET', `https://gmail.googleapis.com/gmail/v1/users/other@example.com/messages/${MESSAGE}`],
    ['GET', `https://www.googleapis.com/gmail/v1/users/me/labels`],
    ['GET', `http://gmail.googleapis.com/gmail/v1/users/me/labels`],
    ['GET', `${BASE}/labels/../messages`],
    ['GET', `${BASE}/labels%2F..%2Fmessages`],
    ['POST', 'https://oauth2.googleapis.com/token', 'grant_type=authorization_code&code=x&client_id=a&client_secret=b'],
    ['POST', 'https://oauth2.googleapis.com/revoke', 'token=x'],
  ];
  it.each(mutations)('%s %s', (method, url, body) => {
    expect(refused(method, url, body)).not.toBe('accepted');
  });

  it('refuses every system label and any label it does not own in a modify, even with a ledger row', () => {
    const own = ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'intended', archived: true } });
    const url = `${BASE}/messages/${MESSAGE}/modify`;
    for (const label of [...FORBIDDEN_LABELS, 'INBOX', 'Label_8']) {
      expect(refused('POST', url, JSON.stringify({ addLabelIds: [label] }), own)).not.toBe('accepted');
      if (label !== 'INBOX') expect(refused('POST', url, JSON.stringify({ addLabelIds: [OWNED], removeLabelIds: [label] }), own)).not.toBe('accepted');
    }
    // Marking read is removing UNREAD: never.
    expect(refused('POST', url, JSON.stringify({ removeLabelIds: ['UNREAD'] }), own)).not.toBe('accepted');
    expect(refused('POST', url, JSON.stringify({ addLabelIds: [OWNED, 'Label_8'] }), own)).toBe('modify_shape');
    expect(refused('POST', url, JSON.stringify({ addLabelIds: [OWNED], removeLabelIds: [OWNED] }), own)).not.toBe('accepted');
  });

  it('accepts a classify only for a ledger row in intended or applied whose archive flag matches', () => {
    const url = `${BASE}/messages/${MESSAGE}/modify`;
    const archive = JSON.stringify({ addLabelIds: [OWNED], removeLabelIds: ['INBOX'] });
    expect(refused('POST', url, archive)).toBe('no_intent');
    expect(refused('POST', url, archive, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'intended', archived: true } }))).toBe('accepted');
    expect(refused('POST', url, archive, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'applied', archived: true } }))).toBe('accepted');
    expect(refused('POST', url, archive, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'intended', archived: false } }))).toBe('archive_mismatch');
    expect(refused('POST', url, archive, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'undone', archived: true } }))).toBe('no_intent');
  });

  it('accepts an undo only for a row in undo_intended, restoring INBOX exactly when it archived', () => {
    const url = `${BASE}/messages/${MESSAGE}/modify`;
    const undo = JSON.stringify({ removeLabelIds: [OWNED], addLabelIds: ['INBOX'] });
    expect(refused('POST', url, undo, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'applied', archived: true } }))).toBe('no_undo_intent');
    expect(refused('POST', url, undo, ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'undo_intended', archived: true } }))).toBe('accepted');
    expect(refused('POST', url, JSON.stringify({ removeLabelIds: [OWNED] }), ownership({ [`${MESSAGE}:${OWNED}`]: { state: 'undo_intended', archived: true } }))).toBe('archive_mismatch');
  });

  it('creates and renames labels only under the prefix', () => {
    const create = (name: string) => JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    expect(refused('POST', `${BASE}/labels`, create('分拣/订阅'))).toBe('accepted');
    expect(refused('POST', `${BASE}/labels`, create('订阅'))).toBe('labels_create');
    expect(refused('POST', `${BASE}/labels`, create('分拣/a/b'))).toBe('labels_create');
    expect(refused('POST', `${BASE}/labels`, create('分拣/'))).toBe('labels_create');
    expect(refused('POST', `${BASE}/labels`, JSON.stringify({ name: '分拣/x', color: { textColor: '#000000' } }))).toBe('body_key');
    expect(refused('PATCH', `${BASE}/labels/${OWNED}`, JSON.stringify({ name: '分拣/新' }))).toBe('accepted');
    expect(refused('PATCH', `${BASE}/labels/Label_8`, JSON.stringify({ name: '分拣/新' }))).toBe('label_not_owned');
    expect(refused('PATCH', `${BASE}/labels/INBOX`, JSON.stringify({ name: '分拣/新' }))).toBe('label_not_owned');
    expect(refused('PATCH', `${BASE}/labels/${OWNED}`, JSON.stringify({ name: 'Inbox' }))).toBe('labels_patch');
  });

  it('reads only the fixed shapes', () => {
    expect(refused('GET', `${BASE}/profile?fields=historyId`)).toBe('accepted');
    expect(refused('GET', `${BASE}/profile`)).toBe('profile_fields');
    expect(refused('GET', `${BASE}/history?startHistoryId=10&historyTypes=messageAdded&maxResults=100`)).toBe('accepted');
    expect(refused('GET', `${BASE}/history?startHistoryId=10&historyTypes=messageDeleted&maxResults=100`)).toBe('history_types');
    expect(refused('GET', `${BASE}/history?startHistoryId=10&historyTypes=messageAdded&maxResults=100&labelId=SENT`)).toBe('history_label');
    expect(refused('GET', `${BASE}/messages?labelIds=INBOX&q=newer_than%3A2d&maxResults=100`)).toBe('accepted');
    expect(refused('GET', `${BASE}/messages?labelIds=INBOX&q=from%3Abank&maxResults=100`)).toBe('list_query');
    expect(refused('GET', `${BASE}/messages?labelIds=SPAM&q=newer_than%3A2d&maxResults=100`)).toBe('list_query');
    expect(refused('GET', `${BASE}/messages/${MESSAGE}?format=full&fields=${encodeURIComponent(MESSAGE_FIELDS)}`)).toBe('accepted');
    expect(refused('GET', `${BASE}/messages/${MESSAGE}?format=full`)).toBe('message_fields');
    expect(refused('GET', `${BASE}/labels`)).toBe('accepted');
  });
});

describe('every request the client makes is in the table', () => {
  it('records each call through a fake fetch and checks it against the independent table', async () => {
    const rows: Record<string, LedgerView> = {};
    const own = ownership(rows);
    const recorded: { method: string; url: string; body: string; op: string | null }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === 'GET' ? '' : await request.text();
      // The independent table's verdict with the ledger as it is when the request leaves.
      const op = allowedOperation(request.method, request.url, body, { owned: own.ownedLabelIds(), ledger: (m, l) => own.ledger(m, l) });
      recorded.push({ method: request.method, url: request.url, body, op });
      if (request.url.startsWith('https://oauth2')) return Response.json({ access_token: 't', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.modify' });
      if (request.url.endsWith('/profile?fields=historyId')) return Response.json({ historyId: '42' });
      if (request.url.includes('/labels') && request.method === 'POST') return Response.json({ id: 'Label_9', name: '分拣/x' });
      if (request.url.endsWith('/labels')) return Response.json({ labels: [] });
      if (request.url.includes('/messages?')) return Response.json({ messages: [{ id: MESSAGE }] });
      if (request.url.includes('/history?')) return Response.json({ historyId: '43' });
      return Response.json({ id: MESSAGE, labelIds: ['INBOX'] });
    };
    const calls: string[] = [];
    const client = new GmailClient({ fetch: fake, credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, ownership: own, onCall: (op) => calls.push(op), now: () => 0 });
    await client.currentHistoryId();
    await client.history('42', null, 100);
    await client.history('42', '7', 100);
    await client.recentInbox(100);
    await client.message(MESSAGE);
    await client.labels();
    await client.createLabel('分拣/新');
    await client.renameLabel(OWNED, '分拣/改');
    rows[`${MESSAGE}:${OWNED}`] = { state: 'intended', archived: true };
    await client.classify(MESSAGE, OWNED, true);
    rows[`${MESSAGE}:${OWNED}`] = { state: 'undo_intended', archived: true };
    await client.undo(MESSAGE, OWNED, true);
    // A modify without its ledger row never reaches fetch.
    rows[`${MESSAGE}:${OWNED}`] = { state: 'undone', archived: true };
    await expect(client.undo(MESSAGE, OWNED, true)).rejects.toBeInstanceOf(GmailRefused);
    await expect(client.classify(MESSAGE, 'Label_8', false)).rejects.toBeInstanceOf(GmailRefused);
    expect(recorded.length).toBe(calls.length);
    for (const call of recorded) {
      expect(call.op, `${call.method} ${call.url}`).not.toBeNull();
      for (const label of FORBIDDEN_LABELS) expect(call.body).not.toContain(`"${label}"`);
    }
    expect(new Set(calls)).toEqual(new Set(['token', 'profile', 'history', 'messages_list', 'message_get', 'labels_list', 'labels_create', 'labels_patch', 'message_modify']));
  });
});

describe('fuzz: random operations never pass the guard unless the independent table allows them', () => {
  // A small seeded generator (mulberry32), so a failure reproduces.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

  it('20,000 random requests', () => {
    const random = rng(20261006);
    const labels = ['INBOX', 'UNREAD', 'STARRED', 'TRASH', 'SPAM', 'IMPORTANT', 'CATEGORY_SOCIAL', OWNED, 'Label_8', ''];
    const states = ['intended', 'applied', 'failed', 'undo_intended', 'undone'] as const;
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const method = pick(random, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      const host = pick(random, ['gmail.googleapis.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com']);
      const tail = pick(random, [
        'profile', 'history', 'messages', `messages/${MESSAGE}`, `messages/${MESSAGE}/modify`, `messages/${MESSAGE}/trash`, 'messages/batchModify', 'messages/batchDelete',
        'messages/send', 'drafts', 'labels', `labels/${OWNED}`, 'labels/Label_8', 'labels/UNREAD', 'settings/filters', 'threads/abc/modify', 'token',
      ]);
      const query = pick(random, ['', '?fields=historyId', '?startHistoryId=5&historyTypes=messageAdded&maxResults=10', '?labelIds=INBOX&q=newer_than%3A2d&maxResults=5', `?format=full&fields=${encodeURIComponent(MESSAGE_FIELDS)}`, '?format=raw', '?q=in%3Aspam']);
      const url = host === 'oauth2.googleapis.com' ? `https://${host}/${tail}` : `https://${host}/gmail/v1/users/me/${tail}${query}`;
      const addSize = Math.floor(random() * 3);
      const removeSize = Math.floor(random() * 3);
      const bodyKind = pick(random, ['modify', 'label', 'form', 'none']);
      const body =
        bodyKind === 'modify'
          ? JSON.stringify({
              ...(addSize > 0 ? { addLabelIds: Array.from({ length: addSize }, () => pick(random, labels)) } : {}),
              ...(removeSize > 0 ? { removeLabelIds: Array.from({ length: removeSize }, () => pick(random, labels)) } : {}),
            })
          : bodyKind === 'label'
            ? JSON.stringify({ name: pick(random, ['分拣/a', '分拣/', 'Work', '分拣/a/b']), labelListVisibility: 'labelShow', messageListVisibility: 'show' })
            : bodyKind === 'form'
              ? 'client_id=a&client_secret=b&refresh_token=c&grant_type=refresh_token'
              : undefined;
      const row = random() < 0.7 ? { state: pick(random, states), archived: random() < 0.5 } : null;
      const own: Ownership = { ownedLabelIds: () => new Set([OWNED]), ledger: (m, l) => (m === MESSAGE && l === OWNED ? row : null) };
      let passed = true;
      try {
        checkRequest({ method, url, ...(body === undefined ? {} : { body }) }, own);
      } catch (error) {
        expect(error).toBeInstanceOf(GmailRefused);
        passed = false;
      }
      if (!passed) continue;
      accepted++;
      const op = allowedOperation(method, url, body ?? '', { owned: new Set([OWNED]), ledger: (m, l) => (m === MESSAGE && l === OWNED ? row : null) });
      expect(op, `${method} ${url} ${body ?? ''}`).not.toBeNull();
      for (const label of FORBIDDEN_LABELS) expect(body ?? '').not.toContain(`"${label}"`);
    }
    // The fuzz reaches the accepting branches too.
    expect(accepted).toBeGreaterThan(20);
  });
});
