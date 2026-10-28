import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler, ProtocolError } from '@modelcontextprotocol/server';
import { asciiLowerCase, withPrivateHeaders } from '@ziyixi/edge-auth';
import { authenticate } from './auth.ts';
import { createServer, EVENT_NAMES, TEST_EVENT_NAME, WORK_EVENT_NAME, type EventName, type GateApi, type SubscribeParams, type UnsubscribeParams } from './server.ts';
import { baselineSource, pollSource, SOURCE_NAMES, type SourceEvent, type SourceName, type SourceState } from './events.ts';
import type { Env } from './env.ts';
import { postSigned, validateCallback, verifyCallback } from './webhook.ts';
import { buildOpsStatus } from './ops.ts';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { WorkStore, type WorkAttention } from './work-store.ts';
import { WorkWatchSource } from './watch-events.ts';

type Subscription = {
  id: string; owner: string; name: EventName; arguments: string; url: string; secret: string; expires_at: number | null; verified_at: number;
};
type SourceRow = { name: SourceName; state: string; checked_at: number; error_code: string | null };
type Delivery = { subscription_id: string; event_id: string; body: string; attempts: number };
type SubscriptionRequest = {
  method: 'events/subscribe';
  phase: 'received' | 'accepted' | 'rejected';
  event_name?: EventName;
  ttl_ms?: number | null;
  delivery_mode?: 'webhook' | 'poll' | 'push';
  callback_hostname?: string;
  http_status?: number;
  rpc_code?: number;
  reason?: string;
};
const DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const RETRY_MS = [60_000, 300_000];
const SOURCE_INTERVAL_MS = 60_000;

export class SubscriptionStore extends DurableObject<Env> implements GateApi {
  readonly work: WorkStore;
  private readonly workWatches: WorkWatchSource;

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
      CREATE TABLE IF NOT EXISTS event_sources (name TEXT PRIMARY KEY, state TEXT NOT NULL, checked_at INTEGER NOT NULL, error_code TEXT);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, accepted_at INTEGER, error_code TEXT,
        PRIMARY KEY(subscription_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(state, next_at);
      CREATE TABLE IF NOT EXISTS delivery_totals (state TEXT PRIMARY KEY, count INTEGER NOT NULL);
    `);
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(subscriptions)').toArray().some(column => column.name === 'name'))
      ctx.storage.sql.exec("ALTER TABLE subscriptions ADD COLUMN name TEXT NOT NULL DEFAULT 'personal_cloud.test'");
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(subscriptions)').toArray().some(column => column.name === 'arguments'))
      ctx.storage.sql.exec("ALTER TABLE subscriptions ADD COLUMN arguments TEXT NOT NULL DEFAULT '{}'");
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
    this.work = new WorkStore(ctx.storage, attention => { this.queueWorkNotice(attention); });
    this.workWatches = new WorkWatchSource(ctx.storage, this.work, env);
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
    if (request.headers.get('Mcp-Method') === 'tools/call'
      && ['work_report', 'work_context', 'work_get'].includes(request.headers.get('Mcp-Name') ?? ''))
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    const handler = createMcpHandler(() => createServer(this, this.env.BUILD_SHA ?? 'development', this.env), {
      legacy: 'reject', responseMode: 'auto',
    });
    try {
      const response = await handler.fetch(request);
      if (attempt) await this.recordSubscriptionResponse(attempt, response);
      if (request.headers.get('Mcp-Method') === 'tools/call' && response.ok) {
        await this.ctx.storage.put('last_tool_at', Date.now());
        await this.schedulePending();
      }
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
          ...(EVENT_NAMES.includes(params.name as EventName) ? { event_name: params.name as EventName } : {}),
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
          const reason = ['callback_host_unapproved', 'challenge_failed', 'unreachable_or_timeout', 'source_unavailable'].includes(String(data.reason))
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
    const args = params.arguments.work_id ? { work_id: params.arguments.work_id } : {};
    const identity = JSON.stringify([this.owner(), params.delivery.url, params.name, args]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    return `sub_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  async subscribe(params: SubscribeParams) {
    if (params.arguments.work_id) this.work.get({ work_id: params.arguments.work_id });
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
    let baseline: SourceState | undefined;
    if (params.name === WORK_EVENT_NAME) {
      if (this.workWatches.hasLinks()) await this.workWatches.initialize();
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } else if (params.name !== TEST_EVENT_NAME && !this.activeSources().includes(params.name)) {
      const previous = this.source(params.name);
      try { baseline = await baselineSource(params.name, this.env, previous ? JSON.parse(previous.state) as SourceState : undefined); }
      catch { throw new ProtocolError(-32000, 'The event source is unavailable. Check its Home status before subscribing again.', { reason: 'source_unavailable' }); }
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO subscriptions (id, owner, name, url, secret, expires_at, verified_at, arguments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, expires_at=excluded.expires_at, verified_at=excluded.verified_at`,
      id, this.owner(), params.name, params.delivery.url, params.delivery.secret, expiresAt, verifiedAt, JSON.stringify(params.arguments));
      if (baseline) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO event_sources VALUES (?, ?, ?, NULL)', params.name, JSON.stringify(baseline), now);
      if (params.name === WORK_EVENT_NAME) this.queuePendingWork(params.arguments.work_id);
    });
    await this.schedulePending();
    return { id, refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  async unsubscribe(params: UnsubscribeParams): Promise<Record<string, never>> {
    const id = await this.subscriptionId(params);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id = ?', id);
      this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE subscription_id = ? AND state <> 'accepted'", id);
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
    const sources = this.activeSources().map(name => {
      const row = this.source(name);
      return { name, checked_at: row?.checked_at ?? null, error_code: row?.error_code ?? (row ? null : 'source_state_missing') };
    });
    const work = this.ctx.storage.sql.exec<{ open: number; waiting: number; pending_reports: number }>(`SELECT
      count(*) AS open, coalesce(sum(state='waiting'),0) AS waiting,
      (SELECT count(*) FROM work_entries e JOIN work w ON w.id=e.work_id WHERE w.state IN ('active','waiting')
        AND e.report_id IS NOT NULL AND e.seq>w.handled_through_report_seq) AS pending_reports
      FROM work WHERE state IN ('active','waiting')`).one();
    return { stage: 'work_memory', build_sha: this.env.BUILD_SHA ?? 'development', subscriptions: active,
      deliveries: Object.fromEntries(counts.map(row => [row.state, row.count])), last_delivery: last,
      sources: [...sources, ...(this.workWatches.hasLinks() ? [this.workWatches.status()] : [])],
      work: { open: work.open, waiting: work.waiting, pending_reports: work.pending_reports },
      last_tool_at: await this.ctx.storage.get<number>('last_tool_at') ?? null,
      last_subscription_at: await this.ctx.storage.get<number>('last_subscription_at') ?? null,
      last_subscription_request: await this.ctx.storage.get<SubscriptionRequest>('last_subscription_request') ?? null,
      meaning: 'accepted means ChatGPT received the webhook; it does not prove the Dot finished its work.' };
  }

  async getOpsStatus() { return buildOpsStatus(await this.status()); }

  initializeWorkSources(): Promise<void> { return this.workWatches.initialize(); }

  async refreshWorkSources(): Promise<Record<string, unknown>> {
    await this.workWatches.refresh();
    return this.workWatches.hasLinks() ? { watch: this.workWatches.status() } : {};
  }

  async emitTest(requestId: string): Promise<unknown> {
    const eventId = `test_${requestId}`;
    const previous = this.ctx.storage.sql.exec('SELECT id FROM test_events WHERE id = ?', eventId).toArray()[0];
    if (previous) return { event_id: eventId, repeated: true };
    const now = Date.now();
    const subscriptions = this.ctx.storage.sql.exec<Subscription>(
      'SELECT * FROM subscriptions WHERE owner = ? AND name = ? AND (expires_at IS NULL OR expires_at > ?)', this.owner(), TEST_EVENT_NAME, now,
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
    await this.pollSources();
    if (this.hasWorkSubscription()) await this.workWatches.refresh();
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

  private activeSources(): SourceName[] {
    return this.ctx.storage.sql.exec<{ name: SourceName }>(
      `SELECT DISTINCT name FROM subscriptions WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)
       AND name IN (SELECT value FROM json_each(?))`, this.owner(), Date.now(), JSON.stringify(SOURCE_NAMES),
    ).toArray().map(row => row.name);
  }

  private source(name: SourceName): SourceRow | undefined {
    return this.ctx.storage.sql.exec<SourceRow>('SELECT * FROM event_sources WHERE name = ?', name).toArray()[0];
  }

  /** Source progress and its frozen deliveries commit together; no business content is copied into this store. */
  private async pollSources(): Promise<void> {
    for (const name of this.activeSources()) {
      const row = this.source(name);
      if (!row || Date.now() - row.checked_at < SOURCE_INTERVAL_MS) continue;
      try {
        const result = await pollSource(name, JSON.parse(row.state) as SourceState, this.env,
          () => new Map(this.ctx.storage.sql.exec<{ task_id: string; etag: string }>(
            'SELECT task_id, etag FROM own_changes ORDER BY rowid DESC LIMIT 2000',
          ).toArray().map(task => [task.task_id, task.etag])));
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          const current = this.source(name);
          if (current?.state !== row.state || current.checked_at !== row.checked_at) return;
          for (const event of result.events) this.queueSourceEvent(event, now);
          this.ctx.storage.sql.exec('UPDATE event_sources SET state=?, checked_at=?, error_code=NULL WHERE name=?',
            JSON.stringify(result.state), now, name);
        });
      } catch (error) {
        const code = error instanceof RpcStatusError && error.status.reason === 'CURSOR_RESET_REQUIRED'
          ? 'cursor_reset_required' : 'source_unavailable';
        this.ctx.storage.sql.exec('UPDATE event_sources SET checked_at=?, error_code=? WHERE name=? AND state=? AND checked_at=?',
          Date.now(), code, name, row.state, row.checked_at);
      }
    }
  }

  private queueSourceEvent(event: SourceEvent, now: number): void {
    const body = JSON.stringify({ eventId: event.id, name: event.name, timestamp: new Date(now).toISOString(), data: event.data, cursor: null });
    const subscriptions = this.ctx.storage.sql.exec<Subscription>(
      'SELECT * FROM subscriptions WHERE owner=? AND name=? AND (expires_at IS NULL OR expires_at>?)', this.owner(), event.name, now,
    ).toArray();
    for (const sub of subscriptions) this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO deliveries (subscription_id,event_id,body,next_at) VALUES (?,?,?,?)', sub.id, event.id, body, now,
    );
  }

  private queueWorkNotice(attention: WorkAttention): void {
    const now = Date.now();
    const { event_id: eventId, timestamp, ...data } = attention;
    const body = JSON.stringify({ eventId, name: WORK_EVENT_NAME, timestamp, data, cursor: null });
    const subscriptions = this.ctx.storage.sql.exec<Subscription>(
      'SELECT * FROM subscriptions WHERE owner=? AND name=? AND (expires_at IS NULL OR expires_at>?)',
      this.owner(), WORK_EVENT_NAME, now,
    ).toArray();
    for (const sub of subscriptions) {
      const filter = JSON.parse(sub.arguments) as { work_id?: string };
      if (filter.work_id && filter.work_id !== attention.work_id) continue;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO deliveries (subscription_id,event_id,body,next_at) VALUES (?,?,?,?)',
        sub.id, eventId, body, now);
    }
  }

  private queuePendingWork(workId?: string): void {
    const reports = this.ctx.storage.sql.exec<{ id: string; seq: number; kind: WorkAttention['kind'];
      source_type: WorkAttention['source']['type']; source_ref: string; created_at: string }>(`SELECT
        w.id,e.seq,e.kind,e.source_type,e.source_ref,e.created_at FROM work w JOIN work_entries e ON e.seq=w.last_report_seq
        WHERE w.state IN ('active','waiting') AND w.last_report_seq>w.handled_through_report_seq${workId ? ' AND w.id=?' : ''}`,
    ...(workId ? [workId] : [])).toArray();
    for (const report of reports) this.queueWorkNotice({ event_id: `work_${report.id}_${String(report.seq)}`,
      work_id: report.id, report_seq: report.seq, kind: report.kind, timestamp: report.created_at,
      source: { type: report.source_type, ref: report.source_ref } });
  }

  private hasWorkSubscription(): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM subscriptions WHERE owner=? AND name=? AND (expires_at IS NULL OR expires_at>?) LIMIT 1',
      this.owner(), WORK_EVENT_NAME, Date.now()).toArray().length > 0;
  }

  private async schedulePending(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ next_at: number | null }>("SELECT min(next_at) AS next_at FROM deliveries WHERE state = 'pending'").one();
    const checks = this.activeSources().map(name => this.source(name)?.checked_at ?? Date.now());
    if (this.hasWorkSubscription() && this.workWatches.hasLinks()) checks.push(this.workWatches.status().checked_at ?? Date.now());
    const sourceAt = checks.length ? Math.min(...checks) + SOURCE_INTERVAL_MS : null;
    const next = [row.next_at, sourceAt].filter((value): value is number => value !== null);
    if (!next.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...next)));
  }
}
