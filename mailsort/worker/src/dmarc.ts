/**
 * Sender authentication from Gmail's Authentication-Results header (RFC 8601; ../../docs/design.md §4.3): whether
 * DMARC passed aligned with the From domain (`authenticated`). The model reads it, a trust label needs it (with a
 * trusted domain), and a review choice teaches a trusted domain only for a mail that has it: a look-alike or forged
 * mail can copy a sender's address and words, not its domain's DMARC result.
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
