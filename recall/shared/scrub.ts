/**
 * The scrubber (../docs/design.md §3.6): secrets out of every URL, title, description and text, in the extension
 * before a string enters the outbox and again in the Worker on arrival (so an older build cannot let one through).
 * Each secret becomes `[redacted]`.
 *
 * - Patterns of known token shapes (adapted from gitleaks and atuin, both MIT: NOTICE), card numbers (Luhn-checked, in
 *   a card's grouping) and US social security numbers, URL user-info and `password: …`-style assignments. Every
 *   pattern starts only where a token can start (a lookbehind for the token's own alphabet) and has no nested
 *   quantifier, so a match attempt scans at most the token it starts and a whole string is scrubbed in linear time;
 *   PEM private key blocks are found with indexOf, not a regular expression.
 * - In a URL, the values of secret query parameters (by name, in the query and in a hash router's query), and path
 *   segments that unlock something: every segment of 16 or more characters after a reset, verify, confirm, activate,
 *   invite, magic, token or unsubscribe segment, and anywhere segments shaped like capability tokens (20 or more
 *   characters of the base64url alphabet mixing upper case, lower case and digits), unless such a segment is a slug, a
 *   hex ID or the document ID of a Google Docs or Drive link (kept, so the link still opens from recall: the owner's
 *   choice, §12).
 * - Every string is made well-formed (a lone surrogate becomes U+FFFD), so every JSON reader and writer agrees on it.
 *
 * Scrubbing is idempotent: `[redacted]` matches no rule.
 */

export const REDACTED = '[redacted]';

/** A token shape: where a token may start (the lookbehind) and its form. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // AWS access key IDs.
  /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  // GitHub tokens: personal, OAuth, user-to-server, server-to-server, refresh; fine-grained PATs.
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g,
  // Cloudflare API tokens and keys with their prefixes.
  /(?<![A-Za-z0-9_])(?:cfk|cfut|cfat|cfast)_[A-Za-z0-9_-]{16,}/g,
  // recall's own machine tokens.
  /(?<![A-Za-z0-9_])recall_(?:ingest|export)_[A-Za-z0-9_-]{16,}/g,
  // Slack tokens and app-level tokens.
  /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9-])xapp-[0-9]+-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g,
  // Stripe live secret and restricted keys.
  /(?<![A-Za-z0-9_])(?:sk|rk)_live_[0-9A-Za-z]{16,}/g,
  // Anthropic API, admin and OAuth keys.
  /(?<![A-Za-z0-9_-])sk-ant-[a-z]{2,8}[0-9]{2}-[A-Za-z0-9_-]{20,}/g,
  // OpenAI project, service account and admin keys, and the older keys with their T3BlbkFJ marker.
  /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  // OpenRouter, Groq and xAI keys.
  /(?<![A-Za-z0-9_-])sk-or-v1-[0-9a-f]{64}/g,
  /(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{40,}/g,
  /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{40,}/g,
  // npm, GitLab, Hugging Face and PyPI tokens.
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/g,
  /(?<![A-Za-z0-9_-])gl(?:pat|oas|dt|rt|ptt|soat|cbt|imt|ft|agent)-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_-])pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g,
  // Google OAuth access tokens.
  /(?<![A-Za-z0-9_.-])ya29\.[0-9A-Za-z_-]{20,}/g,
  // JSON Web Tokens: three base64url parts, the first two JSON objects.
  /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
];

/**
 * A card number candidate: 13 to 19 digits starting with 2 to 6 (the networks' prefixes: no ID that starts with 1,
 * such as a millisecond time or a post's snowflake), with single spaces or dashes allowed between digits. A candidate
 * is redacted when its digits pass the Luhn check and its groups are a card's (cardShaped).
 */
const CARD_CANDIDATE = /(?<![0-9])[2-6][0-9](?:[ -]?[0-9]){11,17}(?![0-9])/g;
/** A US social security number in its dashed form, without the numbers that are never issued. */
const SSN = /(?<![0-9-])(?!000|666|9[0-9]{2})[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}(?![0-9-])/g;

/** Whether a string of digits passes the Luhn check. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Whether a card number candidate is grouped as a card is written: no separators, 4-4-4-4(-1..3), 4-6-5 or 4-6-4. */
function cardShaped(candidate: string): boolean {
  const groups = candidate.split(/[ -]/).map((group) => group.length);
  if (groups.length === 1) return true;
  const shape = groups.join('-');
  if (shape === '4-6-5' || shape === '4-6-4') return true;
  const last = groups[groups.length - 1] ?? 0;
  return groups.length >= 4 && groups.slice(0, -1).every((length) => length === 4) && last >= 1 && last <= 4;
}

/** A card number's candidate redacted when it is one (Luhn and a card's grouping), else kept. */
function scrubCard(candidate: string): string {
  const digits = candidate.replace(/[ -]/g, '');
  return digits.length >= 13 && digits.length <= 19 && cardShaped(candidate) && luhn(digits) ? REDACTED : candidate;
}

/** URL user-info in text: `//user:password@` keeps its slashes and at sign. */
const USER_INFO = /(?<=\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}(?=@)/g;

/**
 * An assignment of a secret: the key, an optional quote, `:` or `=`, then the value (quoted, or 6-200 characters
 * without spaces and separators). The key and the separator stay; the value becomes [redacted].
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9])((?:password|passwd|passphrase|pwd|secret|client_secret|api_key|api-key|apikey|access_token|auth_token|refresh_token|private_key)["']?[ \t]{0,4}[:=][ \t]{0,4})(?:"[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|[^\s"'<>,;&]{6,200})/gi;

const PEM_BEGIN = '-----BEGIN ';
const PEM_PRIVATE = /^-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----/;
const PEM_END = '-----END ';
/** The characters of a key block's body after its header, when the END line is missing (a cut text). */
const PEM_BODY = /[A-Za-z0-9+/=\s:-]/;

/** PEM private key blocks, BEGIN through END (or through the body when END is missing), each as one [redacted]. */
function scrubPem(text: string): string {
  if (!text.includes(PEM_BEGIN)) return text;
  let out = '';
  let at = 0;
  // Where the next END line starts at or after a position; -1 once there is none (then never again).
  let end = text.indexOf(PEM_END);
  for (let begin = text.indexOf(PEM_BEGIN); begin !== -1; begin = text.indexOf(PEM_BEGIN, at)) {
    const header = PEM_PRIVATE.exec(text.slice(begin, begin + 80));
    if (header === null) {
      out += text.slice(at, begin + PEM_BEGIN.length);
      at = begin + PEM_BEGIN.length;
      continue;
    }
    const bodyStart = begin + header[0].length;
    if (end !== -1 && end < bodyStart) end = text.indexOf(PEM_END, bodyStart);
    let stop: number;
    if (end !== -1) {
      const close = text.indexOf('-----', end + PEM_END.length);
      stop = close === -1 ? text.length : close + 5;
    } else {
      stop = bodyStart;
      while (stop < text.length && PEM_BODY.test(text[stop] ?? '')) stop += 1;
    }
    out += text.slice(at, begin) + REDACTED;
    at = stop;
  }
  return out + text.slice(at);
}

/** Secrets out of a title, description or text (and the pattern pass of a URL); the result is well-formed. */
export function scrubText(text: string): string {
  let out = scrubPem(text.toWellFormed());
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(CARD_CANDIDATE, scrubCard).replace(SSN, REDACTED);
  out = out.replace(USER_INFO, REDACTED);
  return out.replace(ASSIGNMENT, (_match, key: string) => `${key}${REDACTED}`);
}

// ---- URLs -------------------------------------------------------------------------------------------------------

/**
 * Query parameters whose values are secrets, by name. Names are compared normalized: lower case, without `-` and `_`
 * (`reset_password_token`, `accessToken` and `X-Amz-Signature` read `resetpasswordtoken`, `accesstoken` and
 * `xamzsignature`).
 */
export const SECRET_PARAMETERS: ReadonlySet<string> = new Set([
  'token',
  'code',
  'state',
  'sig',
  'key',
  'pwd',
  'auth',
  'session',
  'sessionid',
  'sid',
  'otp',
  'ticket',
  'oobcode',
  'jwt',
  'assertion',
  'samlrequest',
  'samlresponse',
  'credential',
  'credentials',
  'authorization',
]);
/** A name that ends in one of these is a secret's (`access_token`, `client_secret`, `x-goog-signature`, `api_key`). */
const SECRET_ENDINGS = ['token', 'secret', 'signature', 'password', 'passwd', 'apikey', 'accesskey'];
/** The prefixes of signed URLs' parameters. */
const SECRET_PREFIXES = ['xamz', 'xgoog'];
/** Short names that hold a token on some sites (`?t=` magic links) and something else on others (`?t=42s`). */
const SHORT_NAMES: ReadonlySet<string> = new Set(['t', 'k']);
/** A value shaped like a token: 16 or more characters of the base64url alphabet (with `.` and `%`). */
const TOKEN_VALUE = /^[A-Za-z0-9_.%-]{16,}$/;

/** A parameter's name as SECRET_PARAMETERS compares it: lower case, without `-` and `_`. */
function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

export function isSecretParameter(name: string): boolean {
  const normalized = normalizedName(name);
  return SECRET_PARAMETERS.has(normalized) || SECRET_ENDINGS.some((ending) => normalized.endsWith(ending)) || SECRET_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Whether a parameter's value is a secret: by its name, or a token-shaped value of a short name such as `t`. */
function secretValue(name: string, value: string): boolean {
  return isSecretParameter(name) || (SHORT_NAMES.has(normalizedName(name)) && TOKEN_VALUE.test(value));
}

/** A query string without its `?` with every secret parameter's value replaced; the rest stays byte for byte. */
function scrubQuery(query: string): string {
  return query
    .split('&')
    .map((part) => {
      const equals = part.indexOf('=');
      if (equals === -1) return part;
      const raw = part.slice(0, equals);
      let name: string;
      try {
        name = decodeURIComponent(raw.replaceAll('+', ' '));
      } catch {
        name = raw;
      }
      return secretValue(name, part.slice(equals + 1)) ? `${raw}=${REDACTED}` : part;
    })
    .join('&');
}

/** The base64url alphabet, 20 or more characters: a candidate capability token. */
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
/**
 * A part of a slug: a word (lower case, capitalized or all upper case: `presidential`, `United`, `NASA`), a number, or
 * long hex. A part that mixes cases inside it (`abcDEF`, `XyZabc`) is a token's.
 */
const SLUG_PART = /^(?:[a-z]+|[A-Z][a-z]*|[A-Z]+|[0-9]+|[0-9a-f]{8,})$/;
const HEX_ID = /^[0-9A-Fa-f-]+$/;
/** Segments after which the path carries what a link unlocks (reset, verification and invitation links). */
const UNLOCKING_SEGMENTS: ReadonlySet<string> = new Set([
  'reset',
  'reset-password',
  'password-reset',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activate',
  'activation',
  'invite',
  'invites',
  'invitation',
  'invitations',
  'magic',
  'magic-link',
  'token',
  'tokens',
  'unsubscribe',
]);
/** After an unlocking segment, a segment this long is redacted whatever its characters (hex and lower case included). */
const UNLOCKED_MIN_CHARS = 16;

/** A segment that names a thing rather than unlocking it: three or more parts of words, digits or long hex. */
function isSlug(segment: string): boolean {
  const parts = segment.split(/[-_.]/);
  return parts.length >= 3 && parts.every((part) => SLUG_PART.test(part));
}

/** Whether a path segment is shaped like a capability token (and is neither a slug nor a hex ID). */
export function isTokenSegment(segment: string): boolean {
  if (!TOKEN_SEGMENT.test(segment)) return false;
  if (!/[A-Z]/.test(segment) || !/[a-z]/.test(segment) || !/[0-9]/.test(segment)) return false;
  return !isSlug(segment) && !HEX_ID.test(segment);
}

/**
 * The index of the path segment that holds a Google Docs or Drive document ID, kept so that the link still opens
 * (`docs.google.com/document/d/<id>/edit`, `/forms/d/e/<id>/viewform`, `drive.google.com/file/d/<id>`,
 * `drive.google.com/drive/folders/<id>`, with or without a `u/<n>` account segment), or -1.
 */
export function googleDocumentIdIndex(host: string, segments: readonly string[]): number {
  // segments[0] is '' (the path starts with `/`).
  let i = 1;
  const at = (index: number): string => segments[index] ?? '';
  if (host === 'docs.google.com') {
    if (!['document', 'spreadsheets', 'presentation', 'forms'].includes(at(i))) return -1;
    i += 1;
    if (at(i) === 'u' && /^[0-9]+$/.test(at(i + 1))) i += 2;
    if (at(i) !== 'd') return -1;
    i += 1;
    if (at(i) === 'e') i += 1;
    return at(i) === '' ? -1 : i;
  }
  if (host === 'drive.google.com') {
    const first = at(i);
    i += 1;
    if (at(i) === 'u' && /^[0-9]+$/.test(at(i + 1))) i += 2;
    if (first === 'file' && at(i) === 'd') return at(i + 1) === '' ? -1 : i + 1;
    if (first === 'drive' && at(i) === 'folders') return at(i + 1) === '' ? -1 : i + 1;
  }
  return -1;
}

/**
 * A path (`/a/b`) with every token-shaped segment replaced, and every long segment after an unlocking one, but a
 * Google document ID on its host.
 */
function scrubPath(host: string, path: string): string {
  const segments = path.split('/');
  const keep = googleDocumentIdIndex(host, segments);
  const unlocking = segments.findIndex((segment) => UNLOCKING_SEGMENTS.has(segment.toLowerCase()));
  return segments
    .map((segment, index) => {
      if (index === keep) return segment;
      const unlocked = unlocking !== -1 && index > unlocking && segment.length >= UNLOCKED_MIN_CHARS;
      return unlocked || isTokenSegment(segment) ? REDACTED : segment;
    })
    .join('/');
}

/**
 * Secrets out of a normalized URL (normalizeUrl's output: ASCII, no user-info): secret query values, in the query
 * and in a hash router's fragment; token-shaped path segments, in the path and in the fragment's route; then the
 * patterns of scrubText. The URL is never parsed and serialized again, which would escape `[redacted]`.
 */
export function scrubUrl(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return scrubText(url);
  const authorityStart = schemeEnd + 3;
  const pathStart = url.slice(authorityStart).search(/[/?#]/);
  const authority = pathStart === -1 ? url.slice(authorityStart) : url.slice(authorityStart, authorityStart + pathStart);
  const rest = pathStart === -1 ? '' : url.slice(authorityStart + pathStart);
  const host = authority.replace(/^.*@/, '').replace(/:[0-9]*$/, '').toLowerCase();

  const hashAt = rest.indexOf('#');
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : rest.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : `?${scrubQuery(beforeHash.slice(queryAt + 1))}`;

  let fragment = hash;
  if (hash.startsWith('#/') || hash.startsWith('#!')) {
    const routeQueryAt = hash.indexOf('?');
    const route = routeQueryAt === -1 ? hash : hash.slice(0, routeQueryAt);
    const routeQuery = routeQueryAt === -1 ? '' : `?${scrubQuery(hash.slice(routeQueryAt + 1))}`;
    fragment = `${scrubPath('', route)}${routeQuery}`;
  }
  return scrubText(`${url.slice(0, authorityStart)}${authority}${scrubPath(host, path)}${query}${fragment}`);
}
