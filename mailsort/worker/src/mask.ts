/**
 * Minimizing and masking (../../docs/design.md §4.2): what leaves the object for the model, the review queue and the
 * examples. Email addresses become [email], runs of six or more digits (codes, amounts, account numbers) [number], and
 * URLs only their domain ([link example.com]). Every pattern is linear (no nested quantifiers), since the text is
 * untrusted and may be built to make a regular expression slow.
 *
 * The rules (stage 1) read the exact addresses before masking; nothing masked is ever used to match.
 */
import { BODY_CHARS, SENDER_CHARS, SNIPPET_CHARS, SUBJECT_CHARS } from './limits.ts';
import type { ReadMessage } from './mime.ts';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)([a-z0-9.-]{1,253})[^\s<>"')\]]{0,2048}/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const DIGITS_PATTERN = /\d{6,}/g;

/** The text with URLs, addresses and long digit runs masked, cut to `max` characters (code points). */
export function mask(text: string, max: number): string {
  const masked = text
    .replace(URL_PATTERN, (_match, host: string) => `[link ${host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')}]`)
    .replace(EMAIL_PATTERN, '[email]')
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

/** The first mailbox of an address header (`Name <a@b>`, `a@b`, `"Name" <a@b>`); null when there is none. */
export function firstMailbox(header: string): Mailbox | null {
  const text = header.slice(0, 2000);
  const angle = /<([^<>\s@]{1,64}@[^<>\s@]{1,253})>/.exec(text);
  const bare = angle === null ? /([^\s<>,;"]{1,64}@[^\s<>,;"]{1,253})/.exec(text) : null;
  const address = (angle?.[1] ?? bare?.[1] ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const name = angle === null ? '' : text.slice(0, angle.index).replace(/["']/g, '').trim();
  return { name, address, domain: address.slice(at + 1).replace(/\.$/, '') };
}

/** The List-Id header's identifier (between the angle brackets), lower case; '' when there is none. */
export function listIdOf(header: string): string {
  const match = /<([^<>\s]{1,255})>/.exec(header.slice(0, 1000));
  const id = (match?.[1] ?? header.trim()).toLowerCase();
  return /^[\x21-\x7e]{1,255}$/.test(id) ? id : '';
}

/** A short code for the address the mail came in through: stable, but not the address. */
export async function aliasCode(address: string): Promise<string> {
  if (address === '') return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mailsort-alias:${address}`)));
  return `to-${Array.from(digest.slice(0, 3), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** What the pipeline knows of one mail: the exact keys for rules, and the masked text for everything else. */
export interface Features {
  /** Exact, for rules and rule proposals only (never sent to the model). */
  readonly senderAddress: string;
  readonly senderDomain: string;
  readonly listId: string;
  readonly deliveredTo: string;
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
  const delivered = firstMailbox(message.headers.deliveredTo) ?? firstMailbox(message.headers.to);
  const senderName = from === null ? '' : mask(from.name, 60);
  return {
    senderAddress: from?.address ?? '',
    senderDomain: from?.domain ?? '',
    listId: listIdOf(message.headers.listId),
    deliveredTo: delivered?.address ?? '',
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
