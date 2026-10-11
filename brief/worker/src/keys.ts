/**
 * Canonical keys (../../docs/design.md §4): the arXiv ID without its version; else the DOI, lower-cased; else the
 * normalized URL (`https`, a lower-case host, no fragment, no `utm_*`/`fbclid`/`gclid`, Nature's
 * `error=cookies_not_supported` dropped, no trailing slash). The same key from another source adds that source to
 * the item. Pure functions.
 */

const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid|ref_src|cmpid|at_medium|at_campaign|ocid)$/i;

/** A link normalized for keys and display, or null when it is no http(s) URL. */
export function normalizeUrl(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.port === '443' || url.port === '80') url.port = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.test(name) || (name === 'error' && url.searchParams.get(name) === 'cookies_not_supported') || (name === 'af' && url.searchParams.get(name) === 'R')) url.searchParams.delete(name);
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  let text = url.href;
  if (url.search === '' && text.endsWith('?')) text = text.slice(0, -1);
  return text;
}

export interface Identity {
  readonly arxiv: string | null;
  readonly doi: string | null;
  readonly link: string;
}

/** The canonical key of an item, or null when it has no usable identity. */
export function canonicalKey(identity: Identity): string | null {
  if (identity.arxiv !== null && identity.arxiv !== '') return `arxiv:${identity.arxiv}`;
  if (identity.doi !== null && identity.doi !== '') return `doi:${identity.doi.toLowerCase()}`;
  const url = normalizeUrl(identity.link);
  return url === null ? null : `url:${url}`;
}

/** The link the source line shows: the arXiv abstract page, the DOI link, or the article. */
export function displayLink(identity: Identity): string {
  if (identity.arxiv !== null) return `https://arxiv.org/abs/${identity.arxiv}`;
  if (identity.doi !== null && !/^https:\/\//.test(identity.link)) return `https://doi.org/${identity.doi}`;
  return normalizeUrl(identity.link) ?? identity.link;
}

/** FNV-1a over a string, 52 bits as 13 hex characters (a sitemap's seen URLs). */
export function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + (h2 >>> 12).toString(16).padStart(5, '0')).slice(0, 13);
}
