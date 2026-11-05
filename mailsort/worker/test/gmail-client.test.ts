/**
 * GmailClient unit tests across the one-time category label retirement boundary, replacing inherited priorities on a
 * new message, recent unclassified Inbox discovery, and bounded unread Gmail listing.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  GmailClient,
  GmailRefused,
  GoogleError,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  type LedgerView,
  type Ownership,
} from '../src/gmail.ts';
import { FakeGmail } from './fakes/fake-gmail.ts';
import { MAILS, message } from './fakes/fixtures.ts';
import { allowedOperation, FORBIDDEN_LABELS } from './fakes/table.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MESSAGE = MAILS.newsletterEn.id;
const EMPTY_OWNERSHIP: Ownership = {
  ownedLabelIds: () => new Set(),
  plannedPaths: () => new Set(),
  plannedPath: () => null,
  ledger: () => null,
};

function ownership(
  ids: readonly string[],
  retired: ReadonlySet<string>,
  ledger: (messageId: string, labelId: string) => LedgerView | null = () => null,
): Ownership {
  return {
    ownedLabelIds: () => new Set(ids),
    plannedPaths: () => new Set(),
    plannedPath: () => null,
    priorityDelete: (id) => retired.has(id),
    ledger,
  };
}

function clientFor(gmail: FakeGmail, own: Ownership, retired: ReadonlySet<string>, scope = SCOPE_MODIFY): GmailClient {
  gmail.grants.set('synthetic-refresh', scope);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return gmail.handle(request.method, new URL(request.url), request.headers, await request.text(), undefined, [...retired]);
  };
  return new GmailClient({
    fetch: fetcher,
    ownership: own,
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' },
    now: () => 0,
    onCall: () => {},
  });
}

function unreadClientFor(fetcher: typeof fetch, cachedToken = false): GmailClient {
  return new GmailClient({
    fetch: fetcher,
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' },
    ownership: EMPTY_OWNERSHIP,
    now: () => 0,
    onCall: () => {},
    ...(cachedToken ? { token: { token: 'synthetic-access', expiresAt: 100_000, writeScope: false } } : {}),
  });
}

describe('the one-time category label retirement boundary', () => {
  it('requires the frozen retirement set, even for another label owned by mailsort', () => {
    const retired = new Set(['Label_7']);
    const own = ownership(['Label_7', 'Label_8'], retired);
    const ctx = {
      owned: own.ownedLabelIds(),
      planned: own.plannedPaths(),
      ledger: (id: string, label: string) => own.ledger(id, label),
      priorityDeletes: retired,
    };
    expect(checkRequest({ method: 'DELETE', url: `${BASE}/labels/Label_7` }, own)).toBe('labels_delete');
    expect(allowedOperation('DELETE', `${BASE}/labels/Label_7`, '', ctx)).toBe('labels_delete');
    for (const id of ['Label_8', 'Label_999', 'INBOX', ...FORBIDDEN_LABELS]) {
      expect(() => checkRequest({ method: 'DELETE', url: `${BASE}/labels/${id}` }, own)).toThrow(GmailRefused);
      expect(allowedOperation('DELETE', `${BASE}/labels/${id}`, '', ctx)).toBeNull();
    }
    expect(() => checkRequest({ method: 'DELETE', url: `${BASE}/labels/Label_7` }, { ...own, priorityDelete: () => false })).toThrow(GmailRefused);
    expect(allowedOperation('DELETE', `${BASE}/labels/Label_7`, '', { ...ctx, priorityDeletes: new Set() })).toBeNull();
  });

  it('refuses messages, system labels, query strings, bodies and alternative label paths', () => {
    // Even a permissive callback cannot grant a message or system-label operation.
    const own = { ...ownership(['Label_7'], new Set(['Label_7'])), priorityDelete: () => true };
    const requests = [
      { method: 'DELETE', url: `${BASE}/messages/${MESSAGE}` },
      { method: 'POST', url: `${BASE}/messages/${MESSAGE}/trash` },
      { method: 'DELETE', url: `${BASE}/labels/INBOX` },
      { method: 'DELETE', url: `${BASE}/labels/UNREAD` },
      { method: 'DELETE', url: `${BASE}/labels/Label_7?fields=id` },
      { method: 'DELETE', url: `${BASE}/labels/Label_7?` },
      { method: 'DELETE', url: `${BASE}/labels/Label_7`, body: '' },
      { method: 'DELETE', url: `${BASE}/labels/Label_7`, body: '{}' },
      { method: 'DELETE', url: `${BASE}/labels/Label_7/` },
      { method: 'DELETE', url: `${BASE}/labels/Label_7/../Label_8` },
      { method: 'DELETE', url: `${BASE}/labels/Label_%37` },
      { method: 'DELETE', url: `${BASE}/labels/Label_7%2fmessages` },
      { method: 'DELETE', url: `${BASE}/labels/Label_${'7'.repeat(25)}` },
    ];
    for (const request of requests) expect(() => checkRequest(request, own), JSON.stringify(request)).toThrow(GmailRefused);
  });

  it('removes only the retired label and accepts a repeated 404 while preserving all mail', async () => {
    const gmail = new FakeGmail();
    const old = gmail.createUserLabel('Old category', true);
    const other = gmail.createUserLabel('Owner label');
    gmail.deliver(message({ ...MAILS.newsletterEn, labels: ['INBOX', 'UNREAD', 'STARRED', old, other] }));
    gmail.deliver(message({ ...MAILS.receiptEn, labels: ['UNREAD', old, 'CATEGORY_UPDATES'] }));
    const before = new Map(
      [...gmail.messages].map(([id, mail]) => [
        id,
        { ...mail, labelIds: [...mail.labelIds].filter((label) => label !== old).sort() },
      ]),
    );
    const retired = new Set([old]);
    const own = ownership([old], retired);
    const client = clientFor(gmail, own, retired);

    await client.deletePriorityLabel(old);
    await client.deletePriorityLabel(old);

    expect(gmail.labels.has(old)).toBe(false);
    expect(gmail.labels.has(other)).toBe(true);
    expect(gmail.messages.size).toBe(before.size);
    for (const [id, mail] of gmail.messages) expect({ ...mail, labelIds: [...mail.labelIds].sort() }).toEqual(before.get(id));
    for (const call of gmail.calls) {
      expect(
        allowedOperation(call.method, call.url, call.body, {
          owned: own.ownedLabelIds(),
          planned: new Set(),
          ledger: () => null,
          priorityDeletes: new Set(call.priorityDeletes),
        }),
      ).not.toBeNull();
    }
    expect(gmail.calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    retired.clear();
    const sent = gmail.calls.length;
    await expect(client.deletePriorityLabel(other)).rejects.toBeInstanceOf(GmailRefused);
    await expect(client.deletePriorityLabel(old)).rejects.toBeInstanceOf(GmailRefused);
    expect(gmail.calls).toHaveLength(sent);
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [429, 'rate'],
    [500, 'unavailable'],
  ] as const)('keeps the existing Google error mapping for %i', async (status, kind) => {
    const gmail = new FakeGmail();
    const id = gmail.createUserLabel('Old category', true);
    const retired = new Set([id]);
    gmail.failWhen = (method) => (method === 'DELETE' ? status : null);
    await expect(clientFor(gmail, ownership([id], retired), retired).deletePriorityLabel(id)).rejects.toMatchObject({
      name: 'GoogleError',
      kind,
      code: `labels_delete_${String(status)}`,
    });
  });

  it('needs the existing gmail.modify grant', async () => {
    const gmail = new FakeGmail();
    const id = gmail.createUserLabel('Old category', true);
    const retired = new Set([id]);
    await expect(clientFor(gmail, ownership([id], retired), retired, SCOPE_READONLY).deletePriorityLabel(id)).rejects.toBeInstanceOf(GoogleError);
    expect(gmail.labels.has(id)).toBe(true);
  });
});

describe('replacing an inherited priority on a new message', () => {
  it.each([false, true])('keeps one priority and restores the original labels on undo, archived=%s', async (archive) => {
    const gmail = new FakeGmail();
    const chosen = gmail.createUserLabel('P1', true);
    const previous = gmail.createUserLabel('P3', true);
    const other = gmail.createUserLabel('Owner label');
    const original = ['INBOX', 'UNREAD', 'STARRED', previous, other];
    gmail.deliver(message({ ...MAILS.newsletterEn, labels: original }));
    let row: LedgerView = { state: 'intended', archived: archive, replaceLabels: [previous] };
    const own = ownership([chosen, previous], new Set(), (id, label) => (id === MESSAGE && label === chosen ? row : null));
    const client = clientFor(gmail, own, new Set());

    await client.classify(MESSAGE, chosen, archive, [previous]);
    expect([...(gmail.messages.get(MESSAGE)?.labelIds ?? [])].sort()).toEqual(
      [...original.filter((label) => label !== previous && (!archive || label !== 'INBOX')), chosen].sort(),
    );
    row = { ...row, state: 'undo_intended' };
    await client.undo(MESSAGE, chosen, archive, [previous]);
    expect([...(gmail.messages.get(MESSAGE)?.labelIds ?? [])].sort()).toEqual([...original].sort());
    for (const call of gmail.calls.filter((call) => call.url.endsWith('/modify'))) {
      const value = JSON.parse(call.body) as { removeLabelIds: string[] };
      const undo = value.removeLabelIds.includes(chosen);
      expect(
        allowedOperation(call.method, call.url, call.body, {
          owned: own.ownedLabelIds(),
          planned: new Set(),
          ledger: () => ({ ...row, state: undo ? 'undo_intended' : 'intended' }),
        }),
      ).toBe(undo ? 'undo' : 'classify');
    }
  });

  it.each([false, true])('restores an archived unread message after classify and undo, archive=%s', async (archive) => {
    const gmail = new FakeGmail();
    const chosen = gmail.createUserLabel(archive ? 'P2' : 'P1', true);
    const previous = gmail.createUserLabel('P3', true);
    const other = gmail.createUserLabel('Owner label');
    const original = ['UNREAD', 'STARRED', 'IMPORTANT', 'CATEGORY_UPDATES', previous, other];
    gmail.deliver(message({ ...MAILS.newsletterEn, labels: original }));
    let row: LedgerView = { state: 'intended', archived: archive, baseInbox: false, replaceLabels: [previous] };
    const own = ownership([chosen, previous], new Set(), (id, label) => (id === MESSAGE && label === chosen ? row : null));
    const client = clientFor(gmail, own, new Set());

    await client.classify(MESSAGE, chosen, archive, [previous], false);
    expect([...(gmail.messages.get(MESSAGE)?.labelIds ?? [])].sort()).toEqual(
      [...original.filter((label) => label !== previous), chosen, ...(archive ? [] : ['INBOX'])].sort(),
    );
    row = { ...row, state: 'undo_intended' };
    await client.undo(MESSAGE, chosen, archive, [previous], false);
    expect([...(gmail.messages.get(MESSAGE)?.labelIds ?? [])].sort()).toEqual([...original].sort());
    for (const call of gmail.calls.filter((call) => call.url.endsWith('/modify'))) {
      const value = JSON.parse(call.body) as { removeLabelIds: string[] };
      const undo = value.removeLabelIds.includes(chosen);
      expect(
        allowedOperation(call.method, call.url, call.body, {
          owned: own.ownedLabelIds(),
          planned: new Set(),
          ledger: () => ({ ...row, state: undo ? 'undo_intended' : 'intended' }),
        }),
      ).toBe(undo ? 'undo' : 'classify');
    }
  });

  it('refuses replacement or restoration beyond the original owned priority IDs', () => {
    const chosen = 'Label_1';
    const previous = 'Label_3';
    const other = 'Label_5';
    let row: LedgerView = { state: 'intended', archived: false, replaceLabels: [previous] };
    const own = ownership([chosen, previous, other], new Set(), (_id, label) => (label === chosen ? row : null));
    const url = `${BASE}/messages/${MESSAGE}/modify`;
    const check = (addLabelIds: string[], removeLabelIds: string[]) =>
      checkRequest({ method: 'POST', url, body: JSON.stringify({ addLabelIds, removeLabelIds }) }, own);
    expect(check([chosen], [previous])).toBe('message_modify');
    for (const remove of [[], [other], [previous, other], [previous, 'UNREAD'], [previous, previous], [previous, 'INBOX']]) {
      expect(() => check([chosen], remove)).toThrow(GmailRefused);
    }
    row = { ...row, state: 'undo_intended' };
    expect(check([previous], [chosen])).toBe('message_modify');
    for (const add of [[], [other], [previous, other], [previous, 'UNREAD'], [previous, previous]]) {
      expect(() => check(add, [chosen])).toThrow(GmailRefused);
    }
  });
});

describe('recent unclassified Inbox discovery', () => {
  it('includes read mail without reading bodies, excludes graded mail before the cap, and leaves old/archive mail alone', async () => {
    const gmail = new FakeGmail();
    const now = Date.parse('2026-10-26T02:00:00Z');
    gmail.clock = () => now;
    gmail.grants.set('synthetic-refresh', SCOPE_READONLY);
    const priority = gmail.createUserLabel('P1');
    for (let i = 0; i < 101; i++) {
      gmail.deliver(message({ ...MAILS.bankEn, id: (0xa00000 + i).toString(16), receivedAt: now - 1000, labels: ['INBOX', priority] }));
    }
    const read = 'b000001';
    const unread = 'b000002';
    for (const [id, labels, receivedAt] of [
      [read, ['INBOX', 'STARRED'], now - 1000],
      [unread, ['INBOX', 'UNREAD'], now - 1000],
      ['b000003', ['INBOX'], now - 3 * 86_400_000],
      ['b000004', ['STARRED'], now - 1000],
      ['b000005', ['INBOX', 'SPAM'], now - 1000],
      ['b000006', ['INBOX', 'SENT'], now - 1000],
    ] as const) {
      gmail.deliver(message({ ...MAILS.bankEn, id, labels, receivedAt }));
    }
    const before = [...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]]);
    const requests: string[] = [];
    const ctx = { owned: new Set<string>(), planned: new Set<string>(), ledger: () => null };
    const client = new GmailClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.text();
        expect(allowedOperation(request.method, request.url, body, ctx)).not.toBeNull();
        requests.push(request.url);
        return gmail.handle(request.method, new URL(request.url), request.headers, body);
      },
      credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' },
      ownership: EMPTY_OWNERSHIP,
      now: () => now,
      onCall: () => {},
    });
    expect(await client.recentUnclassifiedInbox(100)).toEqual([read, unread]);
    const listing = new URL(requests.find((url) => new URL(url).pathname.endsWith('/messages')) ?? '');
    expect(listing.searchParams.get('labelIds')).toBe('INBOX');
    expect(listing.searchParams.get('q')).toBe('newer_than:2d -label:P1 -label:P2 -label:P3 -label:P4 -in:sent');
    expect(listing.searchParams.get('maxResults')).toBe('100');
    expect(requests.filter((url) => /\/messages\/[^/]+$/.test(new URL(url).pathname))).toEqual([]);
    expect([...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]])).toEqual(before);
  });
});

describe('bounded unread Gmail listing', () => {
  it('pages through old archived and Inbox unread mail while excluding read, Spam and Trash mail', async () => {
    const gmail = new FakeGmail();
    gmail.grants.set('synthetic-refresh', SCOPE_READONLY);
    gmail.clock = () => Date.parse('2026-10-24T00:00:00Z');
    const expected: string[] = [];
    for (let index = 0; index < 103; index++) {
      const id = (0xa00000 + index).toString(16);
      expected.push(id);
      gmail.deliver(message({ ...MAILS.newsletterEn, id, labels: ['UNREAD', ...(index % 2 === 0 ? ['INBOX'] : []), 'STARRED', 'CATEGORY_UPDATES'] }));
    }
    for (const [index, labels] of [['INBOX'], ['UNREAD', 'SPAM'], ['UNREAD', 'TRASH']].entries()) {
      gmail.deliver(message({ ...MAILS.newsletterEn, id: (0xb00000 + index).toString(16), labels }));
    }
    const before = [...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]]);
    const client = unreadClientFor(async (input, init) => {
      const request = new Request(input, init);
      return gmail.handle(request.method, new URL(request.url), request.headers, await request.text());
    });

    const first = await client.unreadPage();
    const second = await client.unreadPage(first.nextPageToken);

    expect(first).toEqual({ ids: expected.slice(0, 100), nextPageToken: '100' });
    expect(second).toEqual({ ids: expected.slice(100) });
    expect([...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]])).toEqual(before);
    expect(gmail.calls.filter((call) => call.method === 'GET').map((call) => call.url)).toEqual([
      `${BASE}/messages?labelIds=UNREAD&maxResults=100`,
      `${BASE}/messages?labelIds=UNREAD&maxResults=100&pageToken=100`,
    ]);
    for (const call of gmail.calls) {
      expect(allowedOperation(call.method, call.url, call.body, { owned: new Set(), planned: new Set(), ledger: () => null })).not.toBeNull();
    }
  });

  it.each([{}, { messages: [] }])('accepts an empty final page: %j', async (answer) => {
    await expect(unreadClientFor(() => Promise.resolve(Response.json(answer)), true).unreadPage()).resolves.toEqual({ ids: [] });
  });

  it.each([
    null,
    { messages: null },
    { messages: {} },
    { messages: [null] },
    { messages: [{}] },
    { messages: [{ id: 'not-a-message' }] },
    { messages: [{ id: MAILS.newsletterEn.id }, { id: MAILS.newsletterEn.id }] },
    { messages: Array.from({ length: 101 }, (_, index) => ({ id: (0xa00000 + index).toString(16) })) },
    { messages: [], nextPageToken: '100' },
    { messages: [{ id: MAILS.newsletterEn.id }], nextPageToken: 100 },
    { messages: [{ id: MAILS.newsletterEn.id }], nextPageToken: '' },
    { messages: [{ id: MAILS.newsletterEn.id }], nextPageToken: 'a b' },
    { messages: [{ id: MAILS.newsletterEn.id }], nextPageToken: 'a'.repeat(257) },
  ])('rejects a malformed or unbounded page: %j', async (answer) => {
    await expect(unreadClientFor(() => Promise.resolve(Response.json(answer)), true).unreadPage()).rejects.toMatchObject({
      name: 'GoogleError',
      kind: 'bad_answer',
    });
  });

  it('rejects invalid page tokens before fetch', async () => {
    let calls = 0;
    const client = unreadClientFor(() => {
      calls++;
      return Promise.resolve(Response.json({}));
    }, true);
    for (const token of ['', 'a b', 'a&labelIds=SPAM', 'a'.repeat(257)]) {
      await expect(client.unreadPage(token)).rejects.toBeInstanceOf(GmailRefused);
    }
    expect(calls).toBe(0);
  });

  it.each([
    [401, 'auth'],
    [429, 'rate'],
    [503, 'unavailable'],
  ] as const)('maps unread-list HTTP %i to %s', async (status, kind) => {
    await expect(unreadClientFor(() => Promise.resolve(Response.json({}, { status })), true).unreadPage()).rejects.toMatchObject({
      name: 'GoogleError',
      kind,
      code: `unread_list_${String(status)}`,
    });
  });
});
