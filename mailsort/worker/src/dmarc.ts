/**
 * Sender authentication from Gmail's Authentication-Results header (RFC 8601; ../../docs/design.md §4.3), for rules
 * and the trust labels.
 *
 * - DMARC alignment: dmarc=pass with header.from equal to the From domain. Every sender rule (a From address or
 *   domain) needs it, and so does a trust label (a bank, accounts, security, government) and the neighbour shortcut:
 *   a look-alike or forged mail can copy a sender's address and words, not its domain's DMARC result.
 * - DKIM for a mailing list: the domains whose DKIM signature passed (header.d, or the domain of header.i). A List-Id
 *   is a header the sender writes, so a list rule also needs the list's own domain to have signed the mail
 *   (listSigned).
 *
 * Only the topmost header counts, and only when Gmail wrote it (authserv-id mx.google.com): a sender can put any
 * number of Authentication-Results headers into its own message, below the one the receiving server adds on top.
 */

const AUTHSERV_ID = 'mx.google.com';

/** A plain domain of two labels or more (the List-Id namespace, a DKIM signing domain). */
const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/** The results of Gmail's topmost Authentication-Results header (lower case), or null when Gmail did not write it. */
function gmailResults(authenticationResults: readonly string[]): string[] | null {
  const header = authenticationResults[0];
  if (header === undefined) return null;
  const [authserv, ...results] = header.slice(0, 4000).toLowerCase().split(';');
  return (authserv ?? '').trim().split(/\s+/)[0] === AUTHSERV_ID ? results : null;
}

/** Whether the first Authentication-Results header says dmarc=pass with header.from equal to the From domain. */
export function dmarcAligned(authenticationResults: readonly string[], fromDomain: string): boolean {
  const results = gmailResults(authenticationResults);
  if (results === null || fromDomain === '') return false;
  for (const result of results) {
    const method = /^\s*dmarc\s*=\s*([a-z]+)/.exec(result);
    if (method === null) continue;
    if (method[1] !== 'pass') return false;
    const from = /\bheader\.from\s*=\s*([a-z0-9.-]+)/.exec(result);
    return from !== null && from[1]?.replace(/\.$/, '') === fromDomain.toLowerCase();
  }
  return false;
}

/** The domains whose DKIM signature passed, from Gmail's topmost header: header.d, else the domain of header.i. */
export function dkimPassDomains(authenticationResults: readonly string[]): string[] {
  const results = gmailResults(authenticationResults);
  if (results === null) return [];
  const out: string[] = [];
  for (const result of results) {
    const method = /^\s*dkim\s*=\s*([a-z]+)/.exec(result);
    if (method?.[1] !== 'pass') continue;
    const domain = /\bheader\.d\s*=\s*([a-z0-9.-]+)/.exec(result)?.[1] ?? /\bheader\.i\s*=\s*[^\s@;]*@([a-z0-9.-]+)/.exec(result)?.[1];
    const clean = domain?.replace(/\.$/, '');
    if (clean !== undefined && DOMAIN.test(clean) && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Whether a list rule may trust the List-Id `listId` (RFC 2919: a label, then the list's namespace, usually a
 * domain: `digest.news.example.com`). When the namespace is a domain, a DKIM signature that passed for it, a parent
 * of it or a subdomain of it must be on the mail (`news.example.com`, `example.com`); anyone can write a List-Id,
 * only the list's domain can sign for it. A namespace that is no domain (some lists use an opaque one) has nothing to
 * check a signature against: the List-Id alone counts, as the design records.
 */
export function listSigned(listId: string, dkimDomains: readonly string[]): boolean {
  const dot = listId.indexOf('.');
  const namespace = dot < 0 ? '' : listId.slice(dot + 1);
  if (!DOMAIN.test(namespace)) return true;
  return dkimDomains.some((domain) => domain === namespace || namespace.endsWith(`.${domain}`) || domain.endsWith(`.${namespace}`));
}
