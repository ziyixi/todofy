/**
 * URLs, the page ID and the length bounds (../docs/design.md §3.5), shared by the extension and the Worker. No
 * dependency and no platform API but the WHATWG URL parser, TextEncoder and Web Crypto, so the same file runs in a
 * service worker, in workerd and in Node.
 *
 * A URL is normalized with the WHATWG parser: http(s) only; the host in lower case without a default port (the parser
 * does both, and writes an IDN in punycode) and without a trailing dot (`example.com.` is `example.com`); no user name
 * or password (a credential never enters the page ID, the archive or a link); the fragment dropped unless it starts
 * with `/` or `!` (a hash router's route); tracking parameters removed and the rest of the query kept in its order,
 * byte for byte. The serialized URL is ASCII. A host the archive's Site format cannot carry (the parser also accepts
 * `!`, `$`, `~` and other punctuation in a host name, which no real host has) makes the URL one recall never records,
 * so the extension never queues an item the Worker would have to refuse.
 *
 * The page ID is the first 16 bytes of the SHA-256 of the normalized URL BEFORE scrubbing and cutting, in hex: two
 * reset links the scrubber turns into the same `/reset/[redacted]` stay two pages, and a URL cut to its first 8192
 * characters keeps the ID of the whole.
 */

/** Query parameters dropped by name (ignoring case), and every parameter whose name starts with `utm_`. */
export const TRACKING_PARAMETERS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  '_hsenc',
  '_hsmi',
  'yclid',
]);

/** A URL longer than this is cut, after its page ID was computed from the whole (Url in recall.archive.v1). */
export const URL_MAX_CHARS = 8192;
/** A title or a description longer than this (in code points) is cut to one less and ends with `…`. */
export const TEXT_MAX_CHARS = 1000;
/** A captured text is cut to this many bytes of UTF-8, at a character boundary. */
export const DOCUMENT_MAX_BYTES = 64 * 1024;
export const ELLIPSIS = '…';

/** A host as the archive's Site format allows it (IDN in punycode, `_` included), or a bracketed IPv6 literal. */
const HOST = /^(?:[a-z0-9_](?:[a-z0-9._-]{0,251}[a-z0-9_])?|\[[0-9a-f:.]{2,45}\])$/;

export interface NormalizedUrl {
  /** The serialized URL (ASCII). */
  readonly url: string;
  /** The host in lower case (`www.example.com`, `[::1]`). */
  readonly host: string;
  /** The host without a leading `www.` (the archive's Site). */
  readonly site: string;
}

/** The query's name, decoded as a form would (`+` is a space), for the tracking check only; null when undecodable. */
function parameterName(part: string): string | null {
  const raw = part.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replaceAll('+', ' ')).toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a query parameter's (decoded, lower-case) name is a tracking parameter. */
export function isTrackingParameter(name: string): boolean {
  return name.startsWith('utm_') || TRACKING_PARAMETERS.has(name);
}

/** The query (`?a=1&b=2`, or '') without tracking parameters and empty parts, the others raw and in order. */
function cleanQuery(search: string): string {
  if (search === '' || search === '?') return '';
  const kept = search
    .slice(1)
    .split('&')
    .filter((part) => {
      if (part === '') return false;
      const name = parameterName(part);
      return name === null || !isTrackingParameter(name);
    });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/** The site of a host: without a leading `www.`. */
export function siteOf(host: string): string {
  return host.startsWith('www.') && host.length > 4 ? host.slice(4) : host;
}

/** The normalized form of an http(s) URL, or null for anything else (another scheme, not a URL, no host). */
export function normalizeUrl(input: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.replace(/\.+$/, '');
  if (!HOST.test(hostname)) return null;
  if (hostname !== url.hostname) url.hostname = hostname;
  url.username = '';
  url.password = '';
  const hash = url.hash.startsWith('#/') || url.hash.startsWith('#!') ? url.hash : '';
  const serialized = `${url.protocol}//${url.host}${url.pathname}${cleanQuery(url.search)}${hash}`;
  return { url: serialized, host: url.hostname, site: siteOf(url.hostname) };
}

/** The root URL of a URL's site (`https://mail.example.com/`): what a site-only page is recorded as. */
export function rootUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return null;
  }
}

/** The page ID of a normalized URL: the first 16 bytes of its SHA-256, in lower-case hex. */
export async function pageIdOf(normalizedUrl: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedUrl)));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A URL cut to URL_MAX_CHARS, and whether it was cut. The normalized URL is ASCII, so a cut never splits a character. */
export function cutUrl(url: string): { readonly url: string; readonly truncated: boolean } {
  return url.length > URL_MAX_CHARS ? { url: url.slice(0, URL_MAX_CHARS), truncated: true } : { url, truncated: false };
}

/** A title or description of at most TEXT_MAX_CHARS code points: a longer one is cut to one less, plus `…`. */
export function cutText(text: string): string {
  if (text.length <= TEXT_MAX_CHARS) return text;
  const points = Array.from(text);
  return points.length <= TEXT_MAX_CHARS ? text : `${points.slice(0, TEXT_MAX_CHARS - 1).join('')}${ELLIPSIS}`;
}

/** The first `maxBytes` bytes of a string's UTF-8 at a character boundary, and whether it was cut. */
export function cutUtf8(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  // Every code point takes at most 4 bytes and at least 1: a short string needs no encoding.
  if (text.length * 3 <= maxBytes) return { text, truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back to the first byte of a character (a continuation byte is 10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** The UTF-8 size of a string. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
