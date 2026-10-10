// shared/denylist.ts: the three levels, the strictest winning, host and path-prefix matching, hash routes and trailing
// dots, the sign-in segments and the owner's two lists.
import { describe, expect, it } from 'vitest';
import {
  builtinNoTextPatterns,
  denyLevel,
  denyLevelOfUrl,
  matches,
  NO_OWNER_PATTERNS,
  NO_TEXT_PATTERNS,
  parsePattern,
  patternText,
  RECALL_HOST,
  routePaths,
  SITE_ONLY_PATTERNS,
  type OwnerPatterns,
  type Pattern,
} from '../../shared/denylist.ts';

const compiled = (texts: readonly string[]): Pattern[] => texts.map((text) => parsePattern(text)).filter((p): p is Pattern => p !== null);
/** The owner's no-text patterns. */
const owner = (...texts: string[]): OwnerPatterns => ({ noText: compiled(texts), siteOnly: [] });
const none = NO_OWNER_PATTERNS;

describe('patterns', () => {
  it('reads a host or a host and a path prefix, lower case, without a scheme, query or fragment', () => {
    expect(parsePattern('example.com')).toEqual({ host: 'example.com', path: '' });
    expect(parsePattern('example.com/account/')).toEqual({ host: 'example.com', path: '/account' });
    expect(parsePattern('sub.example.co.uk/a/b')).toEqual({ host: 'sub.example.co.uk', path: '/a/b' });
    for (const bad of ['', 'https://example.com', 'Example.com', 'example.com?x=1', 'example.com/#a', 'exa mple.com', '-example.com', 'example.com/a b', 'x'.repeat(201)]) {
      expect(parsePattern(bad), bad).toBeNull();
    }
    expect(patternText({ host: 'example.com', path: '/a' })).toBe('example.com/a');
  });

  it('matches a host and its subdomains, and a path prefix at a segment boundary ignoring case', () => {
    const pattern = { host: 'example.com', path: '/account' };
    expect(matches(pattern, 'example.com', '/account')).toBe(true);
    expect(matches(pattern, 'www.example.com', '/account/settings')).toBe(true);
    expect(matches(pattern, 'example.com', '/Account/Settings')).toBe(true);
    expect(matches(pattern, 'example.com', '/accounts')).toBe(false);
    expect(matches(pattern, 'notexample.com', '/account')).toBe(false);
    expect(matches({ host: 'example.com', path: '' }, 'a.b.example.com', '/x')).toBe(true);
  });

  it('every built-in pattern parses', () => {
    for (const text of [...SITE_ONLY_PATTERNS, ...NO_TEXT_PATTERNS]) expect(parsePattern(text), text).not.toBeNull();
    expect(builtinNoTextPatterns()).toContain('*/login');
  });
});

describe('levels', () => {
  it('never records recall itself, its configured host included', () => {
    expect(denyLevel(RECALL_HOST, '/search', none)).toBe('never');
    expect(denyLevel('recall.example.com', '/', none, ['recall.example.com'])).toBe('never');
    expect(denyLevel('recall.example.com', '/', none)).toBe('record');
  });

  it('records mail, chats, consoles, accounts and banks by their site alone', () => {
    expect(denyLevel('mail.google.com', '/mail/u/0/', none)).toBe('site_only');
    expect(denyLevel('www.facebook.com', '/messages/t/123', none)).toBe('site_only');
    expect(denyLevel('www.facebook.com', '/groups/x', none)).toBe('record');
    expect(denyLevel('github.com', '/settings/tokens', none)).toBe('site_only');
    expect(denyLevel('github.com', '/Settings/tokens', none)).toBe('site_only');
    expect(denyLevel('github.com', '/ziyixi', none)).toBe('record');
    expect(denyLevel('secure.chase.com', '/web/auth', none)).toBe('site_only');
    expect(denyLevel('claude.ai', '/chat/abc', none)).toBe('site_only');
    expect(denyLevel('messages.google.com', '/web/conversations/12', none)).toBe('site_only');
    expect(denyLevel('voice.google.com', '/u/0/messages', none)).toBe('site_only');
  });

  it('records the consoles where API keys are made by their site alone', () => {
    for (const [host, path] of [
      ['console.anthropic.com', '/settings/keys'],
      ['platform.openai.com', '/api-keys'],
      ['aistudio.google.com', '/apikey'],
      ['www.npmjs.com', '/settings/someone/tokens'],
      ['pypi.org', '/manage/account/token/'],
      ['huggingface.co', '/settings/tokens'],
      ['gitlab.com', '/-/user_settings/personal_access_tokens'],
    ] as const) {
      expect(denyLevel(host, path, none), `${host}${path}`).toBe('site_only');
    }
    expect(denyLevel('www.npmjs.com', '/package/vitest', none)).toBe('record');
    expect(denyLevel('huggingface.co', '/docs/hub', none)).toBe('record');
  });

  it('ignores a trailing dot of the host', () => {
    expect(denyLevel('mail.google.com.', '/mail/u/0/', none)).toBe('site_only');
    expect(denyLevelOfUrl('https://mail.google.com./mail/u/0/', none)).toBe('site_only');
    expect(denyLevel('recall.ziyixi.science.', '/', none)).toBe('never');
  });

  it("judges a hash router's route as a path too", () => {
    expect(routePaths('/', '#/accounts/123?tab=2')).toEqual(['/', '/accounts/123']);
    expect(routePaths('/app', '#!settings')).toEqual(['/app', '/settings']);
    expect(routePaths('/a', '#section')).toEqual(['/a']);
    expect(denyLevel('portal.bank.example', routePaths('/', '#/accounts/123'), owner('portal.bank.example/accounts'))).toBe('no_text');
    expect(denyLevel('app.example.com', routePaths('/', '#/login'), none)).toBe('no_text');
    expect(denyLevelOfUrl('https://www.facebook.com/#!/messages/t/1', none)).toBe('site_only');
    expect(denyLevelOfUrl('https://app.example.com/#/reports', none)).toBe('record');
  });

  it("records the owner's other apps, sign-in paths and the owner's patterns without text", () => {
    expect(denyLevel('sort.ziyixi.science', '/', none)).toBe('no_text');
    expect(denyLevel('shop.example.com', '/account/LOGIN', none)).toBe('no_text');
    expect(denyLevel('example.com', '/oauth2/authorize', none)).toBe('no_text');
    expect(denyLevel('example.com', '/blog/logins-explained', none)).toBe('record');
    expect(denyLevel('bank.example.net', '/statements', owner('example.net'))).toBe('no_text');
    expect(denyLevel('example.org', '/private/notes', owner('example.org/private'))).toBe('no_text');
    expect(denyLevel('example.org', '/public', owner('example.org/private'))).toBe('record');
  });

  it("records the owner's site-only patterns by their site alone, the strictest of the owner's two lists winning", () => {
    const both: OwnerPatterns = { siteOnly: compiled(['bank.example.net', 'example.org/vault']), noText: compiled(['example.net']) };
    expect(denyLevel('www.bank.example.net', '/accounts/1', both)).toBe('site_only');
    expect(denyLevel('shop.example.net', '/cart', both)).toBe('no_text');
    expect(denyLevel('example.org', '/vault/item', both)).toBe('site_only');
    expect(denyLevel('example.org', '/blog', both)).toBe('record');
  });

  it('the strictest level wins', () => {
    // A site-only host on the owner's list stays site-only; recall's own host is never recorded even under ziyixi.science.
    expect(denyLevel('mail.google.com', '/', owner('google.com'))).toBe('site_only');
    expect(denyLevel('recall.ziyixi.science', '/login', none)).toBe('never');
    expect(denyLevel('accounts.google.com', '/signin', none)).toBe('site_only');
  });

  it('reads a URL string, and a URL that does not parse is never recorded', () => {
    expect(denyLevelOfUrl('https://mail.google.com/mail/', none)).toBe('site_only');
    expect(denyLevelOfUrl('not a url', none)).toBe('never');
  });
});
