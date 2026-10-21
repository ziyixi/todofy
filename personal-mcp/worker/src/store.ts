import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler, ProtocolError } from '@modelcontextprotocol/server';
import { asciiLowerCase, withPrivateHeaders } from '@ziyixi/edge-auth';
import { authenticate } from './auth.ts';
import { createServer, type GateApi, type SubscribeParams, type UnsubscribeParams } from './server.ts';
import type { Env } from './env.ts';
import { postSigned, validateCallback, verifyCallback } from './webhook.ts';

type Subscription = {
  id: string; owner: string; url: string; secret: string; expires_at: number | null; verified_at: number;
};
type Delivery = { subscription_id: string; event_id: string; body: string; attempts: number };
const DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const RETRY_MS = [60_000, 300_000];

export class SubscriptionStore extends DurableObject<Env> implements GateApi {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
        expires_at INTEGER, verified_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS test_events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, accepted_at INTEGER, error_code TEXT,
        PRIMARY KEY(subscription_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(state, next_at);
    `);
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
    const handler = createMcpHandler(() => createServer(this, this.env.BUILD_SHA ?? 'development'), {
      legacy: 'reject', responseMode: 'auto',
    });
    try { return withPrivateHeaders(await handler.fetch(request)); }
    finally { await handler.close(); }
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

  status(): Promise<unknown> {
    const now = Date.now();
    const active = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT count(*) AS count FROM subscriptions WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)', this.owner(), now,
    ).one().count;
    const counts = this.ctx.storage.sql.exec<{ state: string; count: number }>('SELECT state, count(*) AS count FROM deliveries GROUP BY state').toArray();
    const last = this.ctx.storage.sql.exec<{ event_id: string; state: string; attempts: number; accepted_at: number | null; error_code: string | null }>(
      'SELECT event_id, state, attempts, accepted_at, error_code FROM deliveries ORDER BY rowid DESC LIMIT 1',
    ).toArray()[0] ?? null;
    return Promise.resolve({ stage: 'connection_test', build_sha: this.env.BUILD_SHA ?? 'development', subscriptions: active,
      deliveries: Object.fromEntries(counts.map(row => [row.state, row.count])), last_delivery: last,
      meaning: 'accepted means ChatGPT received the webhook; it does not prove the Dot finished its work.' });
  }

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
