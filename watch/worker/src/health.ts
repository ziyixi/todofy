/**
 * Stage 0 of the noise pipeline, the health gate (../../docs/design.md §5): whether an answer is the page at all. A
 * check that fails here is FAILED with one of these codes, never "no change": three in a row make the watch BROKEN
 * (its line goes to the daily digest, never an urgent alert), fourteen days of them pause it.
 *
 * Pure functions over the answer's status, headers and bytes; the codes are watch.ui.v1.FailureReason's names.
 */
import { MIN_TEXT_CHARS, MOJIBAKE_MIN_COUNT, MOJIBAKE_RATIO } from './limits.ts';
import type { SourceConfig } from './config.ts';

export type FailureCode =
  | 'HTTP_ERROR'
  | 'CHALLENGE_PAGE'
  | 'WRONG_CONTENT_TYPE'
  | 'SELECTOR_MISS'
  | 'TOO_SHORT'
  | 'MOJIBAKE'
  | 'JS_QUOTA_EXHAUSTED'
  | 'ROBOTS_DISALLOWED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TOO_LARGE'
  | 'REDIRECT_REFUSED'
  | 'PARSE_ERROR'
  | 'VALUE_MISSING'
  | 'BROWSER_UNAVAILABLE';

/**
 * Text that only bot challenges and block pages carry (Cloudflare, Akamai, Imperva, PerimeterX, DataDome, AWS WAF, a
 * plain captcha). The Worker never tries to pass one: the check fails as CHALLENGE_PAGE and the UI says "blocked".
 */
const CHALLENGE_MARKERS = [
  /<title>\s*just a moment\.\.\.\s*<\/title>/i,
  /\/cdn-cgi\/challenge-platform\//i,
  /\bcf-chl-/i,
  /attention required!\s*\|\s*cloudflare/i,
  /_incapsula_resource/i,
  /\bpx-captcha\b/i,
  /captcha-delivery\.com/i,
  /\bak_bmsc\b|\bbm-verify\b/i,
  /aws-waf-token|awswaf/i,
  /<title>[^<]{0,40}(?:captcha|access denied|are you a robot|人机验证|安全验证)[^<]{0,40}<\/title>/i,
];

/** Whether an answer is a bot challenge or block page. Only the first 16 KiB are read (challenge pages are small). */
export function isChallenge(status: number, headers: Headers, body: Uint8Array): boolean {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  if (body.byteLength > 256 * 1024 && status >= 200 && status < 300) return false;
  // UTF-8 without failing: the ASCII markers read the same in any ASCII-compatible charset, the Chinese ones in UTF-8.
  const head = new TextDecoder('utf-8').decode(body.subarray(0, 16 * 1024));
  return CHALLENGE_MARKERS.some((marker) => marker.test(head));
}

/** The media types each source reads. A feed may come as XML of any label, a JSON Feed as JSON. */
export function contentTypeFits(source: SourceConfig, mediaType: string, markdownAllowed: boolean): boolean {
  const type = mediaType === '' ? 'application/octet-stream' : mediaType;
  const html = type === 'text/html' || type === 'application/xhtml+xml';
  switch (source.kind) {
    case 'html':
      return html || (markdownAllowed && type === 'text/markdown');
    case 'embedded':
      return html;
    case 'feed':
      return /(?:^|\/|\+)(?:xml|json)$/.test(type) || type === 'application/rss+xml' || type === 'application/atom+xml' || type === 'text/plain';
    case 'json':
      return /(?:^|\/|\+)json$/.test(type) || type === 'text/plain' || type === 'text/javascript';
  }
}

/** Whether decoded text is mojibake: at least MOJIBAKE_MIN_COUNT U+FFFD and more than MOJIBAKE_RATIO of it. */
export function isMojibake(text: string): boolean {
  let bad = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad += 1;
  return bad >= MOJIBAKE_MIN_COUNT && bad / Math.max(1, text.length) > MOJIBAKE_RATIO;
}

/** Whether a page's extracted lines are too short to be the page (an empty app shell, an error stub). */
export function isTooShort(lines: readonly string[]): boolean {
  let chars = 0;
  for (const line of lines) {
    chars += line.trim().length;
    if (chars >= MIN_TEXT_CHARS) return false;
  }
  return true;
}

/** The failure of a final HTTP status, or null for 2xx and 304. */
export function statusFailure(status: number): FailureCode | null {
  if ((status >= 200 && status < 300) || status === 304) return null;
  if (status === 429 || status === 503) return 'RATE_LIMITED';
  return 'HTTP_ERROR';
}
