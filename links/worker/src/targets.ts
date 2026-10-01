/**
 * Targets and passthrough (../../docs/design.md §3): which targets a link may store, and the URL a redirect sends for
 * a request's path after the key. Every URL is built with the URL API, the request's path is percent-encoded
 * segment by segment, and the result must keep the stored target's origin, so no request path can turn a link into
 * an open redirect (`/<key>/@evil.example`, `/<key>/%2F%2Fevil.example`, `..`, backslashes). The query string of a
 * request never passes through.
 */
import { asciiLower } from './keys.ts';
import { LOCATION_MAX, PATH_PLACEHOLDER, TARGET_MAX } from './limits.ts';

export type PathMode = 'exact' | 'append' | 'template';

/** Whether `text` holds a C0 control character or DEL. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parsed(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** The end of a URL's authority (`https://host:port`): the index of the first `/`, `?` or `#` after the scheme. */
function authorityEnd(text: string): number {
  const start = text.indexOf('//') + 2;
  const ends = ['/', '?', '#', '\\'].map((char) => text.indexOf(char, start)).filter((index) => index !== -1);
  return ends.length === 0 ? text.length : Math.min(...ends);
}

/** An https URL without credentials whose host is not `publicHost` (the links host itself: no redirect loops). */
function usable(url: URL | null, publicHost: string): url is URL {
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = asciiLower(url.hostname).replace(/\.$/, '');
  return host !== '' && host !== asciiLower(publicHost);
}

/**
 * The stored form of a target for `mode`, or null when it may not be stored: an absolute https URL of at most
 * TARGET_MAX characters, without whitespace, control characters, user name or password, on another host than
 * `publicHost`. EXACT and APPEND targets are stored as the URL parser writes them (`https://example.com` becomes
 * `https://example.com/`) and hold no `{path}`. A TEMPLATE target holds exactly one `{path}` after its authority and
 * no backslash, and is stored as written (the parser would percent-encode the braces in a path).
 */
export function checkTarget(raw: string, mode: PathMode, publicHost: string): string | null {
  // Whitespace and control characters: never in a stored target (the URL parser would drop or encode them).
  if (raw.length === 0 || raw.length > TARGET_MAX || /\s/.test(raw) || hasControl(raw)) return null;
  if (!/^https:\/\//i.test(raw)) return null;
  const placeholders = raw.split(PATH_PLACEHOLDER).length - 1;
  if (mode !== 'template') {
    const url = parsed(raw);
    if (placeholders !== 0 || !usable(url, publicHost)) return null;
    return url.href.length <= TARGET_MAX ? url.href : null;
  }
  if (placeholders !== 1 || raw.includes('\\') || raw.indexOf(PATH_PLACEHOLDER) < authorityEnd(raw)) return null;
  const empty = parsed(raw.replace(PATH_PLACEHOLDER, ''));
  const filled = parsed(raw.replace(PATH_PLACEHOLDER, 'p/a%20th'));
  if (!usable(empty, publicHost) || !usable(filled, publicHost) || empty.origin !== filled.origin) return null;
  return raw;
}

/** Why a request's path after the key cannot reach the target. */
export type RestProblem = 'NO_PATH' | 'BAD_PATH';

/**
 * The decoded segments of a request's rest (the raw path after `/<key>/`), or null when one is malformed or unsafe:
 * a bad percent-escape, `.` or `..`, a `/` or `\` hidden in an escape, or a control character. An empty rest has no
 * segments; empty segments (`a//b`, a trailing `/`) are kept.
 */
export function restSegments(rest: string): string[] | null {
  if (rest === '') return [];
  const segments: string[] = [];
  for (const raw of rest.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..' || /[/\\]/.test(segment) || hasControl(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

const encodePath = (segments: readonly string[]): string => segments.map(encodeURIComponent).join('/');

/**
 * The URL to send for a link (its stored target and mode) and a request's rest, or why there is none:
 *
 * - EXACT: the target; a request with a rest is NO_PATH (an EXACT link takes no path);
 * - APPEND: the rest's segments, each percent-encoded, appended to the target's path (`https://a.example/x/` plus
 *   `b c/d` is `https://a.example/x/b%20c/d`); the target's query and fragment stay;
 * - TEMPLATE: `{path}` replaced by the rest: segment by segment before the template's `?` or `#`, as one
 *   percent-encoded value (slashes included) after it; an empty rest replaces it with nothing.
 *
 * BAD_PATH when the rest is malformed (restSegments), the result is longer than LOCATION_MAX, or it would leave the
 * target's origin.
 */
export function destination(target: string, mode: PathMode, rest: string): { readonly url: string } | { readonly problem: RestProblem } {
  const segments = restSegments(rest);
  if (segments === null) return { problem: 'BAD_PATH' };
  let url: URL | null;
  let origin: string | undefined;
  if (mode === 'exact') {
    if (segments.length > 0) return { problem: 'NO_PATH' };
    return { url: target };
  } else if (mode === 'append') {
    url = parsed(target);
    origin = url?.origin;
    if (url !== null && segments.length > 0) url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodePath(segments)}`;
  } else {
    const at = target.indexOf(PATH_PLACEHOLDER);
    const query = [target.indexOf('?'), target.indexOf('#')].filter((index) => index !== -1);
    const inQuery = query.length > 0 && at > Math.min(...query);
    const value = inQuery ? encodeURIComponent(segments.join('/')) : encodePath(segments);
    url = parsed(target.slice(0, at) + value + target.slice(at + PATH_PLACEHOLDER.length));
    origin = parsed(target.replace(PATH_PLACEHOLDER, ''))?.origin;
  }
  if (url === null || origin === undefined || url.origin !== origin || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return { problem: 'BAD_PATH' };
  }
  return url.href.length <= LOCATION_MAX ? { url: url.href } : { problem: 'BAD_PATH' };
}
