/**
 * The email's feedback links (../../docs/design.md §10): 👍 · 👎 · 多来点 under each item, each
 * `https://<host>/feedback?t=<token>` with
 * `base64url(JSON [issue, item, vote, expiry]) "." base64url(HMAC-SHA-256(FEEDBACK_SIGNING_KEY, payload))`, the MAC
 * truncated to 128 bits. `/feedback` is the exact path of an Access Bypass application, so the Worker verifies the
 * token before anything else: a bad or expired token, or another method, is 404 without any object call.
 *
 * Two taps on purpose: mail scanners and link prefetchers open GET links, and votes they cast would teach the profile
 * noise. GET answers a small page with the item's title and one button (no script, no-store, noindex, no referrer);
 * POST (that button, the token in the form body) records the vote. The route reads no cookie and shows nothing but that
 * title; its key is its own, never the owner's.
 */
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, importHmacKeyHex } from '@ziyixi/edge-auth';
import { FEEDBACK_TTL_MS } from './limits.ts';

export const VOTES = ['up', 'down', 'more'] as const;
export type VoteName = (typeof VOTES)[number];

export const VOTE_WORDS: Readonly<Record<VoteName, { readonly emoji: string; readonly button: string }>> = {
  up: { emoji: '👍', button: '记下 👍' },
  down: { emoji: '👎', button: '记下 👎' },
  more: { emoji: '多来点', button: '多来点' },
};

export interface FeedbackClaim {
  readonly issue: string;
  readonly item: string;
  readonly vote: VoteName;
}

const TOKEN_MAX = 200;
const MAC_BYTES = 16;

async function mac(key: CryptoKey, payload: string): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return base64UrlEncode(signature.slice(0, MAC_BYTES));
}

/** The key of the feedback links (64 hex characters), or null. */
export function feedbackKey(hex: string | undefined): Promise<CryptoKey | null> {
  return importHmacKeyHex((hex ?? '').trim());
}

/** A link's token for a vote on an item, valid FEEDBACK_TTL_MS from `now`. */
export async function signFeedback(key: CryptoKey, claim: FeedbackClaim, now: number): Promise<string> {
  const expiry = Math.floor((now + FEEDBACK_TTL_MS) / 1000);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify([claim.issue, claim.item, claim.vote, expiry])));
  return `${payload}.${await mac(key, payload)}`;
}

/** The claim of a token this key signed that has not expired, or null (never throws). */
export async function verifyFeedback(key: CryptoKey, token: string, now: number): Promise<FeedbackClaim | null> {
  if (token.length === 0 || token.length > TOKEN_MAX) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let expected: string;
  try {
    expected = await mac(key, payload);
  } catch {
    return null;
  }
  if (!constantTimeEqual(token.slice(dot + 1), expected)) return null;
  const bytes = base64UrlDecode(payload);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [issue, item, vote, expiry] = value as unknown[];
  if (typeof issue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(issue)) return null;
  if (typeof item !== 'string' || !/^(?:[rw]\d{1,2}|deep)$/.test(item)) return null;
  if (typeof vote !== 'string' || !(VOTES as readonly string[]).includes(vote)) return null;
  if (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry * 1000 <= now) return null;
  return { issue, item, vote: vote as VoteName };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

const PAGE_STYLE =
  'body{margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;font-size:17px;line-height:1.7;background:#f4f4f6;color:#24252b}' +
  'main{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:20px}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #c9cad1;background:#f0f1f5;color:#24252b}' +
  '@media (prefers-color-scheme:dark){body{background:#16171a;color:#e6e6e9}main{background:#1f2024}button{background:#2a2b31;color:#e6e6e9;border-color:#45464f}}';

function page(body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>简报反馈</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** The GET page: the item's title and one button that posts the token back. */
export function confirmPage(title: string, vote: VoteName, token: string): string {
  return page(`<p>${escapeHtml(title)}</p><form method="post" action="/feedback"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">${VOTE_WORDS[vote].button}</button></form>`);
}

/** The page after the vote was recorded. */
export function recordedPage(title: string, vote: VoteName): string {
  return page(`<p>${escapeHtml(title)}</p><p>已记下 ${escapeHtml(VOTE_WORDS[vote].emoji)}。</p>`);
}

/** The headers of every feedback answer. */
export const FEEDBACK_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
