/**
 * The character encoding of a body (../../../docs/design.md §5, stage 2). HTMLRewriter decodes only by the charset of
 * the response's Content-Type header: a GBK page that names its encoding only in `<meta charset="gbk">` comes out
 * as U+FFFD. So the first 2 KiB are sniffed for a BOM, a `<meta charset>` or `<meta http-equiv="Content-Type">`, or an
 * XML declaration, and the response is relabelled with that charset before HTMLRewriter (or TextDecoder) sees it. A
 * charset in the header wins (the HTML rule), unless it is one TextDecoder does not know.
 *
 * UTF-16 (a BOM, or a header that names it) is not ASCII-compatible, and HTMLRewriter decodes only ASCII-compatible
 * encodings: such a body is decoded here and handed on as UTF-8 (`asUtf8`). A `<meta charset="utf-16">` is read as
 * UTF-8, as the HTML standard says (a document that could declare it in ASCII is not UTF-16).
 */

/** How far into the body the sniffer looks (the HTML standard's prescan reads 1,024 bytes; pages pad more). */
export const SNIFF_BYTES = 2048;

export interface Charset {
  /** A label TextDecoder accepts, lower case (`utf-8`, `gbk`, `shift_jis`, ...). */
  readonly label: string;
  /** Where it came from. */
  readonly source: 'header' | 'bom' | 'meta' | 'xml' | 'default';
}

/** Whether TextDecoder knows `label`. */
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

/** The media type of a Content-Type value, lower case, without parameters ('' when absent). */
export function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** The charset a byte order mark announces, or null. */
function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return null;
}

/** The charset a document's first bytes declare (`<meta charset>`, http-equiv, an XML declaration), or null. */
export function sniffCharset(bytes: Uint8Array): { readonly label: string; readonly source: 'meta' | 'xml' } | null {
  // Every encoding a page can declare this way is ASCII-compatible in its first bytes: latin1 reads them as written.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SNIFF_BYTES));
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]{1,40})["']/i.exec(head);
  if (xml?.[1] !== undefined) return { label: xml[1].toLowerCase(), source: 'xml' };
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const text = tag[0];
    const direct = /\bcharset\s*=\s*["']?([A-Za-z0-9._:-]{1,40})/i.exec(text);
    if (direct?.[1] !== undefined) return { label: direct[1].toLowerCase(), source: 'meta' };
  }
  return null;
}

/** The charset to decode a body with. */
export function detectCharset(contentType: string | null, bytes: Uint8Array): Charset {
  const header = headerCharset(contentType);
  if (header !== null && knownCharset(header)) return { label: normalizeLabel(header), source: 'header' };
  const bom = bomCharset(bytes);
  if (bom !== null) return { label: bom, source: 'bom' };
  const sniffed = sniffCharset(bytes);
  if (sniffed !== null && knownCharset(sniffed.label)) {
    const label = normalizeLabel(sniffed.label);
    return { label: isUtf16(label) ? 'utf-8' : label, source: sniffed.source };
  }
  return { label: 'utf-8', source: 'default' };
}

/** Whether a label (as the decoder names it) is UTF-16, which HTMLRewriter cannot decode. */
export function isUtf16(label: string): boolean {
  return label === 'utf-16le' || label === 'utf-16be';
}

/** The body and its charset ready for HTMLRewriter: a UTF-16 body decoded and encoded again as UTF-8. */
export function asUtf8(bytes: Uint8Array, charset: string): { readonly bytes: Uint8Array; readonly label: string } {
  if (!isUtf16(charset)) return { bytes, label: charset };
  return { bytes: new TextEncoder().encode(decodeBody(bytes, charset)), label: 'utf-8' };
}

/** A label as the decoder names its encoding (`GB2312` decodes as `gbk`; `utf8` as `utf-8`). */
function normalizeLabel(label: string): string {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return 'utf-8';
  }
}

/** A response for HTMLRewriter whose Content-Type names `charset` (the bytes are unchanged). */
export function relabelled(bytes: Uint8Array, charset: string): Response {
  return new Response(bytes, { headers: { 'content-type': `text/html; charset=${charset}` } });
}

/** The body as text in `charset` (invalid sequences become U+FFFD, which the health gate counts). */
export function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
