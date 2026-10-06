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
 *
 * Even Gmail's own header carries text the sender chose: the comment after spf= and smtp.mailfrom quote the envelope
 * sender, and an RFC 5321 quoted local part may hold ';' and '=' ("a;dmarc=pass header.from=bank.example"@evil.example).
 * Comments and quoted strings are therefore blanked out (neutralise) before the header is split into results, and
 * DMARC counts only when there is exactly one dmarc result: a header that somehow carries two is ambiguous, and
 * ambiguity never authenticates.
 */

const AUTHSERV_ID = 'mx.google.com';

/** A plain domain of two labels or more (the List-Id namespace, a DKIM signing domain). */
const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/**
 * The header with every comment ("(...)", nested) and quoted string ('"..."') replaced by spaces of the same length,
 * so that no ';', '=' or result keyword inside them is read as structure, or null when a comment or quoted string is
 * never closed (a malformed header authenticates nothing). A backslash escapes the next character in both.
 *
 * Stricter than RFC 5322 on purpose: a quoted string inside a comment is honoured too, so that a ')' in a quoted
 * envelope local part (Gmail's spf comment repeats it) cannot close the comment early and expose what follows it.
 */
export function neutralise(header: string): string | null {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i] ?? '';
    const inside = quoted || depth > 0;
    if (inside && c === '\\') {
      // The escaped character is part of the comment or string whatever it is (a quote, a parenthesis).
      out += i + 1 < header.length ? '  ' : ' ';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      out += ' ';
    } else if (!quoted && c === '(') {
      depth++;
      out += ' ';
    } else if (!quoted && c === ')' && depth > 0) {
      depth--;
      out += ' ';
    } else {
      out += inside ? ' ' : c;
    }
  }
  return quoted || depth > 0 ? null : out;
}

/** The results of Gmail's topmost Authentication-Results header (lower case), or null when Gmail did not write it. */
function gmailResults(authenticationResults: readonly string[]): string[] | null {
  const header = authenticationResults[0];
  if (header === undefined) return null;
  const structure = neutralise(header.slice(0, 4000));
  if (structure === null) return null;
  const [authserv, ...results] = structure.toLowerCase().split(';');
  return (authserv ?? '').trim().split(/\s+/)[0] === AUTHSERV_ID ? results : null;
}

/**
 * Whether Gmail's topmost Authentication-Results header has exactly one dmarc result, and it is dmarc=pass with
 * header.from equal to the From domain.
 */
export function dmarcAligned(authenticationResults: readonly string[], fromDomain: string): boolean {
  const results = gmailResults(authenticationResults);
  if (results === null || fromDomain === '') return false;
  const dmarc = results.filter((result) => /^\s*dmarc\s*=/.test(result));
  if (dmarc.length !== 1) return false;
  const result = dmarc[0] ?? '';
  if (/^\s*dmarc\s*=\s*([a-z]+)/.exec(result)?.[1] !== 'pass') return false;
  const from = /\bheader\.from\s*=\s*([a-z0-9.-]+)/.exec(result);
  return from !== null && from[1]?.replace(/\.$/, '') === fromDomain.toLowerCase();
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
