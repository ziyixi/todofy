/**
 * Which URLs the brief may fetch (../../../docs/design.md §3.2), applied to every request and again to every redirect
 * hop, so a feed or a page can never lead the Worker somewhere else (the watch app's policy, reimplemented):
 *
 * - `https:` only; no user name, password or explicit port;
 * - the host is a DNS name with at least one dot: never an IP literal, never a name under a special-use or local
 *   suffix, and never one of the owner's own names (the public host's zone and workers.dev);
 * - the fragment is dropped.
 */

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'invalid', 'onion', 'test', 'example'];
const URL_MAX = 2048;

/** The owner's own names for `publicHost` (`brief.ziyixi.science` → its zone `ziyixi.science`), and workers.dev. */
export function ownSuffixes(publicHost: string | null): string[] {
  const suffixes = ['workers.dev'];
  if (publicHost !== null) {
    const labels = publicHost.split('.');
    suffixes.push(labels.length > 2 ? labels.slice(1).join('.') : publicHost);
  }
  return suffixes;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname);
}

/** The URL to fetch, normalized (fragment dropped), or null when the policy refuses it. */
export function checkFetchUrl(text: string, own: readonly string[]): URL | null {
  if (text.length === 0 || text.length > URL_MAX || /\s/.test(text) || hasControl(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || isIpLiteral(host) || !host.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((label) => label === '' || label.length > 63)) return null;
  if ([...LOCAL_SUFFIXES, ...own].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  url.hash = '';
  return url;
}

/** A redirect's Location resolved against the current URL and checked, or null. */
export function checkRedirect(location: string, from: URL, own: readonly string[]): URL | null {
  try {
    return checkFetchUrl(new URL(location, from).href, own);
  } catch {
    return null;
  }
}
