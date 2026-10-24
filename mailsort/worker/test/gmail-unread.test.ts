import { describe, expect, it } from 'vitest';
import { GmailClient, GmailRefused, type Ownership, SCOPE_READONLY } from '../src/gmail.ts';
import { FakeGmail } from './fakes/fake-gmail.ts';
import { MAILS, message } from './fakes/fixtures.ts';
import { allowedOperation } from './fakes/table.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OWNERSHIP: Ownership = { ownedLabelIds: () => new Set(), plannedPaths: () => new Set(), plannedPath: () => null, ledger: () => null };

function clientFor(fetcher: typeof fetch, cachedToken = false): GmailClient {
  return new GmailClient({
    fetch: fetcher,
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' },
    ownership: OWNERSHIP,
    now: () => 0,
    onCall: () => {},
    ...(cachedToken ? { token: { token: 'synthetic-access', expiresAt: 100_000, writeScope: false } } : {}),
  });
}

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
    const client = clientFor(async (input, init) => {
      const request = new Request(input, init);
      return gmail.handle(request.method, new URL(request.url), request.headers, await request.text());
    });

    const first = await client.unreadPage();
    const second = await client.unreadPage(first.nextPageToken);

    expect(first).toEqual({ ids: expected.slice(0, 100), nextPageToken: '100' });
    expect(second).toEqual({ ids: expected.slice(100) });
    expect([...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]])).toEqual(before);
    expect(gmail.calls.filter(call => call.method === 'GET').map(call => call.url)).toEqual([
      `${BASE}/messages?labelIds=UNREAD&maxResults=100`,
      `${BASE}/messages?labelIds=UNREAD&maxResults=100&pageToken=100`,
    ]);
    for (const call of gmail.calls) expect(allowedOperation(call.method, call.url, call.body, { owned: new Set(), planned: new Set(), ledger: () => null })).not.toBeNull();
  });

  it.each([{}, { messages: [] }])('accepts an empty final page: %j', async answer => {
    await expect(clientFor(() => Promise.resolve(Response.json(answer)), true).unreadPage()).resolves.toEqual({ ids: [] });
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
  ])('rejects a malformed or unbounded page: %j', async answer => {
    await expect(clientFor(() => Promise.resolve(Response.json(answer)), true).unreadPage()).rejects.toMatchObject({ name: 'GoogleError', kind: 'bad_answer' });
  });

  it('rejects invalid page tokens before fetch', async () => {
    let calls = 0;
    const client = clientFor(() => { calls++; return Promise.resolve(Response.json({})); }, true);
    for (const token of ['', 'a b', 'a&labelIds=SPAM', 'a'.repeat(257)]) await expect(client.unreadPage(token)).rejects.toBeInstanceOf(GmailRefused);
    expect(calls).toBe(0);
  });

  it.each([[401, 'auth'], [429, 'rate'], [503, 'unavailable']] as const)('maps unread-list HTTP %i to %s', async (status, kind) => {
    await expect(clientFor(() => Promise.resolve(Response.json({}, { status })), true).unreadPage()).rejects.toMatchObject({ name: 'GoogleError', kind, code: `unread_list_${String(status)}` });
  });
});
