#!/usr/bin/env node
// Golden mail.received.v1 payloads for contracts/mail-received-v1/fixtures.
//
// Every fixture is the exact byte string Mail Hero's own code produces: parseMail() on a synthetic
// .eml, the JSON round trip through R2 that createDelivery() performs, then buildPayload(). The
// synthetic connection test uses syntheticTestMail(). No real mail is used.
//
//   npm run contract:update     rewrite the fixtures after an intended builder change
//   npm test                    contract-fixtures.test.mjs fails while a fixture is stale
//
// Todofy's contract tests parse the same files, so a builder change that Todofy cannot accept fails
// CI as soon as the fixtures are updated. Files in fixtures/legacy/ are frozen bytes from older
// builders (retries resend frozen bytes forever); this script never writes them.
import { readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseMail } from '../src/native/parser.ts'
import { buildPayload, syntheticTestMail } from '../src/native/pipeline.ts'

export const FIXTURES = new URL('../../../contracts/mail-received-v1/fixtures/', import.meta.url)
const RECEIVED_AT = '2026-09-28T08:00:00.000Z'
const INBOX = 'inbox@mail.example.org'
const eventID = number => `f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71${String(number).padStart(4, '0')}`
const messageID = number => `f8c1e9a0-1a98-4fb8-8ca1-4c0a3e72${String(number).padStart(4, '0')}`

const base64 = bytes => Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n')
const word = text => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`
const HEADERS = {
  From: 'Sender Example <sender@example.org>',
  To: `Other Person <other@example.com>, ${INBOX}`,
  Subject: 'Quarterly report',
  Date: 'Mon, 28 Sep 2026 00:59:30 -0700',
  'Message-ID': '<synthetic-1@example.org>',
  'MIME-Version': '1.0',
}
function eml(headers, contentType, body) {
  const lines = Object.entries({...HEADERS, ...headers}).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`)
  return [...lines, `Content-Type: ${contentType}`, '', body].join('\r\n')
}
const plain = (text, headers = {}) =>
  eml({...headers, 'Content-Transfer-Encoding': 'base64'}, 'text/plain; charset=utf-8', base64(Buffer.from(text)))
function mixed(parts, headers = {}) {
  return eml(headers, 'multipart/mixed; boundary="contract-fixture"',
    [...parts.map(part => `--contract-fixture\r\n${part}`), '--contract-fixture--', ''].join('\r\n'))
}
const textPart = text => `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`
const filePart = (filename, type, size, disposition = 'attachment') =>
  `Content-Type: ${type}\r\nContent-Disposition: ${disposition}; filename="${filename}"\r\n` +
  `Content-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.alloc(size, 0x61))}\r\n`

/** name -> how Mail Hero received it. Numbers fix the event/message IDs; never reuse one. */
export const CASES = [
  {name: 'plain_text', number: 1, raw: () => plain('Please review the attached numbers & reply by Friday <soon>.\n\nThanks,\n"Sender"\n')},
  {name: 'chinese', number: 2, raw: () => plain('您好，\n\n请在 10 月 15 日前完成季度预缴税。#重要 附件见邮件。\n\n—— 合成测试邮件\n', {
    From: `${word('张三')} <zhangsan@example.org>`, To: `${word('李四')} <lisi@example.com>, ${INBOX}`,
    Subject: word('季度预缴税提醒：10 月 15 日截止'),
  })},
  {name: 'html_only', number: 3, raw: () => eml({}, 'text/html; charset=utf-8',
    '<h1>Invoice</h1><script>alert(1)</script><p>Amount due: $42 &amp; fees.</p><a href="https://example.org/pay">Pay</a><img src="https://example.org/t.gif">\r\n')},
  {name: 'body_only_no_subject', number: 4, raw: () => plain('A body without any subject line.', {Subject: null})},
  {name: 'no_date_no_message_id', number: 5, raw: () =>
    plain('No Date or Message-ID header; only the inbox as recipient.', {From: 'bare@example.org', To: INBOX, Date: null, 'Message-ID': null})},
  {name: 'attachments_stored_and_omitted', number: 6, raw: () => mixed([
    textPart('See attachments.'),
    filePart('report.pdf', 'application/pdf', 1234),
    filePart('huge.bin', 'application/octet-stream', 2 * 1024 * 1024 + 1),
    filePart('logo.png', 'image/png', 512, 'inline'),
    // Three 1.9 MB parts: the third exceeds the 5 MiB per-message copy budget.
    ...[1, 2, 3].map(n => filePart(`part${n}.zip`, 'application/zip', 1_945_600)),
  ])},
  {name: 'attachments_capacity', number: 7, options: {storeAttachmentCopies: false}, raw: () => mixed([
    textPart('Capacity protection skipped the copy.'), filePart('notes.txt', 'text/plain', 64),
  ])},
  {name: 'attachments_metadata_limit', number: 8, raw: () => mixed([
    textPart('Many small files.'), ...Array.from({length: 105}, (_, i) => filePart(`f${i + 1}.txt`, 'text/plain', 8)),
  ])},
  // 300,027 bytes: under the 1 MiB UI budget, over the 256 KiB webhook budget.
  {name: 'truncated_webhook', number: 9, raw: () => plain('长'.repeat(100_009))},
  {name: 'truncated_ui_and_webhook', number: 10, raw: () => plain('x'.repeat(1_200_000))},
  // Sent only by an explicit owner action: automatic delivery holds needs_review mail.
  {name: 'needs_review_attached_message', number: 11, raw: () => mixed([
    textPart('Forwarded message attached.'),
    'Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="fwd.eml"\r\n\r\n' +
      'From: inner@example.org\r\nSubject: Inner\r\n\r\nInner body 1.\r\n\r\n',
  ])},
  {name: 'needs_review_no_readable_body', number: 12, raw: () =>
    eml({}, 'text/html; charset=utf-8', `<p>${'x'.repeat(2 * 1024 * 1024)}</p>\r\n`)},
  // The largest body the builder emits (256 KiB), with 155,000 control characters that JSON escapes to
  // six bytes each, so the payload approaches the 1 MiB webhook limit.
  {name: 'max_size', number: 13, raw: () => plain('\u0001'.repeat(155_000) + 'y'.repeat(107_144))},
  // new Date(header).toISOString() of a year-10000 Date header.
  {name: 'sent_at_extended_year', number: 14, raw: () =>
    plain('A spam-like Date header in year 10000.', {Date: 'Sat, 01 Jan 10000 00:00:00 +0000'})},
  {name: 'synthetic_test_event', number: 15, mail: () => syntheticTestMail()},
]

const bucket = {MAIL_STORE: {async put() {}}}

/** The exact webhook body Mail Hero would freeze for this case. */
export async function buildFixture(testCase) {
  let mail = testCase.mail?.()
  if (!mail) {
    const raw = new TextEncoder().encode(testCase.raw()).buffer
    mail = (await parseMail(raw, bucket, `parsed/${messageID(testCase.number)}/contract`, testCase.options)).mail
  }
  // createDelivery reads the parsed message back from R2 as JSON.
  const stored = JSON.parse(JSON.stringify(mail))
  return buildPayload(eventID(testCase.number), messageID(testCase.number), RECEIVED_AT, stored, INBOX, INBOX)
}

export const fixtureFiles = () => readdirSync(FIXTURES).filter(name => name.endsWith('.json')).sort()

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--write')) {
    console.error('Usage: node test/contract-fixtures.mjs --write   (or npm run contract:update)')
    process.exit(2)
  }
  const expected = new Set(CASES.map(testCase => `${testCase.name}.json`))
  for (const stale of fixtureFiles().filter(name => !expected.has(name))) {
    console.error(`Remove or rename the stale fixture ${stale}; it has no case in contract-fixtures.mjs.`)
    process.exitCode = 1
  }
  for (const testCase of CASES) {
    writeFileSync(new URL(`${testCase.name}.json`, FIXTURES), await buildFixture(testCase))
  }
  console.log(`Wrote ${CASES.length} fixtures to ${fileURLToPath(FIXTURES)}`)
}
