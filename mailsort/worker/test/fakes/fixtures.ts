/**
 * Synthetic mails, Chinese and English, from example.com-style domains (RFC 2606): never a real message, address or
 * person. Each builds the Gmail API's message JSON (payload headers and base64url parts) that FakeGmail serves.
 */
import type { FakeMessage } from './fake-gmail.ts';

export interface SyntheticMail {
  readonly id: string;
  readonly threadId?: string;
  readonly from: string;
  readonly to?: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly listId?: string;
  /** dmarc=pass with header.from = the From domain, or fail, or no Authentication-Results at all. */
  readonly dmarc?: 'pass' | 'fail' | 'none';
  readonly labels?: readonly string[];
  readonly receivedAt?: number;
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export const OWNER_ADDRESS = 'owner@example.com';

export function message(mail: SyntheticMail): Omit<FakeMessage, 'labelIds'> & { labelIds: string[] } {
  const domain = /@([^>\s]+)/.exec(mail.from)?.[1] ?? 'example.com';
  const headers = [
    { name: 'Delivered-To', value: mail.to ?? OWNER_ADDRESS },
    ...(mail.dmarc === 'none' ? [] : [{ name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=${mail.dmarc ?? 'pass'} (p=REJECT sp=REJECT dis=NONE) header.from=${domain}` }]),
    { name: 'From', value: mail.from },
    { name: 'To', value: mail.to ?? OWNER_ADDRESS },
    { name: 'Subject', value: mail.subject },
    { name: 'Message-ID', value: `<${mail.id}@mail.example.net>` },
    ...(mail.listId === undefined ? [] : [{ name: 'List-Id', value: `Synthetic list <${mail.listId}>` }]),
  ];
  const parts = [
    ...(mail.text === undefined ? [] : [{ mimeType: 'text/plain', headers: [], body: { size: mail.text.length, data: base64Url(mail.text) } }]),
    ...(mail.html === undefined ? [] : [{ mimeType: 'text/html', headers: [], body: { size: mail.html.length, data: base64Url(mail.html) } }]),
  ];
  return {
    id: mail.id,
    threadId: mail.threadId ?? `t${mail.id}`,
    labelIds: [...(mail.labels ?? ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'])],
    snippet: (mail.text ?? mail.html ?? '').replace(/<[^>]*>/g, ' ').slice(0, 120),
    internalDate: mail.receivedAt ?? Date.parse('2026-10-01T00:00:00Z'),
    payload: { mimeType: 'multipart/alternative', headers, body: { size: 0 }, parts },
  };
}

/** The tests' labels: ID, Chinese display name, and the description the fake model matches words of. */
export const LABELS = [
  { id: 'newsletter', displayName: '订阅', description: 'newsletter weekly digest 周报 订阅' },
  { id: 'receipt', displayName: '收据', description: 'receipt invoice order 订单 收据 发票' },
  { id: 'travel', displayName: '出行', description: 'flight itinerary hotel 航班 行程 酒店' },
  { id: 'bank', displayName: '银行', description: 'bank statement account 银行 账户 对账单', trust: true },
] as const;

export const MAILS = {
  newsletterEn: { id: 'a0000000000000a1', from: 'Weekly Digest <digest@news.example.com>', subject: 'Your weekly digest: 5 new posts', text: 'This week in the newsletter: five new posts. Unsubscribe at https://news.example.com/u?id=123456789', listId: 'digest.news.example.com' },
  newsletterZh: { id: 'a0000000000000a2', from: '技术周报 <weekly@zh.example.org>', subject: '本周技术周报 第 42 期', text: '订阅的周报来了：本期有三篇文章。联系 editor@zh.example.org 退订。', listId: 'weekly.zh.example.org' },
  receiptEn: { id: 'a0000000000000a3', from: 'Shop <orders@shop.example.com>', subject: 'Receipt for order 99887766', text: 'Thank you for your order. Your receipt and invoice total is 42.00.' },
  receiptZh: { id: 'a0000000000000a4', from: '商城 <service@mall.example.cn>', subject: '您的订单 20261001123456 已发货', text: '订单已发货，电子发票见附件。' },
  travelZh: { id: 'a0000000000000a5', from: '旅行助手 <trip@travel.example.net>', subject: '航班行程确认', text: '您的航班行程已确认，酒店预订另行通知。' },
  unsure: { id: 'a0000000000000a6', from: 'Friend <friend@people.example.org>', subject: 'Lunch on Friday?', text: 'Are you free for lunch on Friday? Let me know.' },
  phishing: { id: 'a0000000000000a7', from: 'Bank Support <support@bank-secure.example.net>', subject: 'Urgent: verify your account', text: 'Your bank account is suspended. Verify your account at https://bank-secure.example.net/login now.', dmarc: 'fail' },
  bankEn: { id: 'a0000000000000a8', from: 'Example Bank <statements@bank.example.com>', subject: 'Your monthly bank statement', text: 'Your bank account statement for September is ready.' },
  sent: { id: 'a0000000000000a9', from: 'Owner <owner@example.com>', subject: 'Re: order', text: 'Thanks!', labels: ['SENT'] },
} as const satisfies Record<string, SyntheticMail>;
