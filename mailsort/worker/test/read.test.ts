/**
 * What the pipeline reads of a mail (../../docs/design.md §4.1-§4.3): the MIME walk, masking and minimizing, the
 * address and List-Id parsing, and DMARC alignment. Synthetic mails only (fakes/fixtures.ts).
 */
import { describe, expect, it } from 'vitest';
import { dmarcAligned } from '../src/dmarc.ts';
import { BODY_CHARS } from '../src/limits.ts';
import { aliasCode, cut, features, firstMailbox, listIdOf, mask, summaryOf } from '../src/mask.ts';
import { bodyText, decodeBase64Url, readMessage, stripHtml } from '../src/mime.ts';
import { MAILS, message } from './fakes/fixtures.ts';

describe('masking', () => {
  it('replaces addresses, long digit runs and URLs (to their domain)', () => {
    expect(mask('Write to alice@mail.example.com about 12345678 at https://www.shop.example.com/a?b=1', 200)).toBe(
      'Write to [email] about [number] at [link shop.example.com]',
    );
    expect(mask('验证码 482913，请在 10 分钟内输入', 100)).toBe('验证码 [number]，请在 10 分钟内输入');
    expect(mask('short 12345 stays', 100)).toBe('short 12345 stays');
  });

  it('cuts by code points without splitting a pair', () => {
    expect(cut('😀😀😀', 2)).toBe('😀😀…');
    expect(cut('abc', 3)).toBe('abc');
  });

  it('stays linear on hostile input', () => {
    const hostile = `${'a'.repeat(50_000)}@${'b.'.repeat(20_000)}`;
    const started = performance.now();
    mask(hostile, BODY_CHARS);
    mask('1'.repeat(100_000), BODY_CHARS);
    mask(`https://${'x'.repeat(100_000)}`, BODY_CHARS);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('addresses and lists', () => {
  it('reads the first mailbox of a header', () => {
    expect(firstMailbox('"Weekly Digest" <Digest@News.Example.com>')).toEqual({ name: 'Weekly Digest', address: 'digest@news.example.com', domain: 'news.example.com' });
    expect(firstMailbox('bare@example.org')).toEqual({ name: '', address: 'bare@example.org', domain: 'example.org' });
    expect(firstMailbox('no address here')).toBeNull();
  });

  it('reads a List-Id', () => {
    expect(listIdOf('Synthetic list <Digest.News.Example.com>')).toBe('digest.news.example.com');
    expect(listIdOf('')).toBe('');
  });

  it('gives the delivered-to address a stable code, never the address', async () => {
    const code = await aliasCode('owner@example.com');
    expect(code).toMatch(/^to-[0-9a-f]{6}$/);
    expect(await aliasCode('owner@example.com')).toBe(code);
    expect(code).not.toContain('owner');
  });
});

describe('MIME', () => {
  it('decodes base64url UTF-8', () => {
    expect(decodeBase64Url(btoa(String.fromCharCode(...new TextEncoder().encode('你好 world'))).replaceAll('+', '-').replaceAll('/', '_'))).toBe('你好 world');
  });

  it('prefers text/plain and falls back to stripped HTML', () => {
    expect(readMessage(message({ ...MAILS.receiptEn }))?.body).toContain('Thank you for your order');
    const html = message({ id: 'b0000000000000b1', from: 'x@example.com', subject: 's', html: '<html><head><style>p{}</style><script>alert(1)</script></head><body><p>Hello&nbsp;<b>there</b> &amp; you</p></body></html>' });
    expect(readMessage(html)?.body).toBe('Hello there & you');
    expect(stripHtml('<!-- hidden -->visible')).toBe(' visible');
  });

  it('bounds the walk', () => {
    let deep: Record<string, unknown> = { mimeType: 'text/plain', body: { data: btoa('deep') } };
    for (let i = 0; i < 20; i++) deep = { mimeType: 'multipart/mixed', parts: [deep] };
    expect(bodyText(deep)).toBe('');
    expect(bodyText({ mimeType: 'multipart/mixed', parts: Array.from({ length: 500 }, () => ({ mimeType: 'image/png' })) })).toBe('');
  });

  it('reads the headers, labels and thread', () => {
    const read = readMessage(message({ ...MAILS.newsletterEn }));
    expect(read?.headers.listId).toContain('digest.news.example.com');
    expect(read?.labelIds).toContain('INBOX');
    expect(read?.threadId).toBe(`t${MAILS.newsletterEn.id}`);
  });
});

describe('features', () => {
  it('keeps exact keys for rules and masks what the model sees', async () => {
    const read = readMessage(message({ ...MAILS.newsletterZh }));
    if (read === null) throw new Error('unreadable');
    const f = await features(read);
    expect(f.senderAddress).toBe('weekly@zh.example.org');
    expect(f.senderDomain).toBe('zh.example.org');
    expect(f.listId).toBe('weekly.zh.example.org');
    expect(f.sender).toBe('技术周报 <zh.example.org>');
    expect(f.body).toContain('[email]');
    expect(f.body).not.toContain('editor@');
    expect(f.toCode).toMatch(/^to-/);
    expect(f.category).toBe('updates');
    expect(summaryOf(f, 200).length).toBeLessThanOrEqual(201);
  });
});

describe('DMARC', () => {
  const pass = 'mx.google.com; dkim=pass header.i=@bank.example.com; spf=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example.com';
  it('needs Gmail’s own topmost header, a pass, and the From domain', () => {
    expect(dmarcAligned([pass], 'bank.example.com')).toBe(true);
    expect(dmarcAligned([pass], 'other.example.com')).toBe(false);
    expect(dmarcAligned([pass.replace('dmarc=pass', 'dmarc=fail')], 'bank.example.com')).toBe(false);
    expect(dmarcAligned([pass.replace('mx.google.com', 'evil.example.net')], 'bank.example.com')).toBe(false);
    // A forged header below Gmail's does not count; Gmail's failing one on top decides.
    expect(dmarcAligned([pass.replace('dmarc=pass', 'dmarc=fail'), pass], 'bank.example.com')).toBe(false);
    expect(dmarcAligned([], 'bank.example.com')).toBe(false);
  });
});
