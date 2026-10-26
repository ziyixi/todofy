import { describe, expect, it } from 'vitest';
import { GmailClient, SCOPE_READONLY } from '../src/gmail.ts';
import { FakeGmail } from './fakes/fake-gmail.ts';
import { MAILS, message } from './fakes/fixtures.ts';
import { allowedOperation } from './fakes/table.ts';

describe('recent unclassified Inbox discovery', () => {
  it('includes read mail without reading bodies, excludes graded mail before the cap, and leaves old/archive mail alone', async () => {
    const gmail = new FakeGmail();
    const now = Date.parse('2026-10-26T02:00:00Z');
    gmail.clock = () => now;
    gmail.grants.set('synthetic-refresh', SCOPE_READONLY);
    const priority = gmail.createUserLabel('P1');
    for (let i = 0; i < 101; i++) gmail.deliver(message({ ...MAILS.bankEn, id: (0xa00000 + i).toString(16), receivedAt: now - 1000, labels: ['INBOX', priority] }));
    const read = 'b000001';
    const unread = 'b000002';
    for (const [id, labels, receivedAt] of [
      [read, ['INBOX', 'STARRED'], now - 1000],
      [unread, ['INBOX', 'UNREAD'], now - 1000],
      ['b000003', ['INBOX'], now - 3 * 86_400_000],
      ['b000004', ['STARRED'], now - 1000],
      ['b000005', ['INBOX', 'SPAM'], now - 1000],
    ] as const) gmail.deliver(message({ ...MAILS.bankEn, id, labels, receivedAt }));
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
      ownership: { ownedLabelIds: () => new Set(), plannedPaths: () => new Set(), plannedPath: () => null, ledger: () => null },
      now: () => now,
      onCall: () => {},
    });
    expect(await client.recentUnclassifiedInbox(100)).toEqual([read, unread]);
    const listing = new URL(requests.find((url) => new URL(url).pathname.endsWith('/messages')) ?? '');
    expect(listing.searchParams.get('labelIds')).toBe('INBOX');
    expect(listing.searchParams.get('q')).toBe('newer_than:2d -label:P1 -label:P2 -label:P3 -label:P4');
    expect(listing.searchParams.get('maxResults')).toBe('100');
    expect(requests.filter((url) => /\/messages\/[^/]+$/.test(new URL(url).pathname))).toEqual([]);
    expect([...gmail.messages].map(([id, mail]) => [id, [...mail.labelIds]])).toEqual(before);
  });
});
