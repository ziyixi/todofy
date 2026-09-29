/**
 * One value of the named cookie from the request's `Cookie` header, or null. The header is split
 * into `;`-separated pairs, each trimmed and split at its first `=`; the name must match exactly
 * (case-sensitive). A pair without `=` is a cookie with an empty name and never matches.
 * `occurrence` picks the first or the last pair with that name when a browser sends several
 * (different paths or domains).
 */
export function readCookie(request: Request, name: string, occurrence: 'first' | 'last'): string | null {
  const header = request.headers.get('cookie');
  if (header === null || name === '') return null;
  let found: string | null = null;
  for (const raw of header.split(';')) {
    const pair = raw.trim();
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index) !== name) continue;
    found = pair.slice(index + 1);
    if (occurrence === 'first') return found;
  }
  return found;
}
