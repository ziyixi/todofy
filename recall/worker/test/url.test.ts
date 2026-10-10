// shared/url.ts: normalization, the page ID (against the archive contract's fixtures) and the length bounds.
// Synthetic URLs on example.com, example.org and example.net only.
import { describe, expect, it } from 'vitest';
import { cutText, cutUrl, cutUtf8, normalizeUrl, pageIdOf, rootUrl, siteOf, TEXT_MAX_CHARS, URL_MAX_CHARS, utf8Bytes } from '../../shared/url.ts';

describe('normalizeUrl', () => {
  it('keeps http(s) only, lower-cases the host, drops a default port and user-info', () => {
    expect(normalizeUrl('HTTPS://Docs.Example.COM:443/Guide/Durable-Objects')?.url).toBe('https://docs.example.com/Guide/Durable-Objects');
    expect(normalizeUrl('http://example.com:80/')?.url).toBe('http://example.com/');
    expect(normalizeUrl('http://example.com:8080/a')?.url).toBe('http://example.com:8080/a');
    expect(normalizeUrl('https://user:secret@example.com/x')?.url).toBe('https://example.com/x');
    for (const other of ['chrome://settings', 'file:///etc/hosts', 'chrome-extension://abc/page.html', 'about:blank', 'not a url', 'data:text/plain,x']) {
      expect(normalizeUrl(other), other).toBeNull();
    }
  });

  it('drops the fragment unless it is a hash route', () => {
    expect(normalizeUrl('https://example.com/a#section-2')?.url).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/app#/inbox/42')?.url).toBe('https://example.com/app#/inbox/42');
    expect(normalizeUrl('https://example.com/app#!/settings')?.url).toBe('https://example.com/app#!/settings');
  });

  it('removes tracking parameters, ignoring case, and keeps the rest raw and in order', () => {
    const url = 'https://news.example.org/story?id=7&utm_source=feed&UTM_Medium=x&b=%E4%B8%AD&fbclid=abc&gclid=1&q=a+b&ref_src=twsrc&_hsenc=p&yclid=9';
    expect(normalizeUrl(url)?.url).toBe('https://news.example.org/story?id=7&b=%E4%B8%AD&q=a+b');
    expect(normalizeUrl('https://example.com/?utm_campaign=only')?.url).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/?a=1&&b=2&')?.url).toBe('https://example.com/?a=1&b=2');
  });

  it('serializes as ASCII: an IDN in punycode, a path in percent-escapes', () => {
    const normalized = normalizeUrl('https://例え.example.jp/路径?q=搜索');
    expect(normalized?.url).toBe('https://xn--r8jz45g.example.jp/%E8%B7%AF%E5%BE%84?q=%E6%90%9C%E7%B4%A2');
    expect(normalized?.url).toMatch(/^[!-~]+$/);
  });

  it("drops a host's trailing dot, keeps an underscore, and records no host the archive's Site format cannot carry", () => {
    expect(normalizeUrl('https://example.com./a')).toMatchObject({ url: 'https://example.com/a', host: 'example.com', site: 'example.com' });
    expect(normalizeUrl('https://Example.COM..:8443/a')?.url).toBe('https://example.com:8443/a');
    expect(normalizeUrl('https://my_team.example.com/wiki/a')).toMatchObject({ url: 'https://my_team.example.com/wiki/a', site: 'my_team.example.com' });
    for (const odd of ['http://a!b.example.com/', 'http://a~b.example.com/', 'http://./', 'http://-.example.com/']) expect(normalizeUrl(odd), odd).toBeNull();
  });

  it('names the host and the site (without a leading www.)', () => {
    expect(normalizeUrl('https://www.example.com/x')).toMatchObject({ host: 'www.example.com', site: 'example.com' });
    expect(normalizeUrl('https://gist.example.com/x')).toMatchObject({ host: 'gist.example.com', site: 'gist.example.com' });
    expect(normalizeUrl('http://[::1]:8000/x')).toMatchObject({ host: '[::1]', site: '[::1]' });
    expect(siteOf('www.')).toBe('www.');
  });

  it('gives a site-only page its root URL', () => {
    expect(rootUrl('https://mail.example.com/mail/u/0/#inbox/abc')).toBe('https://mail.example.com/');
    expect(rootUrl('http://example.com:8080/a?b')).toBe('http://example.com:8080/');
    expect(rootUrl('ftp://example.com/')).toBeNull();
  });
});

describe('the page ID', () => {
  it('is the first 16 bytes of the SHA-256 of the normalized URL (the contract fixtures)', async () => {
    expect(await pageIdOf('https://docs.example.com/guide/durable-objects')).toBe('3cb732b26093d5571ec48a363db593b2');
    expect(await pageIdOf('https://news.example.org/2026/10/sqlite-fts5-chinese')).toBe('f9735ed632fb5291d9bc44726777dbd8');
  });

  it('comes from the whole URL, not its cut', async () => {
    const long = `https://maps.example.com/?state=${'x'.repeat(10_000)}`;
    const cut = cutUrl(long);
    expect(cut).toEqual({ url: long.slice(0, URL_MAX_CHARS), truncated: true });
    expect(await pageIdOf(long)).not.toBe(await pageIdOf(cut.url));
    expect(cutUrl('https://example.com/')).toEqual({ url: 'https://example.com/', truncated: false });
  });
});

describe('length bounds', () => {
  it('cuts a title or description to 999 code points and an ellipsis', () => {
    expect(cutText('a'.repeat(TEXT_MAX_CHARS))).toBe('a'.repeat(TEXT_MAX_CHARS));
    const long = cutText('标'.repeat(1500));
    expect(Array.from(long)).toHaveLength(TEXT_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    // Astral characters count once each.
    const emoji = cutText('😀'.repeat(1200));
    expect(Array.from(emoji)).toHaveLength(TEXT_MAX_CHARS);
  });

  it('cuts UTF-8 at a character boundary', () => {
    expect(cutUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(cutUtf8('中文字', 7)).toEqual({ text: '中文', truncated: true });
    expect(cutUtf8('a😀b', 4)).toEqual({ text: 'a', truncated: true });
    const text = '数据库'.repeat(30_000);
    const cut = cutUtf8(text, 65_536);
    expect(new TextEncoder().encode(cut.text).byteLength).toBeLessThanOrEqual(65_536);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith('�')).toBe(false);
  });

  it('counts UTF-8 bytes like TextEncoder', () => {
    for (const text of ['', 'abc', '中文', 'a😀b', 'é', '\ud800x']) expect(utf8Bytes(text), text).toBe(new TextEncoder().encode(text).byteLength);
  });
});
