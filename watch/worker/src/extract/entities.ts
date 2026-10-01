/**
 * Character references in text that HTMLRewriter and the feed scanner hand over raw (HTMLRewriter's text chunks are
 * source text: `one &amp; two`). Numeric references are decoded in full; named ones from the set pages and feeds
 * actually use (the full HTML table has over 2,000 names, too large for this bundle). An unknown name stays as
 * written, which is stable from load to load, so it never makes a difference by itself.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', shy: '­', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹',
  rsaquo: '›', middot: '·', bull: '•', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', euro: '€',
  pound: '£', yen: '¥', cent: '¢', curren: '¤', sect: '§', para: '¶', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', check: '✓',
  star: '☆', hearts: '♥', iexcl: '¡', iquest: '¿', acute: '´', uml: '¨', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', yuml: 'ÿ', szlig: 'ß', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Iacute: 'Í', Ntilde: 'Ñ', Oacute: 'Ó',
  Ouml: 'Ö', Oslash: 'Ø', Uacute: 'Ú', Uuml: 'Ü',
};

/** A code point as text, or the reference as written when it names no character HTML allows. */
function codePoint(code: number, written: string): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  // HTML maps these C1 references to windows-1252, as browsers do.
  if (code >= 0x80 && code <= 0x9f) return written;
  return String.fromCodePoint(code);
}

/** `text` with its character references decoded (`&amp;`, `&#38;`, `&#x26;`; a missing `;` is tolerated for numbers). */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16), whole);
    if (dec !== undefined) return codePoint(parseInt(dec, 10), whole);
    return (name !== undefined ? NAMED[name] : undefined) ?? whole;
  });
}
