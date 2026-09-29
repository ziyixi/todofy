import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMail } from '../src/native/parser.ts';
import { ATTACHMENT_BYTES, UI_TEXT_BYTES, WEBHOOK_TEXT_BYTES, truncateUTF8, webhookContent } from '../src/native/content-policy.ts';

function bucket() {
  const objects = new Map();
  return {objects, env:{MAIL_STORE:{async put(key, bytes) {objects.set(key, bytes.byteLength);}}}};
}
const raw = text => new TextEncoder().encode(text).buffer;
function mime(parts, type = 'mixed') {
  return raw(['Subject: Synthetic policy test', `Content-Type: multipart/${type}; boundary=fixture`, '',
    ...parts.map(part => '--fixture\r\n' + part), '--fixture--', ''].join('\r\n'));
}
const textPart = text => `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
const htmlPart = html => `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
const attachmentPart = (name, size, disposition = 'attachment', type = 'application/octet-stream') =>
  `Content-Type: ${type}\r\nContent-Disposition: ${disposition}; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(size, 97).toString('base64')}\r\n`;

test('UTF-8 budgets preserve code points and original byte count at every split', () => {
  const text = 'a中🙂z';
  for (let limit = 0; limit <= Buffer.byteLength(text) + 1; limit++) {
    const result = truncateUTF8(text, limit);
    assert.ok(text.startsWith(result.text));
    assert.ok(Buffer.byteLength(result.text) <= limit);
    assert.equal(result.original_bytes, 9);
    assert.equal(result.truncated, limit < 9);
    assert.doesNotMatch(result.text, /\uFFFD/);
  }
});

test('UI and webhook have separate transparent budgets, with no private R2 key in payload', async () => {
  const b = bucket(), text = '中🙂'.repeat(170_000);
  const {mail} = await parseMail(raw('Subject: Large text\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text), b.env, 'parsed/test');
  assert.equal(mail.original_text_bytes, Buffer.byteLength(text));
  assert.equal(mail.text_truncated, true);
  assert.ok(Buffer.byteLength(mail.text) <= UI_TEXT_BYTES);
  assert.equal(mail.needs_review, false);
  const payload = webhookContent(mail);
  assert.equal(payload.text_truncated, true);
  assert.equal(payload.original_text_bytes, Buffer.byteLength(text));
  assert.ok(Buffer.byteLength(payload.text) <= WEBHOOK_TEXT_BYTES);
  assert.ok(text.startsWith(payload.text));
  assert.equal(mail.text.length > payload.text.length, true, 'webhook must not mutate the saved UI body');
  const smaller = {...mail, text:'文'.repeat(100_000), text_truncated:false, original_text_bytes:300_000,
    attachments:[{part_id:'1.1',filename:'small.bin',content_type:'application/octet-stream',size:1,r2_key:'private/object',storage_status:'stored'}]};
  const smallerPayload = webhookContent(smaller);
  assert.equal(smallerPayload.text_truncated, true);
  assert.equal(smallerPayload.original_text_bytes, 300_000);
  assert.doesNotMatch(JSON.stringify(smallerPayload), /r2_key|private\/object/);
});

test('oversized or deeply nested HTML falls back to valid text, unsafe HTML-only requires review', async () => {
  for (const html of ['<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>', '<div>'.repeat(110) + 'nested' + '</div>'.repeat(110)]) {
    const {mail} = await parseMail(mime([textPart('Usable body'), htmlPart(html)], 'alternative'), bucket().env, 'parsed/test');
    assert.equal(mail.text, 'Usable body'); assert.equal(mail.html, '');
    assert.equal(mail.html_omitted, true); assert.equal(mail.needs_review, false);
    const only = await parseMail(mime([htmlPart(html)]), bucket().env, 'parsed/test');
    assert.equal(only.mail.text, ''); assert.equal(only.mail.needs_review, true);
    assert.ok(only.mail.warnings.includes('no_readable_body'));
  }
  const unsafe = await parseMail(mime([htmlPart('<script>alert(1)</script><img src="https://tracker.invalid/a">')]), bucket().env, 'parsed/test');
  assert.equal(unsafe.mail.text, ''); assert.equal(unsafe.mail.needs_review, true);
});

test('attachment copies obey individual, combined, inline-image and capacity policies', async () => {
  const parts = [textPart('Body remains readable'), attachmentPart('large.bin', ATTACHMENT_BYTES + 1),
    attachmentPart('a.bin', ATTACHMENT_BYTES), attachmentPart('b.bin', ATTACHMENT_BYTES),
    attachmentPart('c.bin', ATTACHMENT_BYTES), attachmentPart('logo.png', 4, 'inline', 'image/png'),
    attachmentPart('small.pdf', 4, 'attachment', 'application/pdf')];
  const b = bucket(), result = await parseMail(mime(parts), b.env, 'parsed/test');
  assert.deepEqual(result.mail.attachments.map(a => a.omitted_reason ?? 'stored'), ['size_limit','stored','stored','message_size_limit','inline_image','stored']);
  assert.equal(b.objects.size, 3); assert.equal(result.bytes, 2 * ATTACHMENT_BYTES + 4);
  assert.equal(result.mail.needs_review, false);
  for (const item of result.mail.attachments.filter(a => a.storage_status === 'omitted')) assert.equal(item.r2_key, undefined);
  const full = bucket();
  const noCopies = await parseMail(mime([textPart('Body'), attachmentPart('a.bin', 4)]), full.env, 'parsed/full', {storeAttachmentCopies:false});
  assert.equal(full.objects.size, 0); assert.equal(noCopies.bytes, 0);
  assert.equal(noCopies.mail.attachments[0].omitted_reason, 'capacity');
});

test('only first 100 attachment records and copies are retained, opaque parts still require review', async () => {
  const b = bucket();
  const parts = [textPart('Body'), ...Array.from({length:101}, (_, i) => attachmentPart(`${i}.bin`, 1))];
  const result = await parseMail(mime(parts), b.env, 'parsed/test');
  assert.equal(result.mail.attachments.length, 100);
  assert.equal(result.mail.attachments_omitted_count, 1);
  assert.equal(webhookContent(result.mail).attachments_omitted_count, 1);
  assert.equal(result.mail.needs_review, false); assert.equal(b.objects.size, 100);
  parts.push(attachmentPart('opaque.dat', 1, 'attachment', 'application/ms-tnef'));
  const opaque = await parseMail(mime(parts), bucket().env, 'parsed/opaque');
  assert.equal(opaque.mail.needs_review, true);
  assert.equal(opaque.mail.attachments_omitted_count, 2);
});

test('storage failure is retryable, never relabeled as an omitted attachment', async () => {
  await assert.rejects(parseMail(mime([textPart('Body'), attachmentPart('a.bin', 1)]),
    {MAIL_STORE:{async put() {throw new Error('synthetic_r2_failure');}}}, 'parsed/test'), /synthetic_r2_failure/);
});
