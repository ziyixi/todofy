/**
 * What the pipeline reads of a Gmail message (../../docs/design.md §4): a few headers, the snippet, and the first
 * text/plain part (else the first text/html part, its markup stripped), decoded with bounded work. Gmail's JSON is
 * untrusted: every field is checked for its type, the walk is bounded in parts and depth, and a body is decoded from
 * at most BODY_BASE64_MAX characters.
 */
import type { GmailMessage } from './gmail.ts';
import { BODY_BASE64_MAX, MIME_DEPTH_MAX, MIME_PARTS_MAX } from './limits.ts';

/** The headers the pipeline reads (lower-case names). */
export interface Headers {
  readonly from: string;
  readonly to: string;
  readonly deliveredTo: string;
  readonly subject: string;
  readonly listId: string;
  readonly messageId: string;
  /** Every Authentication-Results header, top first (dmarc.ts reads only the first). */
  readonly authenticationResults: readonly string[];
}

export interface ReadMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly snippet: string;
  readonly receivedAt: number;
  readonly headers: Headers;
  /** The body text (not yet masked or cut), or '' when there is none. */
  readonly body: string;
}

interface Part {
  readonly mimeType?: unknown;
  readonly headers?: unknown;
  readonly body?: { readonly data?: unknown; readonly size?: unknown };
  readonly parts?: unknown;
}

function headerList(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const { name, value: text } = (item ?? {}) as { name?: unknown; value?: unknown };
    return typeof name === 'string' && typeof text === 'string' ? [{ name: name.toLowerCase(), value: text }] : [];
  });
}

/** Decodes base64url text to UTF-8 (invalid bytes become U+FFFD; the input cut at BODY_BASE64_MAX). */
export function decodeBase64Url(data: string): string {
  const cut = data.slice(0, BODY_BASE64_MAX - (BODY_BASE64_MAX % 4)).replace(/[^A-Za-z0-9_-]/g, '');
  const standard = cut.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return '';
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text of an HTML part: scripts, styles and comments dropped, tags removed, a few entities decoded. Linear. */
export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (match, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), match);
      if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), match);
      return ENTITIES[lower] ?? match;
    });
}

function safeChar(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : fallback;
}

/** Whitespace runs to one space, blank lines to one newline. */
export function tidy(text: string): string {
  return text
    .replace(/[\t\f\v\r ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The first text/plain part's text, else the first text/html part's (stripped), depth-first and bounded. */
export function bodyText(payload: unknown): string {
  const found: { plain: string | null; html: string | null } = { plain: null, html: null };
  let visited = 0;
  const walk = (part: Part, depth: number): void => {
    if (found.plain !== null || visited >= MIME_PARTS_MAX || depth > MIME_DEPTH_MAX) return;
    visited++;
    const type = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const data = typeof part.body?.data === 'string' ? part.body.data : '';
    // An attachment has no inline data in the fields read (attachmentId only).
    if (data !== '' && type === 'text/plain') found.plain = decodeBase64Url(data);
    else if (data !== '' && type === 'text/html' && found.html === null) found.html = decodeBase64Url(data);
    if (Array.isArray(part.parts)) for (const child of part.parts as (Part | null)[]) walk(child ?? {}, depth + 1);
  };
  if (typeof payload === 'object' && payload !== null) walk(payload, 0);
  if (found.plain !== null) return tidy(found.plain);
  return found.html === null ? '' : tidy(stripHtml(found.html));
}

/** The message's fields the pipeline reads, or null when Gmail's answer lacks an ID. */
export function readMessage(message: GmailMessage): ReadMessage | null {
  if (typeof message.id !== 'string') return null;
  const payload = (typeof message.payload === 'object' && message.payload !== null ? message.payload : {}) as Part;
  const headers = headerList(payload.headers);
  const first = (name: string) => headers.find((header) => header.name === name)?.value ?? '';
  const received = Number(message.internalDate ?? '');
  return {
    id: message.id,
    threadId: typeof message.threadId === 'string' ? message.threadId : message.id,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === 'string') : [],
    snippet: typeof message.snippet === 'string' ? message.snippet : '',
    receivedAt: Number.isFinite(received) ? received : 0,
    headers: {
      from: first('from'),
      to: first('to'),
      deliveredTo: first('delivered-to'),
      subject: first('subject'),
      listId: first('list-id'),
      messageId: first('message-id'),
      authenticationResults: headers.filter((header) => header.name === 'authentication-results').map((header) => header.value),
    },
    body: bodyText(payload),
  };
}
