/**
 * mailhero/webhook/v1/mail_received.proto is the IDL of contracts/mail-received-v1, in TypeScript (Python twin:
 * test/python/test_mail_received.py; test/cross-language.test.ts pipes the fixtures through both codecs).
 *
 * Every current fixture is the bytes the codec writes after a lenient read (Mail Hero's builder writes them with it:
 * mail-hero/cloudflare/test/contract-fixtures.test.mjs); a frozen legacy event reads, and the codec would not write
 * it again byte for byte (no `warnings`), which is why a delivery's retries resend the frozen bytes and nothing builds
 * an event twice. A consumer's lenient read skips a newer field and checks every rule.
 */
import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { MailReceivedEventSchema, MailSchema, OmittedReason, StorageStatus } from '../ts/mailhero/webhook/v1/mail_received_pb.ts';
import { fieldRules, fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';
import { mailFixtures } from './fixtures.ts';

const current = mailFixtures();
const legacy = mailFixtures(true);
const plain = current.find((f) => f.name === 'plain_text.json')!.value as { message: Record<string, unknown> };

/** plain_text with some fields of the event and of its message changed; undefined drops a field. */
function mutate(change: Record<string, unknown>, message: Record<string, unknown> = {}): unknown {
  return JSON.parse(JSON.stringify({ ...plain, ...change, message: { ...plain.message, ...message } }));
}

describe('mail-received-v1 fixtures', () => {
  test('there are the 16 current fixtures and the frozen legacy one', () => {
    expect(current.length).toBe(16);
    expect(legacy.map((f) => f.name)).toEqual(['pre_storage_v1.json']);
  });

  test.each(current.map((f) => [f.name, f] as const))('%s: the codec writes it byte for byte', (_name, fixture) => {
    const read = fromWire(MailReceivedEventSchema, fixture.value);
    expect(read.unrecognized).toEqual([]);
    expect(JSON.stringify(toWire(MailReceivedEventSchema, read.message))).toBe(fixture.text);
  });

  test('a frozen legacy event reads, and is never the codec\'s own bytes: retries resend what was frozen', () => {
    const [fixture] = legacy;
    const read = fromWire(MailReceivedEventSchema, fixture!.value);
    expect(read.message.message?.warnings).toEqual([]);
    expect(read.message.message?.textTruncated).toBeUndefined();
    const rewritten = JSON.stringify(toWire(MailReceivedEventSchema, read.message));
    expect(rewritten).not.toBe(fixture!.text);
    expect(rewritten).toBe(fixture!.text.replace(',"attachments":[]', ',"warnings":[],"attachments":[]'));
  });
});

describe('a consumer reads leniently and checks every rule', () => {
  test('a newer field is skipped, at any depth', () => {
    const read = fromWire(MailReceivedEventSchema, mutate({ newer: 1, canary: { run_id: 'canary-1', attempt: 2 } }, { newer_flag: true }));
    expect(read.unrecognized).toEqual(['message.newer_flag', 'newer', 'canary.attempt']);
    expect(read.message.canary?.runId).toBe('canary-1');
  });

  test.each([
    ['another type', { type: 'mail.received.v2' }, {}, 'type: not an allowed value'],
    ['an event ID that is not a UUID', { event_id: 'nope' }, {}, 'event_id: does not match Uuid'],
    ['a time not in UTC', { received_at: '2026-09-28T08:00:00+00:00' }, {}, 'received_at: does not match ReceivedAt'],
    ['an unreadable canary', { canary: { run_id: 'canary 1' } }, {}, 'canary.run_id: does not match RunId'],
    ['a null canary', { canary: null }, {}, 'canary: wrong type'],
    ['a null message', { message: null }, null, 'message: required'],
    ['a blank subject and text', {}, { subject: ' ', text: '　\n' }, 'message: no value of subject, text matches Visible'],
    ['a truncated text without its size', {}, { text_truncated: true, original_text_bytes: undefined }, 'message.original_text_bytes: required when text_truncated is true'],
    ['a negative size', {}, { attachments: [{ filename: 'a', content_type: 'b', size: -1 }] }, 'message.attachments[0].size: below the minimum'],
    ['an unknown storage status (closed)', {}, { attachments: [{ filename: 'a', content_type: 'b', size: 1, storage_status: 'deleted' }] }, 'message.attachments[0].storage_status: unknown enum value'],
    ['51 From addresses', {}, { from: Array.from({ length: 51 }, () => ({ address: 'a@example.org', name: '' })) }, 'message.from: more than 50 items'],
    ['a sent time that is no time', {}, { sent_at: 'yesterday' }, 'message.sent_at: does not match SentAt'],
  ])('refuses %s', (_name, change, message, error) => {
    const document = message === null ? { ...plain, ...change } : mutate(change, message);
    expect(() => fromWire(MailReceivedEventSchema, document)).toThrow(new WireJsonError(error));
  });

  test('accepts what consumers have always accepted', () => {
    for (const [change, message] of [
      [{ event_id: 'F8C1E9A0-1A98-4FB8-8CA1-4C0A3E710001' }, {}],
      [{}, { sent_at: '2026-09-23T16:00:00.123456789+05:30' }],
      [{}, { sent_at: '+010000-01-01T00:00:00.000Z' }],
      [{}, { sent_at: null, rfc_message_id: null }],
      [{}, { subject: '   ' }],
      [{}, { subject: '﻿', text: '' }],
    ] as const) {
      expect(() => fromWire(MailReceivedEventSchema, mutate(change, message)), JSON.stringify([change, message])).not.toThrow();
    }
  });
});

describe('Mail Hero builds with the generated message', () => {
  test('the contract\'s bounds are read where the IDL states them', () => {
    expect(fieldRules(MailSchema.field.from).maxItems).toBe(50);
    expect(fieldRules(MailSchema.field.attachments).maxItems).toBe(100);
    expect(fieldRules(MailSchema.field.warnings).writeEmpty).toBe(true);
    expect(fieldRules(MailSchema.field.originalTextBytes).presentWhen).toBe('text_truncated');
  });

  test('a built event is the fixture\'s bytes, and a write refuses what a read refuses', () => {
    const fixture = current.find((f) => f.name === 'attachments_capacity.json')!;
    const built = create(MailReceivedEventSchema, {
      type: 'mail.received.v1', eventId: 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710007', receivedAt: '2026-09-28T08:00:00.000Z',
      message: {
        id: 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e720007', from: [{ address: 'sender@example.org', name: 'Sender Example' }],
        to: [{ address: 'other@example.com', name: 'Other Person' }], subject: 'Quarterly report', sentAt: '2026-09-28T07:59:30.000Z',
        rfcMessageId: 'synthetic-1@example.org', text: 'Capacity protection skipped the copy.', textTruncated: false, originalTextBytes: 37,
        htmlOmitted: false, needsReview: false, warnings: ['attachment_copies_omitted'], contentPolicyVersion: 'storage-v1', attachmentsOmittedCount: 0,
        attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 64, storageStatus: StorageStatus.OMITTED, omittedReason: OmittedReason.CAPACITY }],
      },
    });
    expect(JSON.stringify(toWire(MailReceivedEventSchema, built))).toBe(fixture.text);
    built.message!.subject = '\x1c';
    built.message!.text = '';
    expect(() => toWire(MailReceivedEventSchema, built)).toThrow(new WireJsonError('message: no value of subject, text matches Visible'));
  });
});
