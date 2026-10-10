/**
 * Minimizing and masking (../../docs/design.md §4.2): what leaves the object for the model, the review queue and the
 * examples. Email addresses become [email], six or more digits in a row (codes, amounts, card and account numbers,
 * also when grouped by spaces, dashes or dots, and in full-width digits) [number], and URLs, with or without a scheme,
 * only their domain ([link example.com]). Every pattern is linear (no nested quantifiers over overlapping classes),
 * since the text is untrusted and may be built to make a regular expression slow.
 *
 * The exact From address is read before masking only for its keyed hash (senderHash, the sender history) and its
 * domain (DMARC, the trusted domains); neither the address nor anything masked is sent to the model unmasked.
 */
import { BODY_CHARS, SENDER_CHARS, SNIPPET_CHARS, SUBJECT_CHARS } from './limits.ts';
import type { ReadMessage } from './mime.ts';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)([a-z0-9.-]{1,253})[^\s<>"')\]]{0,2048}/gi;
/** A URL without a scheme: a host name directly followed by a path, a query or a fragment (`bank.example.com/x?t=1`). */
const BARE_URL_PATTERN = /\b((?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24})[/?#][^\s<>"')\]]{0,2048}/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
/**
 * Six or more digits, single spaces, dashes or dots allowed between them: `4111 1111 1111 1111`, `123 456`,
 * `6222-0210-0101-2345`, `DE89 3704 0044 0532 0130 00`. A digit and a separator never overlap, so this stays linear.
 */
const DIGITS_PATTERN = /\d(?:[ .-]?\d){5,}/g;

/** Full-width digits (０-９, common in Chinese mail) as ASCII digits, so the digit pattern sees them. */
const FULL_WIDTH_DIGITS = /[\uff10-\uff19]/g;

/** The text with URLs, addresses and long digit runs masked, cut to `max` characters (code points). */
export function mask(text: string, max: number): string {
  // Addresses before scheme-less URLs: `a@mail.example.com?` must become [email]?, not a@[link mail.example.com].
  const masked = text
    .replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(URL_PATTERN, (_match, host: string) => `[link ${host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')}]`)
    .replace(EMAIL_PATTERN, '[email]')
    .replace(BARE_URL_PATTERN, (_match, host: string) => `[link ${host.toLowerCase()}]`)
    .replace(DIGITS_PATTERN, '[number]');
  return cut(masked, max);
}

/** At most `max` code points (never splits a surrogate pair). */
export function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`;
}

/** A parsed address header's first mailbox: display name and lower-case address. */
export interface Mailbox {
  readonly name: string;
  readonly address: string;
  readonly domain: string;
}

/** Quoted strings and comments of an address header: display text, never the address (RFC 5322). Linear. */
const DISPLAY_TEXT = /"(?:[^"\\]|\\.)*"|\([^()]*\)/g;

/**
 * The first mailbox of an address header (`Name <a@b>`, `a@b`, `"Name" <a@b>`); null when there is none. Quoted
 * strings and comments are blanked out first, so `"<boss@work.example>" <x@evil.example>` reads as x@evil.example
 * (the address Gmail's DMARC checks), never as the one in the display name; then the last angle address of the first
 * mailbox is the address.
 */
export function firstMailbox(header: string): Mailbox | null {
  const text = header.slice(0, 2000);
  // Blanked to the same length, so an index into `plain` is an index into `text`.
  const plain = text.replace(DISPLAY_TEXT, (match) => ' '.repeat(match.length));
  const comma = plain.indexOf(',');
  const first = comma < 0 ? plain : plain.slice(0, comma);
  const angle = [...first.matchAll(/<([^<>\s@]{1,64}@[^<>\s@]{1,253})>/g)].at(-1);
  const bare = angle === undefined ? /([^\s<>,;"]{1,64}@[^\s<>,;"]{1,253})/.exec(first) : null;
  const address = (angle?.[1] ?? bare?.[1] ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const name = angle === undefined ? '' : text.slice(0, angle.index).replace(/["']/g, '').trim();
  return { name, address, domain: address.slice(at + 1).replace(/\.$/, '') };
}

/** The List-Id header's identifier (between the angle brackets), lower case; '' when there is none. */
export function listIdOf(header: string): string {
  const match = /<([^<>\s]{1,255})>/.exec(header.slice(0, 1000));
  const id = (match?.[1] ?? header.trim()).toLowerCase();
  return /^[\x21-\x7e]{1,255}$/.test(id) ? id : '';
}

/**
 * The sender of a mail as the decisions keep it (16 hex characters of a salted SHA-256 of the lower-case From address),
 * so the sender history can count what the same sender's earlier mail got without keeping the address; '' for none.
 */
export async function senderHash(address: string): Promise<string> {
  if (address === '') return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mailsort-sender:${address.toLowerCase()}`)));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A short code for the address the mail came in through: stable, but not the address. */
export async function aliasCode(address: string): Promise<string> {
  if (address === '') return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mailsort-alias:${address}`)));
  return `to-${Array.from(digest.slice(0, 3), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** What the pipeline knows of one mail: the exact sender for its hash and domain, and the masked text for the rest. */
export interface Features {
  /** Exact, for senderHash only: never stored, never sent to the model. */
  readonly senderAddress: string;
  /** The From domain: DMARC's alignment, the trusted domains, kept with the content for 14 days. */
  readonly senderDomain: string;
  /** The List-Id: the model only learns whether there is one. */
  readonly listId: string;
  /** Masked: what the model, the review queue and the examples see. */
  readonly sender: string;
  readonly subject: string;
  readonly snippet: string;
  readonly body: string;
  readonly toCode: string;
  /** Gmail's own category (promotions, social, updates, forums, primary), if any. */
  readonly category: string;
}

const CATEGORIES: Readonly<Record<string, string>> = {
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_FORUMS: 'forums',
  CATEGORY_PERSONAL: 'primary',
};

export async function features(message: ReadMessage): Promise<Features> {
  const from = firstMailbox(message.headers.from);
  // The model's code for the address it came to: Delivered-To, else To (only a hint).
  const delivered = firstMailbox(message.headers.deliveredTo) ?? firstMailbox(message.headers.to);
  const senderName = from === null ? '' : mask(from.name, 60);
  return {
    senderAddress: from?.address ?? '',
    senderDomain: from?.domain ?? '',
    listId: listIdOf(message.headers.listId),
    sender: cut(from === null ? '' : `${senderName} <${from.domain}>`.trim(), SENDER_CHARS),
    subject: mask(message.headers.subject, SUBJECT_CHARS),
    snippet: mask(message.snippet, SNIPPET_CHARS),
    body: mask(message.body, BODY_CHARS),
    toCode: await aliasCode(delivered?.address ?? ''),
    category: message.labelIds.map((label) => CATEGORIES[label]).find((name) => name !== undefined) ?? '',
  };
}

/** The short summary an example keeps and the embedding model reads: subject, sender and snippet, masked. */
export function summaryOf(f: Pick<Features, 'subject' | 'sender' | 'snippet'>, max: number): string {
  return cut([f.subject, f.sender, f.snippet].filter((part) => part !== '').join(' · '), max);
}
