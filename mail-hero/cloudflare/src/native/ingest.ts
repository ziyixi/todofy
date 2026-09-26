import type { Env } from './types.ts';
import { enqueue } from './pipeline.ts';
import { coordinatorRequest } from './capacity.ts';

export const MAX_RAW_BYTES = 25 * 1024 * 1024;
export const RAW_KEY = /^raw\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.eml$/i;

/** The R2 object is the durable receipt. The scheduler and D1 are repairable indexes. */
export async function emailHandler(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  if (env.MAINTENANCE_MODE === 'true') throw new Error('maintenance');
  if (message.to.toLowerCase() !== env.RECEIVE_ADDRESS.toLowerCase()) {
    message.setReject('Unknown recipient');
    return;
  }
  if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 1 || message.rawSize > MAX_RAW_BYTES) {
    message.setReject('Message size exceeds limit');
    return;
  }
  const id = crypto.randomUUID();
  const key = `raw/${id}.eml`;
  // Register BEFORE accepting raw: every successful R2 write has durable work
  // scheduled, even when the post-write notification is lost.
  const reservation = await coordinatorRequest(env, '/reserve-ingest', { key, size: message.rawSize });
  if (!reservation.ok) throw new Error(reservation.status === 429 ? 'logical_or_daily_capacity' : 'scheduler_unavailable');
  const policy = await reservation.json() as Record<string, unknown>;
  if (!Number.isSafeInteger(policy.ingest_seq) || Number(policy.ingest_seq) < 1 || !['archive', 'forward'].includes(String(policy.mode))) throw new Error('invalid_intake_reservation');
  const lifecycle: Record<string, string> = {};
  for (const name of ['lifecycle_policy_version', 'raw_retention_days', 'content_retention_days', 'ledger_retention_days']) {
    if (Number.isSafeInteger(policy[name]) && Number(policy[name]) > 0) lifecycle[name] = String(policy[name]);
  }
  const fixed = new FixedLengthStream(message.rawSize);
  const abort = new AbortController();
  const pipe = message.raw.pipeTo(fixed.writable, { signal: abort.signal });
  const put = env.MAIL_STORE.put(key, fixed.readable, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: {
      from: message.from, to: message.to, received_at: new Date().toISOString(),
      raw_size: String(message.rawSize), mode: String(policy.mode), revision: String(policy.revision ?? ''),
      policy_error: String(policy.policy_error ?? ''), ingest_seq: String(policy.ingest_seq), ...lifecycle,
    },
    onlyIf: { etagDoesNotMatch: '*' },
  }).then(value => { if (!value) { abort.abort(); void fixed.readable.cancel().catch(() => undefined); } return value; }, error => { abort.abort(); void fixed.readable.cancel().catch(() => undefined); throw error; });
  // Both promises are observed even if either fails. A truncated raw stream must
  // never become a successful receipt. No waitUntil for the durable write.
  const result = await Promise.allSettled([pipe, put]);
  if (result.some(item => item.status === 'rejected') || (result[1].status === 'fulfilled' && !result[1].value)) {
    // The DO checks R2 before releasing. An uncertain successful PUT retains
    // both its receipt and reservation; a confirmed absent object releases once.
    await coordinatorRequest(env, '/ingest/settle', { key, saved: false }).catch(() => undefined);
    throw new Error('raw_storage_failed');
  }
  await coordinatorRequest(env, '/ingest/settle', { key, saved: true }).catch(() => undefined);
  // Job registration is already durable. A failed wake only adds alarm latency.
  ctx.waitUntil(enqueue(env, { type: 'parse', key }).catch(() => undefined));
}
