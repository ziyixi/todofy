/**
 * Which URLs a watch may fetch (../../docs/design.md §4): the rule of Watch.uri, applied when the owner saves a watch
 * and again to every redirect hop, so a page can never lead the Worker somewhere the owner could not have typed.
 *
 * - `https:` only, `http:` only when the watch allows it (the UI warns);
 * - no user name or password, no explicit port (only the scheme's default), at most URI_MAX characters;
 * - the host is a DNS name with at least one dot: never an IP literal (the URL parser already turns `0x7f.1`,
 *   `2130706433` and friends into dotted IPv4, and IPv6 is bracketed), never `localhost` or a name under a
 *   special-use or local suffix, and never a name of this owner's own (OWN_SUFFIXES: the deployment zone and
 *   the account's `workers.dev` subdomain, each with every name under it: the owner's apps and Workers must not be
 *   poked at by a watch, or by a hostile page's redirect);
 * - the fragment is dropped (it never reaches a server).
 */
import { URI_MAX } from './limits.ts';
import { OWN_SUFFIXES } from './deployment.ts';
export { OWN_SUFFIXES } from './deployment.ts';

/** Suffixes that never name a public site (RFC 6761, RFC 6762, RFC 8375 and common private ones). */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'invalid', 'onion'];

export type UriProblem = 'INVALID_URI';

export interface UriPolicy {
  /** `http:` is allowed too (FetchPolicy.allow_http). */
  readonly allowHttp: boolean;
}

/** Whether a URL host is an IP literal (after the URL parser's own normalization). */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname);
}

/** Whether a host is one of the owner's own names or under one. */
export function isOwnZone(hostname: string): boolean {
  return OWN_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Whether `text` holds an ASCII control character. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The URL a watch may fetch, normalized (fragment dropped), or null when the policy refuses it. */
export function checkUri(text: string, policy: UriPolicy): URL | null {
  if (text.length === 0 || text.length > URI_MAX || /\s/.test(text) || hasControl(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || isIpLiteral(host) || !host.includes('.') || isOwnZone(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((label) => label === '' || label.length > 63)) return null;
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  url.hash = '';
  if (url.href.length > URI_MAX) return null;
  return url;
}

/** A redirect's Location resolved against the current URL and checked like a saved URI, or null. */
export function checkRedirect(location: string, from: URL, policy: UriPolicy): URL | null {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  return checkUri(next.href, policy);
}
