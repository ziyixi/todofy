import { create } from '@ziyixi/proto/protobuf';
import { MailItemSchema } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';
import { expect, test } from 'vitest';
import { mailTaskIds, mailTaskText, uuid5 } from '../src/mail.ts';

test('uuid5 is Python uuid.uuid5(NAMESPACE_URL, name), so the IDs Todofy derived stay the same', async () => {
  expect(await uuid5('汉字')).toBe('7f65845f-c52d-5bfd-97b2-d4215abee53e');
  expect(await mailTaskIds('evt-synthetic-1')).toEqual([
    'a1aaa21f-20a5-5d58-998f-e250b57cbdac',
    'aec8f3e4-27af-52c1-b750-65c64225f510',
  ]);
});

const ORIGIN = 'https://tasks.example.test';
const FOOTER = `\n\n[查看完整邮件摘要](${ORIGIN}/?mail=evt-1#/mail)\n\nMail Hero event: evt-1`;
function text(title: string, summary: string) {
  return mailTaskText(create(MailItemSchema, { id: 'evt-1', title, summary }), ORIGIN);
}

test("a mail task is the subject, the summary, a link back and Todofy's footer", () => {
  expect(text('Synthetic invoice', 'Pay by Friday.')).toEqual({
    title: 'Synthetic invoice',
    description: `Pay by Friday.${FOOTER}`,
  });
  expect(text('  ', '').title).toBe('(No subject)');
  expect(text('x'.repeat(600), '').title).toHaveLength(500);
});

test('a long summary is cut to 16,000 UTF-16 units, says so, and never splits a character', () => {
  const notice = '\n\n（任务描述已截断；完整摘要保留在 Mail 中。）';
  const fits = 'a'.repeat(16000 - FOOTER.length);
  expect(text('t', fits).description).toBe(fits + FOOTER);
  const long = text('t', `${fits}b`).description;
  expect(long).toHaveLength(16000);
  expect(long.endsWith(notice + FOOTER)).toBe(true);
  // An emoji is two units: one that would end half inside the limit is left out.
  const emoji = text('t', '😀'.repeat(9000)).description;
  expect(emoji.length).toBeLessThanOrEqual(16000);
  expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(emoji.endsWith(notice + FOOTER)).toBe(true);
});
