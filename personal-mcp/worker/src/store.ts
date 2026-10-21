import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler, ProtocolError } from '@modelcontextprotocol/server';
import { asciiLowerCase, withPrivateHeaders } from '@ziyixi/edge-auth';
import { authenticate } from './auth.ts';
import { createServer, TEST_EVENT_NAME, type GateApi, type SubscribeParams, type UnsubscribeParams } from './server.ts';
import type { Env } from './env.ts';
import { postSigned, validateCallback, verifyCallback } from './webhook.ts';
import { buildOpsStatus } from './ops.ts';

type Subscription = {
  id: string; owner: string; url: string; secret: string; expires_at: number | null; verified_at: number;
};
type Delivery = { subscription_id: string; event_id: string; body: string; attempts: number };
type SubscriptionRequest = {
  method: 'events/subscribe';
  phase: 'received' | 'accepted' | 'rejected';
  event_name?: typeof TEST_EVENT_NAME;
  ttl_ms?: number | null;
  delivery_mode?: 'webhook' | 'poll' | 'push';
  callback_hostname?: string;
  http_status?: number;
  rpc_code?: number;
  reason?: string;
};
const DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const RETRY_MS = [60_000, 300_000];

export class SubscriptionStore extends DurableObject<Env> implements GateApi {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const hasTotals = ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_totals'").toArray().length > 0;
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
        expires_at INTEGER, verified_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS test_events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS step_batches (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, identities TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS own_changes (task_id TEXT PRIMARY KEY, etag TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, accepted_at INTEGER, error_code TEXT,
        PRIMARY KEY(subscription_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(state, next_at);
      CREATE TABLE IF NOT EXISTS delivery_totals (state TEXT PRIMARY KEY, count INTEGER NOT NULL);
    `);
    if (!hasTotals) ctx.storage.sql.exec(`INSERT INTO delivery_totals SELECT state, count(*) FROM deliveries GROUP BY state`);
    ctx.storage.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS delivery_insert AFTER INSERT ON deliveries BEGIN
        INSERT INTO delivery_totals VALUES (NEW.state, 1) ON CONFLICT(state) DO UPDATE SET count=count+1;
      END;
      CREATE TRIGGER IF NOT EXISTS delivery_delete AFTER DELETE ON deliveries BEGIN
        UPDATE delivery_totals SET count=count-1 WHERE state=OLD.state;
      END;
      CREATE TRIGGER IF NOT EXISTS delivery_state AFTER UPDATE OF state ON deliveries WHEN OLD.state<>NEW.state BEGIN
        UPDATE delivery_totals SET count=count-1 WHERE state=OLD.state;
        INSERT INTO delivery_totals VALUES (NEW.state, 1) ON CONFLICT(state) DO UPDATE SET count=count+1;
      END;
    `);
    void ctx.blockConcurrencyWhile(async () => { await ctx.storage.delete('last_event_request'); });
  }

  override async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const local = this.env.DEV_AUTH_BYPASS === 'true' && !request.headers.has('cf-ray')
      && new URL(request.url).hostname === '127.0.0.1';
    if (origin && origin !== `https://${this.env.PUBLIC_HOST}` && !local) return new Response('Forbidden origin', { status: 403 });
    const auth = await authenticate(request, this.env);
    if (!auth.ok) return withPrivateHeaders(Response.json({ error: auth.failure }, {
      status: ['not_configured', 'keys_unavailable'].includes(auth.failure) ? 503 : 401,
    }));
    const attempt = request.headers.get('Mcp-Method') === 'events/subscribe'
      ? await this.recordSubscriptionRequest(request) : undefined;
    const handler = createMcpHandler(() => createServer(this, this.env.BUILD_SHA ?? 'development', this.env), {
      legacy: 'reject', responseMode: 'auto',
    });
    try {
      const response = await handler.fetch(request);
      if (attempt) await this.recordSubscriptionResponse(attempt, response);
      if (request.headers.get('Mcp-Method') === 'tools/call' && response.ok) await this.ctx.storage.put('last_tool_at', Date.now());
      return withPrivateHeaders(response);
    } catch (error) {
      if (attempt) await this.ctx.storage.put('last_subscription_request', { ...attempt, phase: 'rejected', reason: 'handler_failed' });
      throw error;
    }
    finally { await handler.close(); }
  }

  private async recordSubscriptionRequest(request: Request): Promise<SubscriptionRequest> {
    let attempt: SubscriptionRequest = { method: 'events/subscribe', phase: 'received' };
    try {
      const body: unknown = await request.clone().json();
      if (typeof body === 'object' && body !== null && 'params' in body
        && typeof body.params === 'object' && body.params !== null) {
        const params = body.params as Record<string, unknown>;
        const delivery = typeof params.delivery === 'object' && params.delivery !== null
          ? params.delivery as Record<string, unknown> : {};
        attempt = {
          ...attempt,
          ...(params.name === TEST_EVENT_NAME ? { event_name: TEST_EVENT_NAME } : {}),
          ...(params.ttlMs === null || typeof params.ttlMs === 'number' && Number.isFinite(params.ttlMs)
            ? { ttl_ms: params.ttlMs } : {}),
          ...(delivery.mode === 'webhook' || delivery.mode === 'poll' || delivery.mode === 'push'
            ? { delivery_mode: delivery.mode } : {}),
        };
        if (typeof delivery.url === 'string') attempt = { ...attempt, callback_hostname: new URL(delivery.url).hostname };
      }
    } catch {
      // Malformed input still reaches the SDK; diagnostics retain only the safe fields already extracted.
    }
    await this.ctx.storage.put('last_subscription_request', attempt);
    return attempt;
  }

  private async recordSubscriptionResponse(attempt: SubscriptionRequest, response: Response): Promise<void> {
    let result: SubscriptionRequest = { ...attempt, phase: 'rejected', http_status: response.status, reason: 'invalid_response' };
    try {
      const reply: unknown = await response.clone().json();
      if (typeof reply === 'object' && reply !== null) {
        if ('error' in reply && typeof reply.error === 'object' && reply.error !== null) {
          const error = reply.error as Record<string, unknown>;
          const data = typeof error.data === 'object' && error.data !== null ? error.data as Record<string, unknown> : {};
          const reason = ['callback_host_unapproved', 'challenge_failed', 'unreachable_or_timeout'].includes(String(data.reason))
            ? String(data.reason) : error.code === -32602 ? 'invalid_params' : 'protocol_error';
          result = { ...result, reason, ...(typeof error.code === 'number' ? { rpc_code: error.code } : {}) };
        } else if (response.ok && 'result' in reply) result = { ...attempt, phase: 'accepted', http_status: response.status };
      }
    } catch {
      // Do not retain response text or exception details, which may contain callback credentials.
    }
    await this.ctx.storage.put('last_subscription_request', result);
    if (result.phase === 'accepted') await this.ctx.storage.put('last_subscription_at', Date.now());
  }

  async planSteps(requestId: string, input: string, count: number): Promise<readonly { taskId: string; requestId: string }[]> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const inputHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.sql.exec<{ input_hash: string; identities: string }>(
        'SELECT input_hash, identities FROM step_batches WHERE request_id = ?', requestId,
      ).toArray()[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw new ProtocolError(-32602, 'Request ID already used for different Steps.');
        return JSON.parse(previous.identities) as { taskId: string; requestId: string }[];
      }
      const identities = Array.from({ length: count }, () => ({ taskId: crypto.randomUUID(), requestId: crypto.randomUUID() }));
      this.ctx.storage.sql.exec('INSERT INTO step_batches VALUES (?, ?, ?)', requestId, inputHash, JSON.stringify(identities));
      return identities;
    });
  }

  rememberTask(id: string, etag: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO own_changes VALUES (?, ?)', id, etag);
    return Promise.resolve();
  }

  private owner(): string {
    return asciiLowerCase(this.env.ACCESS_OWNER?.trim() ?? 'owner@example.org');
  }

  private async subscriptionId(params: UnsubscribeParams): Promise<string> {
    // The sole event has no arguments, so its canonical identity has no key-order ambiguity.
    const identity = JSON.stringify([this.owner(), params.delivery.url, params.name, {}]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    return `sub_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  async subscribe(params: SubscribeParams) {
    validateCallback(params.delivery.url, params.delivery.secret, this.env.CALLBACK_HOSTS);
    const id = await this.subscriptionId(params);
    const existing = this.ctx.storage.sql.exec<Subscription>('SELECT * FROM subscriptions WHERE id = ?', id).toArray()[0];
    const now = Date.now();
    let verifiedAt = existing?.verified_at ?? 0;
    if (!existing || existing.secret !== params.delivery.secret || now - existing.verified_at > 600_000) {
      await verifyCallback({ id, url: params.delivery.url, secret: params.delivery.secret });
      verifiedAt = Date.now();
    }
    const expiresAt = params.ttlMs === null ? null : now + (params.ttlMs ?? DEFAULT_LIFETIME_MS);
    this.ctx.storage.sql.exec(`INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, expires_at=excluded.expires_at, verified_at=excluded.verified_at`,
    id, this.owner(), params.delivery.url, params.delivery.secret, expiresAt, verifiedAt);
    return { id, refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  async unsubscribe(params: UnsubscribeParams): Promise<Record<string, never>> {
    const id = await this.subscriptionId(params);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id = ?', id);
      this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE subscription_id = ? AND state = 'pending'", id);
    });
    await this.schedulePending();
    return {};
  }

  async status() {
    const now = Date.now();
    const active = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT count(*) AS count FROM subscriptions WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)', this.owner(), now,
    ).one().count;
    const counts = this.ctx.storage.sql.exec<{ state: string; count: number }>('SELECT state, count FROM delivery_totals').toArray();
    const last = this.ctx.storage.sql.exec<{ event_id: string; state: string; attempts: number; accepted_at: number | null; error_code: string | null; event_at: string }>(
      "SELECT event_id, state, attempts, accepted_at, error_code, json_extract(body, '$.timestamp') AS event_at FROM deliveries ORDER BY rowid DESC LIMIT 1",
    ).toArray()[0] ?? null;
    return { stage: 'connection_test', build_sha: this.env.BUILD_SHA ?? 'development', subscriptions: active,
      deliveries: Object.fromEntries(counts.map(row => [row.state, row.count])), last_delivery: last,
      last_tool_at: await this.ctx.storage.get<number>('last_tool_at') ?? null,
      last_subscription_at: await this.ctx.storage.get<number>('last_subscription_at') ?? null,
      last_subscription_request: await this.ctx.storage.get<SubscriptionRequest>('last_subscription_request') ?? null,
      meaning: 'accepted means ChatGPT received the webhook; it does not prove the Dot finished its work.' };
  }

  async getOpsStatus() { return buildOpsStatus(await this.status()); }

  async emitTest(requestId: string): Promise<unknown> {
    const eventId = `test_${requestId}`;
    const previous = this.ctx.storage.sql.exec('SELECT id FROM test_events WHERE id = ?', eventId).toArray()[0];
    if (previous) return { event_id: eventId, repeated: true };
    const now = Date.now();
    const subscriptions = this.ctx.storage.sql.exec<Subscription>(
      'SELECT * FROM subscriptions WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)', this.owner(), now,
    ).toArray();
    if (!subscriptions.length) throw new ProtocolError(-32602, 'Subscribe to personal_cloud.test first.');
    const body = JSON.stringify({ eventId, name: 'personal_cloud.test', timestamp: new Date(now).toISOString(),
      data: { message: 'Personal MCP connection test', build_sha: this.env.BUILD_SHA ?? 'development' }, cursor: null });
    await this.ctx.storage.setAlarm(now + 1000);
    const repeated = this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT id FROM test_events WHERE id = ?', eventId).toArray().length) {
        return true;
      }
      this.ctx.storage.sql.exec('INSERT INTO test_events VALUES (?)', eventId);
      for (const sub of subscriptions) {
        this.ctx.storage.sql.exec('INSERT INTO deliveries (subscription_id, event_id, body, next_at) VALUES (?, ?, ?, ?)', sub.id, eventId, body, now);
      }
      return false;
    });
    return repeated ? { event_id: eventId, repeated: true } : { event_id: eventId, queued: subscriptions.length };
  }

  override async alarm(): Promise<void> {
    const pending = this.ctx.storage.sql.exec<Delivery>(
      "SELECT subscription_id, event_id, body, attempts FROM deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 5", Date.now(),
    ).toArray();
    for (const delivery of pending) {
      const sub = this.ctx.storage.sql.exec<Subscription>('SELECT * FROM subscriptions WHERE id = ?', delivery.subscription_id).toArray()[0];
      if (!sub || sub.owner !== this.owner() || (sub.expires_at !== null && sub.expires_at <= Date.now())) {
        this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE subscription_id = ? AND event_id = ?', delivery.subscription_id, delivery.event_id);
        continue;
      }
      let code = 'callback_unreachable';
      let accepted = false;
      let retry = true;
      try {
        validateCallback(sub.url, sub.secret, this.env.CALLBACK_HOSTS);
        const response = await postSigned(sub, delivery.event_id, delivery.body);
        accepted = response.ok;
        code = accepted ? '' : `callback_http_${String(response.status)}`;
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
        await response.body?.cancel();
      } catch (error) {
        if (error instanceof ProtocolError) { code = 'callback_host_unapproved'; retry = false; }
      }
      const attempts = delivery.attempts + 1;
      const delay = RETRY_MS[attempts - 1];
      const state = accepted ? 'accepted' : retry && delay !== undefined ? 'pending' : 'failed';
      this.ctx.storage.sql.exec(`UPDATE deliveries SET state=?, attempts=?, next_at=?, accepted_at=?, error_code=?
        WHERE subscription_id=? AND event_id=?`, state, attempts, Date.now() + (delay ?? 0), accepted ? Date.now() : null,
      code || null, sub.id, delivery.event_id);
    }
    await this.schedulePending();
  }

  private async schedulePending(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ next_at: number | null }>("SELECT min(next_at) AS next_at FROM deliveries WHERE state = 'pending'").one();
    if (row.next_at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, row.next_at));
  }
}
