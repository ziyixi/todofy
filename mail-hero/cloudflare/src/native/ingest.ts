import type { Env } from './types.ts';
import { enqueue, reserveIngress } from './pipeline.ts';

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
  let mode = 'archive';
  let revision = '';
  let policyError = '';
  let capacityExceeded = false;
  try {
    const policy = await env.DB.prepare(`SELECT s.mode, r.id AS revision_id, s.logical_bytes, s.logical_limit_bytes
      FROM app_settings s LEFT JOIN webhook_endpoints e ON e.id=s.current_endpoint_id
      LEFT JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE s.id=1`).first<{
        mode: string; revision_id: string | null; logical_bytes: number; logical_limit_bytes: number;
      }>();
    if (!policy) throw new Error('settings_missing');
    if (policy.logical_bytes + message.rawSize > policy.logical_limit_bytes) {
      // Do not permanently reject mail for a recoverable capacity problem.
      capacityExceeded = true;
    }
    if (policy.mode === 'forward' && policy.revision_id) {
      mode = 'forward';
      revision = policy.revision_id;
    }
  } catch {
    // Preserve mail during a database outage, but never retroactively forward it.
    policyError = 'policy_unavailable';
  }
  if (capacityExceeded) throw new Error('logical_capacity');
  const key = `raw/${id}.eml`;
  // Register BEFORE accepting raw: every successful R2 write has durable work
  // scheduled, even when the post-write notification is lost.
  await reserveIngress(env, key, message.rawSize);
  const fixed = new FixedLengthStream(message.rawSize);
  const abort = new AbortController();
  const pipe = message.raw.pipeTo(fixed.writable, { signal: abort.signal });
  const put = env.MAIL_STORE.put(key, fixed.readable, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: {
      from: message.from, to: message.to, received_at: new Date().toISOString(),
      raw_size: String(message.rawSize), mode, revision, policy_error: policyError,
    },
    onlyIf: { etagDoesNotMatch: '*' },
  }).then(value => { if (!value) { abort.abort(); void fixed.readable.cancel().catch(() => undefined); } return value; }, error => { abort.abort(); void fixed.readable.cancel().catch(() => undefined); throw error; });
  // Both promises are observed even if either fails. A truncated raw stream must
  // never become a successful receipt. No waitUntil for the durable write.
  const result = await Promise.allSettled([pipe, put]);
  if (result.some(item => item.status === 'rejected') || (result[1].status === 'fulfilled' && !result[1].value)) {
    throw new Error('raw_storage_failed');
  }
  // Job registration is already durable. A failed wake only adds alarm latency.
  ctx.waitUntil(enqueue(env, { type: 'parse', key }).catch(() => undefined));
}
