/**
 * Text helpers of the fetchers (../../../docs/design.md §3.2, §6): character references, a feed's XML text, and the
 * charset of a body. HTMLRewriter decodes only by the Content-Type header's charset, so a page that names its encoding
 * only in `<meta charset>` is relabelled first (the watch app's rule, reimplemented: apps never import each other).
 * Everything here is untrusted text from the network.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', larr: '←', rarr: '→',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ',
  phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', iacute: 'í', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ocirc: 'ô',
  ouml: 'ö', oslash: 'ø', uacute: 'ú', uuml: 'ü', szlig: 'ß', Eacute: 'É', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä',
};

function codePoint(code: number, written: string): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
  if (code >= 0x80 && code <= 0x9f) return written;
  return String.fromCodePoint(code);
}

/** `text` with its character references decoded (`&amp;`, `&#38;`, `&#x26;`); an unknown name stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16), whole);
    if (dec !== undefined) return codePoint(parseInt(dec, 10), whole);
    return (name !== undefined ? NAMED[name] : undefined) ?? whole;
  });
}

const BLOCK_TAGS = /<\/?(?:[a-z]+:)?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|section|sec|article|tr|table|figure|figcaption|pre)\b[^<>]*>/gi;
/** A tag: `<` and a name that starts with a letter (`a < b` and `x <5%` are text, not tags). */
const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
/**
 * After the last decode, only the plain tags of a feed that escaped its HTML twice (`&amp;lt;i&amp;gt;`): a known name,
 * quoted attributes or none. `a<b and c>d` and `errors < 5%` are text.
 */
const TWICE_ESCAPED_TAG = /<\/?(i|b|em|strong|sub|sup|span|a|u|small|code|p|br|div|li)(?:\s+[\w:-]+\s*=\s*"[^"<>]*")*\s*\/?>/gi;

/**
 * An XML element's own text: its CDATA sections as they are, the rest with its markup dropped (block elements become
 * paragraph breaks) and its references decoded once. What comes out may be text or HTML, as the feed wrote it.
 */
function elementText(raw: string): string {
  return raw
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeEntities(part.replace(COMMENT, ' ').replace(BLOCK_TAGS, '\n\n').replace(TAG, ''))))
    .join('');
}

function paragraphsOf(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

/**
 * An XML element's text when it may hold HTML (an RSS description, Atom content): its own text (elementText), then the
 * HTML's scripts and tags removed (block tags become paragraph breaks, so a feed's full text keeps its paragraphs) and
 * its references decoded, whitespace collapsed within paragraphs. After the last decode only TWICE_ESCAPED_TAG goes: a
 * decoded `<` is the text's own (`errors < 5%`).
 */
export function xmlText(raw: string): string {
  const html = elementText(raw).replace(COMMENT, ' ').replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ');
  const text = decodeEntities(html.replace(BLOCK_TAGS, '\n\n').replace(TAG, ''));
  return paragraphsOf(text.replace(TWICE_ESCAPED_TAG, (_tag: string, name: string) => (/^(?:p|br|div|li)$/i.test(name) ? '\n\n' : '')));
}

/** An XML element's text when it is never HTML (the arXiv API's titles and abstracts, Crossref's JATS): decoded once. */
export function xmlPlainText(raw: string): string {
  return paragraphsOf(elementText(raw));
}

/** Text on one line (titles): whitespace collapsed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** How far into a body the charset sniffer looks. */
export const SNIFF_BYTES = 2048;

export function knownCharset(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/** The charset parameter of a Content-Type value, lower case, or null. */
export function headerCharset(contentType: string | null): string | null {
  const match = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

function normalizeLabel(label: string): string {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return 'utf-8';
  }
}

/** The charset to decode a body with: the header's when TextDecoder knows it, else a BOM, a meta or XML declaration. */
export function detectCharset(contentType: string | null, bytes: Uint8Array): string {
  const header = headerCharset(contentType);
  if (header !== null && knownCharset(header)) return normalizeLabel(header);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SNIFF_BYTES));
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]{1,40})["']/i.exec(head)?.[1];
  const meta = /<meta\b[^>]*\bcharset\s*=\s*["']?([A-Za-z0-9._:-]{1,40})/i.exec(head)?.[1];
  const sniffed = xml ?? meta;
  if (sniffed !== undefined && knownCharset(sniffed)) {
    const label = normalizeLabel(sniffed);
    // A document that declares UTF-16 in ASCII is not UTF-16 (the HTML rule).
    return label === 'utf-16le' || label === 'utf-16be' ? 'utf-8' : label;
  }
  return 'utf-8';
}

/** The body as text in `charset` (invalid sequences become U+FFFD). */
export function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** The media type of a Content-Type value, lower case, without parameters. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
