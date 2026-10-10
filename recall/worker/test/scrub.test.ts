// shared/scrub.ts: every token pattern, every secret parameter, the path-segment rule over a corpus of synthetic URLs
// shaped like real ones, long hostile inputs in linear time, well-formed and idempotent output. Every synthetic token is
// assembled at run time, so no file of this public repository holds a string a secret scanner would take for a key.
import { describe, expect, it } from 'vitest';
import { googleDocumentIdIndex, isSecretParameter, isTokenSegment, luhn, REDACTED, scrubText, scrubUrl, SECRET_PARAMETERS } from '../../shared/scrub.ts';

/** A synthetic token: a prefix and `length` characters cycling through upper case, lower case and digits. */
function token(prefix: string, length: number, alphabet = 'AbCdEfGhJkMnPqRsTuVwXyZ0123456789'): string {
  let out = prefix;
  for (let i = 0; i < length; i++) out += alphabet[i % alphabet.length] ?? '';
  return out;
}

const join = (...parts: string[]) => parts.join('');

const TOKENS: Readonly<Record<string, string>> = {
  aws: token(join('AK', 'IA'), 16, 'ABCDEFGHJKLMNPQRSTUVWXYZ234567'),
  githubPersonal: token(join('gh', 'p_'), 36),
  githubOauth: token(join('gh', 'o_'), 36),
  githubFineGrained: token(join('github', '_pat_'), 82),
  cloudflare: token(join('cf', 'ut_'), 40),
  cloudflareAccess: token(join('cf', 'ast_'), 40),
  recallIngest: token(join('recall', '_ingest_'), 43),
  recallExport: token(join('recall', '_export_'), 43),
  slack: token(join('xo', 'xb-'), 40, 'abcdef0123456789-'),
  slackApp: token(join('xa', 'pp-1-'), 30),
  google: token(join('AI', 'za'), 35),
  stripe: token(join('sk', '_live_'), 24),
  stripeRestricted: token(join('rk', '_live_'), 24),
  jwt: join('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJzeW50aGV0aWMifQ', '.', 'c3ludGhldGljLXNpZ25hdHVyZQ'),
  anthropic: `${token(join('sk-', 'ant-api03-'), 93, 'AbCd-Ef_0123456789')}AA`,
  anthropicAdmin: token(join('sk-', 'ant-admin01-'), 60),
  openaiProject: token(join('sk-', 'proj-'), 120, 'AbCd-Ef_0123456789'),
  openaiLegacy: join(token('sk-', 20), 'T3Blbk', 'FJ', token('', 20)),
  openrouter: token(join('sk-', 'or-v1-'), 64, '0123456789abcdef'),
  groq: token(join('gs', 'k_'), 52),
  xai: token(join('xa', 'i-'), 80),
  npm: token(join('np', 'm_'), 36),
  gitlab: token(join('gl', 'pat-'), 20, 'AbCd-Ef_0123456789'),
  huggingFace: token(join('h', 'f_'), 34, 'AbCdEfGhJkMnPqRsTuVwXyZ'),
  pypi: token(join('pypi-', 'AgEIcHlwaS5vcmc'), 70),
  googleOauth: token(join('ya', '29.'), 60),
};

describe('token patterns', () => {
  for (const [name, value] of Object.entries(TOKENS)) {
    it(`redacts ${name}, alone, in prose and in a URL`, () => {
      expect(scrubText(value)).toBe(REDACTED);
      expect(scrubText(`key: (${value}) here`)).toBe(`key: (${REDACTED}) here`);
      expect(scrubText(`docs ${value}.`)).not.toContain(value);
      expect(scrubUrl(`https://example.com/p/${value}`)).toBe(`https://example.com/p/${REDACTED}`);
    });
  }

  it('leaves a token-like run inside a longer word alone, and words that only resemble a prefix', () => {
    expect(scrubText(`x${TOKENS['aws'] ?? ''}`)).toBe(`x${TOKENS['aws'] ?? ''}`);
    for (const plain of ['ghost_town', 'recall_export_', 'skeleton_live', 'AIzaShort', 'eyJustAWord']) expect(scrubText(plain)).toBe(plain);
  });

  it('redacts a PEM private key block, and a block whose END line was cut off', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7synthetic==\n';
    const begin = join('-----BEGIN ', 'RSA PRIVATE KEY-----');
    const end = join('-----END ', 'RSA PRIVATE KEY-----');
    expect(scrubText(`before\n${begin}\n${body}${end}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(scrubText(`${join('-----BEGIN ', 'PRIVATE KEY-----')}\n${body}${join('-----END ', 'PRIVATE KEY-----')}`)).toBe(REDACTED);
    expect(scrubText(`${join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')}\n${body}`)).toBe(REDACTED);
    // A public key or a certificate is not a secret.
    const certificate = `${join('-----BEGIN ', 'CERTIFICATE-----')}\n${body}${join('-----END ', 'CERTIFICATE-----')}`;
    expect(scrubText(certificate)).toBe(certificate);
  });

  it('redacts URL user-info in text and the values of secret assignments', () => {
    expect(scrubText('see https://alice:hunter22@example.com/x')).toBe(`see https://${REDACTED}@example.com/x`);
    expect(scrubText('password: Synthetic-Pa55word')).toBe(`password: ${REDACTED}`);
    expect(scrubText('DB_PASSWORD=Synthetic-Pa55word')).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(scrubText('{"api_key": "abc 123 def"}')).toBe(`{"api_key": ${REDACTED}}`);
    expect(scrubText("client_secret='s3cr3t-value'")).toBe(`client_secret=${REDACTED}`);
    expect(scrubText('API-KEY = synthetickeyvalue')).toBe(`API-KEY = ${REDACTED}`);
    // Prose that only mentions a secret keeps its words: a short value is not taken.
    expect(scrubText('The password: is required.')).toBe('The password: is required.');
    expect(scrubText('secret: the')).toBe('secret: the');
  });

  it('makes every string well-formed and is idempotent', () => {
    expect(scrubText('a\ud800b\udc00c')).toBe('a�b�c');
    const all = Object.values(TOKENS).join(' and ');
    const once = scrubText(`${all} password=Synthetic-Pa55word`);
    expect(scrubText(once)).toBe(once);
    expect(once).not.toMatch(/AKIA|gh[pousr]_|github_pat|cf(?:k|ut|at|ast)_|recall_(?:ingest|export)_|xox|xapp|AIza|_live_|eyJ|sk-|npm_|glpat|hf_|pypi-|ya29/);
  });
});

describe('card and social security numbers', () => {
  // Synthetic numbers that pass the Luhn check (the networks' published test numbers).
  const visa = join('4111', '1111', '1111', '1111');
  const amex = join('3782', '822463', '10005');

  it('redacts a Luhn-valid card number written as a card is, alone or grouped', () => {
    expect(luhn(visa)).toBe(true);
    expect(scrubText(`card ${visa} ok`)).toBe(`card ${REDACTED} ok`);
    expect(scrubText(`card ${visa.replace(/(\d{4})(?=\d)/g, '$1 ')}.`)).toBe(`card ${REDACTED}.`);
    expect(scrubText(`card ${visa.replace(/(\d{4})(?=\d)/g, '$1-')}`)).toBe(`card ${REDACTED}`);
    expect(scrubText(`amex ${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`)).toBe(`amex ${REDACTED}`);
  });

  it('keeps numbers that only look like one: a failed Luhn check, a date pair, an ID starting with 1, other groupings', () => {
    for (const plain of [
      join('4111', '1111', '1111', '1112'),
      '2026-10-10 2026-10-11',
      '1845678901234567890',
      '1760000000000',
      `x.com/u/status/${join('184567', '8901234567890')}`,
      join('41 ', '1111 ', '1111 ', '1111 ', '11'),
      '415-555-2671',
    ]) {
      expect(scrubText(plain), plain).toBe(plain);
    }
  });

  it('redacts a dashed social security number, never the numbers that are not issued', () => {
    expect(scrubText(`ssn ${join('123-', '45-', '6789')} on file`)).toBe(`ssn ${REDACTED} on file`);
    for (const plain of [join('000-', '12-', '3456'), join('666-', '12-', '3456'), join('900-', '12-', '3456'), join('123-', '00-', '4567'), join('123-', '45-', '0000'), '2026-10-10']) {
      expect(scrubText(plain), plain).toBe(plain);
    }
  });
});

describe('secret query parameters', () => {
  it('replaces the value of every listed parameter, ignoring case, raw and in order', () => {
    for (const name of SECRET_PARAMETERS) {
      expect(scrubUrl(`https://example.com/cb?a=1&${name}=synthetic&b=2`), name).toBe(`https://example.com/cb?a=1&${name}=${REDACTED}&b=2`);
      expect(isSecretParameter(name.toUpperCase())).toBe(true);
    }
    expect(scrubUrl('https://bucket.example.com/f.pdf?X-Amz-Signature=abc&X-Amz-Credential=def&x-goog-signature=ghi&v=1')).toBe(
      `https://bucket.example.com/f.pdf?X-Amz-Signature=${REDACTED}&X-Amz-Credential=${REDACTED}&x-goog-signature=${REDACTED}&v=1`,
    );
    expect(scrubUrl('https://example.com/?%74oken=abc')).toBe(`https://example.com/?%74oken=${REDACTED}`);
    expect(scrubUrl('https://example.com/?q=%E4%B8%AD&page=2')).toBe('https://example.com/?q=%E4%B8%AD&page=2');
    expect(scrubUrl('https://example.com/?token')).toBe('https://example.com/?token');
  });

  it('compares names without case, `-` and `_`, and takes every name that ends like a secret', () => {
    for (const name of ['reset_password_token', 'confirmation_token', 'accessToken', 'refreshToken', 'csrf-token', 'Client_Secret', 'X-Goog-Signature', 'db_password', 'AWSAccessKey', 'oobCode', 'ticket', 'SAMLResponse']) {
      expect(scrubUrl(`https://example.com/cb?${name}=synthetic-value&page=2`), name).toBe(`https://example.com/cb?${name}=${REDACTED}&page=2`);
    }
    for (const name of ['q', 'page', 'monkey', 'tokenizer', 'sort', 'v']) expect(isSecretParameter(name), name).toBe(false);
  });

  it('redacts the token of a short name such as `?t=` and keeps its ordinary values', () => {
    expect(scrubUrl(`https://example.com/login/magic?t=${token('', 32)}`)).toBe(`https://example.com/login/magic?t=${REDACTED}`);
    expect(scrubUrl(`https://example.com/a?k=${token('', 24, 'abcdef0123456789')}`)).toBe(`https://example.com/a?k=${REDACTED}`);
    expect(scrubUrl('https://video.example.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('https://video.example.com/watch?v=dQw4w9WgXcQ&t=42s');
  });

  it('scrubs a hash router query and route', () => {
    expect(scrubUrl(`https://app.example.com/#/reset/${token('', 24)}?token=abc&tab=2`)).toBe(`https://app.example.com/#/reset/${REDACTED}?token=${REDACTED}&tab=2`);
  });
});

describe('path segments', () => {
  /** URLs shaped like real ones and what the scrubber leaves of them. */
  const corpus: readonly (readonly [string, string])[] = [
    ['https://en.example.org/wiki/2024_United_States_presidential_election', 'kept'],
    ['https://news.example.com/2026/10/09/world/europe/some-long-headline-about-things.html', 'kept'],
    ['https://notes.example.com/Meeting-notes-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', 'kept'],
    ['https://notes.example.com/Project-Plan-2026-0a1b2c3d4e5f60718293a4b5c6d7e8f9', 'kept'],
    ['https://code.example.com/owner/repo/commit/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', 'kept'],
    ['https://code.example.com/owner/repo/blob/main/src/components/SearchResultsPanel.tsx', 'kept'],
    ['https://api.example.com/v1/items/0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f', 'kept'],
    ['https://video.example.com/watch/dQw4w9WgXcQ', 'kept'],
    ['https://shop.example.com/products/OrganicCottonTShirt2026', 'redacted'],
    [`https://example.com/reset-password/${token('', 32)}`, 'redacted'],
    [`https://example.com/magic/${token('', 20, 'aB3dE5fG7hJ9kL1mN3pQ5r')}`, 'redacted'],
    [`https://example.com/share/${token('', 22, 'ab-CD_ef12GH34')}`, 'redacted'],
    [`https://example.com/invite/abc-${token('', 24)}-x`, 'redacted'],
    // After a reset, verify, confirm, activate, invite, magic, token or unsubscribe segment: every long segment.
    [`https://example.com/reset/MQ/c4t9ab-${token('', 32, '0123456789abcdef')}/`, 'redacted'],
    [`https://example.com/verify/${token('', 64, '0123456789abcdef')}`, 'redacted'],
    [`https://example.com/email/verify/12/${token('', 40, '0123456789abcdef')}`, 'redacted'],
    [`https://example.com/users/confirmation/${token('', 20, 'abcdefghijklmnopqrstuvwxyz')}`, 'redacted'],
    [`https://example.com/unsubscribe/${token('', 18, 'abcdefghijklmnopqrstuvwxyz0123456789')}`, 'redacted'],
    // A token whose parts mix cases inside them is not a slug.
    ['https://example.com/login/abcDEF-123456-XyZabc', 'redacted'],
    ['https://docs.example.com/verify/short', 'kept'],
    ['https://docs.example.com/guides/verify-your-domain-in-five-steps', 'kept'],
  ];

  for (const [url, expected] of corpus) {
    it(`${expected}: ${url.slice(0, 70)}`, () => {
      const scrubbed = scrubUrl(url);
      if (expected === 'kept') expect(scrubbed).toBe(url);
      else {
        expect(scrubbed).toContain(REDACTED);
        expect(scrubbed.split('/').slice(0, 3)).toEqual(url.split('/').slice(0, 3));
      }
    });
  }

  it('keeps the document IDs of Google Docs and Drive links (the owner chose that links still open)', () => {
    const id = token('1', 43);
    for (const url of [
      `https://docs.google.com/document/d/${id}/edit`,
      `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      `https://docs.google.com/presentation/u/1/d/${id}/view`,
      `https://docs.google.com/forms/d/e/${id}/viewform`,
      `https://drive.google.com/file/d/${id}/view`,
      `https://drive.google.com/drive/folders/${id}`,
      `https://drive.google.com/drive/u/0/folders/${id}`,
    ]) {
      expect(scrubUrl(url), url).toBe(url.replace('#gid=0', '#gid=0'));
    }
    // Only there: the same ID elsewhere, or in another position, is redacted.
    expect(scrubUrl(`https://docs.example.com/document/d/${id}/edit`)).toContain(REDACTED);
    expect(scrubUrl(`https://docs.google.com/document/d/${id}/${id}`)).toBe(`https://docs.google.com/document/d/${id}/${REDACTED}`);
    expect(googleDocumentIdIndex('docs.google.com', ['', 'document', 'u'])).toBe(-1);
  });

  it('classifies segments by their shape', () => {
    expect(isTokenSegment('aB3dE5fG7hJ9kL1mN3p')).toBe(false);
    expect(isTokenSegment('aB3dE5fG7hJ9kL1mN3pQ')).toBe(true);
    expect(isTokenSegment(token('', 30))).toBe(true);
    expect(isTokenSegment('abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(isTokenSegment('ABCDEF0123456789ABCDEF0123')).toBe(false);
    expect(isTokenSegment('DeadBeef0123DeadBeef0123')).toBe(false);
    expect(isTokenSegment('2024_United_States_presidential_election')).toBe(false);
    expect(isTokenSegment('Project-Plan-NASA-2026')).toBe(false);
    expect(isTokenSegment('abcDEF-123456-XyZabc')).toBe(true);
  });

  it('keeps the parts before an unlocking segment, and its short segments', () => {
    const reset = `https://example.com/account/reset/MQ/${token('', 32, '0123456789abcdef')}/`;
    expect(scrubUrl(reset)).toBe(`https://example.com/account/reset/MQ/${REDACTED}/`);
  });
});

describe('hostile inputs run in linear time', () => {
  const cases: Readonly<Record<string, string>> = {
    letters: 'a'.repeat(200_000),
    prefixes: join('ey', 'J').repeat(60_000),
    awsPrefixes: join('AK', 'IA').repeat(50_000),
    githubPrefixes: join('gh', 'p_').repeat(50_000),
    slashes: '//'.repeat(80_000),
    userInfo: `//${'a'.repeat(250)}:`.repeat(600),
    assignments: 'password='.repeat(20_000),
    pemBegins: join('-----BEGIN ', 'PRIVATE KEY-----').repeat(8000),
    dots: `${join('ey', 'Jabcdef')}.`.repeat(20_000),
    digits: '4'.repeat(200_000),
    spacedDigits: '4 '.repeat(100_000),
    dashedDigits: '123-45-'.repeat(30_000),
    keyPrefixes: join('sk-', 'ant-').repeat(40_000),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      const started = performance.now();
      scrubText(input);
      scrubUrl(`https://example.com/${input.slice(0, 50_000)}?q=${input.slice(0, 50_000)}`);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  }
});
