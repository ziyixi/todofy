/**
 * The only code that calls Resend, through the delivery ledger (../../docs/design.md §12; the newsletter's lessons):
 *
 * - One send per day: `sends.issue` is the primary key, the idempotency key `brief-<date>` is unique, and the render's
 *   hash is frozen with the row. A quiet day's note is that day's one send.
 * - Reserve first: the row, state `submitting`, commits before the request, and the request carries exactly the frozen
 *   render.
 * - One attempt: `POST https://api.resend.com/emails` with `Idempotency-Key`, 30 s, no redirect, no client retry.
 * - Outcomes: a 2xx with a message ID is `accepted` (Resend took it: not proof of inbox delivery); a 4xx other than
 *   408, 409 and 429 is `rejected` (not sent, never retried); anything else is `unknown`: no answer, a timeout, 408,
 *   409 (Resend's answer while the same key is in flight), 429, a 5xx, a redirect, a malformed 2xx, an exception, or a
 *   `submitting` row a later alarm finds after a crash. An unknown send is never made again: not with a new key, not
 *   after deleting the row, not after a deploy.
 *
 * Tests use a fake Resend on loopback; no test or verification send ever goes to Resend from production.
 */
import type { FetchFn } from './fetch/net.ts';
import { RESEND_TIMEOUT_MS, RESEND_URL } from './limits.ts';
import type { SendRow, Store } from './store.ts';

export type SendOutcome = 'accepted' | 'rejected' | 'unknown';

export interface Mail {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

export interface FrozenEmail {
  readonly issue: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly hash: string;
}

/** The idempotency key of a day's send. */
export function idempotencyKey(issue: string): string {
  return `brief-${issue}`;
}

/** The ledger's mapping of an HTTP answer (status 0: no answer or an exception). */
export function classify(status: number, body: unknown): { outcome: SendOutcome; messageId: string } {
  if (status >= 200 && status < 300) {
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id) ? { outcome: 'accepted', messageId: id } : { outcome: 'unknown', messageId: '' };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return { outcome: 'rejected', messageId: '' };
  return { outcome: 'unknown', messageId: '' };
}

/** A send row that a previous invocation left `submitting` becomes unknown (a crash or a deploy during the request). */
export function settleSubmitting(store: Store, now: number): number {
  const rows = store.all<{ issue: string }>(`SELECT issue FROM sends WHERE state = 'submitting'`);
  for (const row of rows) {
    store.run(`UPDATE sends SET state = 'unknown', finished_ms = ? WHERE issue = ?`, now, row.issue);
    store.run(`UPDATE issues SET state = 'send_unknown', error_code = 'send_crashed' WHERE issue = ?`, row.issue);
    store.pushError('send_unknown');
  }
  return rows.length;
}

/** The ledger row of a day, or null. */
export function sendRow(store: Store, issue: string): SendRow | null {
  return store.one<SendRow>(`SELECT * FROM sends WHERE issue = ?`, issue) ?? null;
}

/**
 * Sends a frozen email once: reserves the row, makes the one request, records the outcome. A day with a ledger row
 * already answers that row's state and sends nothing.
 */
export async function sendOnce(store: Store, transact: <T>(fn: () => T) => T, fetchFn: FetchFn, mail: Mail, email: FrozenEmail, now: () => number): Promise<{ outcome: SendOutcome; status: number; fresh: boolean }> {
  const reserved = transact(() => {
    const existing = sendRow(store, email.issue);
    if (existing !== null) return existing;
    store.insert('sends', { issue: email.issue, idempotency_key: idempotencyKey(email.issue), render_hash: email.hash, state: 'submitting', created_ms: now() });
    store.run(`UPDATE issues SET send_ms = ? WHERE issue = ?`, now(), email.issue);
    return null;
  });
  if (reserved !== null) {
    const outcome: SendOutcome = reserved.state === 'accepted' ? 'accepted' : reserved.state === 'rejected' ? 'rejected' : 'unknown';
    return { outcome, status: reserved.status, fresh: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, RESEND_TIMEOUT_MS);
  let status = 0;
  let body: unknown = null;
  try {
    const response = await fetchFn(
      new Request(RESEND_URL, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { authorization: `Bearer ${mail.key}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey(email.issue) },
        body: JSON.stringify({ from: mail.from, to: [mail.to], subject: email.subject, html: email.html, text: email.text }),
      }),
    );
    status = response.status;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } catch {
    status = 0;
  } finally {
    clearTimeout(timer);
  }
  const { outcome, messageId } = classify(status, body);
  transact(() => {
    store.run(`UPDATE sends SET state = ?, status = ?, message_id = ?, finished_ms = ? WHERE issue = ?`, outcome, status, messageId, now(), email.issue);
    const state = outcome === 'accepted' ? 'sent' : outcome === 'rejected' ? 'send_rejected' : 'send_unknown';
    // A failed send's code replaces the issue's; an accepted one keeps it (a note's reason, a fallback).
    if (outcome === 'accepted') store.run(`UPDATE issues SET state = ? WHERE issue = ?`, state, email.issue);
    else store.run(`UPDATE issues SET state = ?, error_code = ? WHERE issue = ?`, state, `resend_${String(status)}`, email.issue);
    if (outcome !== 'accepted') store.pushError(outcome === 'rejected' ? 'send_rejected' : 'send_unknown');
  });
  // The request ID is Resend's message ID; status and outcome only.
  console.log(JSON.stringify({ event: 'send', issue: email.issue, status, outcome }));
  return { outcome, status, fresh: true };
}
