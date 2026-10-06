/**
 * DMARC alignment from Gmail's Authentication-Results header (RFC 8601; ../../docs/design.md §4.3). A label that implies
 * trust (a bank, accounts, security, government) may be set only by a rule whose mail passed DMARC with the From
 * domain, and the neighbour shortcut needs it too: a look-alike phishing mail can copy a bank's words, not its domain's
 * DMARC result.
 *
 * Only the topmost header counts, and only when Gmail wrote it (authserv-id mx.google.com): a sender can put any
 * number of Authentication-Results headers into its own message, below the one the receiving server adds on top.
 */

const AUTHSERV_ID = 'mx.google.com';

/** Whether the first Authentication-Results header says dmarc=pass with header.from equal to the From domain. */
export function dmarcAligned(authenticationResults: readonly string[], fromDomain: string): boolean {
  const header = authenticationResults[0];
  if (header === undefined || fromDomain === '') return false;
  const text = header.slice(0, 4000).toLowerCase();
  const [authserv, ...results] = text.split(';');
  if ((authserv ?? '').trim().split(/\s+/)[0] !== AUTHSERV_ID) return false;
  for (const result of results) {
    const method = /^\s*dmarc\s*=\s*([a-z]+)/.exec(result);
    if (method === null) continue;
    if (method[1] !== 'pass') return false;
    const from = /\bheader\.from\s*=\s*([a-z0-9.-]+)/.exec(result);
    return from !== null && from[1]?.replace(/\.$/, '') === fromDomain.toLowerCase();
  }
  return false;
}
