/**
 * Direct unit tests on Node's SQLite (./fakes/sql.ts) and FakeGmail for the core worker modules:
 * auth.ts, http.ts, reasons.ts, classification-result.ts, label-identity.ts, feedback.ts, session.ts, and writes.ts.
 */
import { describe, expect, it } from 'vitest';
import { accessPolicy, allowedOrigins, authenticate, checkCsrf, JWKS_REFRESH_COOLDOWN_MS, JWKS_TTL_MS, NBF_LEEWAY_SECONDS } from '../src/auth.ts';
import { classificationItems } from '../src/classification-result.ts';
import type { Env } from '../src/env.ts';
import { applyFeedback, setCurrentLabels, setVerdict, withdrawVerdict } from '../src/feedback.ts';
import { GmailRefused, GoogleError, SCOPE_MODIFY, type GmailClient } from '../src/gmail.ts';
import { handleRequest, newRequestId } from '../src/http.ts';
import { canonicalDecision, canonicalReview, effectiveLedgerRow, isMergeFeedback } from '../src/label-identity.ts';
import { AUTH_FAILURES_STOP, MAX_BODY_BYTES, WRITE_ATTEMPTS_MAX } from '../src/limits.ts';
import { PRIORITY_LABELS } from '../src/priority.ts';
import { API_DOMAIN, errorResponse, isReason, localize, REASONS, sortError } from '../src/reasons.ts';
import { authState, Budget, configured, noteGoogleError, noteTokenOk, openSession, writeScope } from '../src/session.ts';
import { Store } from '../src/store.ts';
import {
  abandonInFlight,
  alreadyLabelled,
  ensureGmailLabel,
  executeWrites,
  hasSublabels,
  intend,
  intendUndo,
  isOwnParent,
  labelCreationCost,
  linkGmailLabel,
  mailChanged,
  setNameTaken,
  undoable,
  userLabelsByName,
  type WriteContext,
} from '../src/writes.ts';
import { FakeGmail } from './fakes/fake-gmail.ts';
import { MAILS, message } from './fakes/fixtures.ts';
import { memorySql } from './fakes/sql.ts';

const T0 = Date.parse('2026-10-01T00:00:00Z');

function createStore(): Store {
  const store = new Store(memorySql());
  store.migrate();
  return store;
}

function seedPriorityStore(): { store: Store; gmail: FakeGmail } {
  const store = createStore();
  const gmail = new FakeGmail();
  for (const [i, item] of PRIORITY_LABELS.entries()) {
    const gmailId = gmail.createUserLabel(item.displayName, true);
    store.run(
      `INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`,
      item.id,
      i + 1,
      item.displayName,
      item.description,
      gmailId,
      item.keepInInbox ? 1 : 0,
      T0,
      T0,
    );
  }
  store.setMeta('priority_started_at', String(T0));
  return { store, gmail };
}

describe('reasons.ts and classification-result.ts', () => {
  it('maps error reasons, localizes known codes, and builds error responses with custom headers and HEAD support', async () => {
    expect(isReason('ETAG_MISMATCH')).toBe(true);
    expect(isReason('NOT_A_REASON')).toBe(false);
    expect(localize('ETAG_MISMATCH')).toEqual({ locale: 'zh-CN', message: REASONS.ETAG_MISMATCH.zh });
    expect(localize('UNKNOWN')).toBeUndefined();

    const err = sortError('METHOD_NOT_ALLOWED');
    err.headers['allow'] = 'GET, HEAD';
    const getResp = errorResponse(err, 'req-123', false);
    expect(getResp.status).toBe(err.httpStatus);
    expect(getResp.headers.get('allow')).toBe('GET, HEAD');
    expect(getResp.headers.get('cache-control')).toBe('no-store');
    const body = (await getResp.json()) as { error: { details: { domain?: string; metadata?: { request_id?: string } }[] } };
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: API_DOMAIN, metadata: { request_id: 'req-123' } }),
      ]),
    );

    const headResp = errorResponse(err, 'req-123', true);
    expect(await headResp.text()).toBe('');
  });

  it('validates structured classification items strictly against the expected message IDs', () => {
    const ids = new Set(['m1', 'm2']);
    const valid = {
      items: [
        { id: 'm1', bucket: 'P1', reason: 'Urgent invoice' },
        { id: 'm2', bucket: 'P4', reason: 'Marketing digest' },
      ],
    };
    expect(classificationItems(valid, ids)).toEqual(valid.items);

    for (const invalid of [
      null,
      [],
      {},
      { items: [], extra: 1 },
      { items: 'not-array' },
      { items: [{ id: 'm1', bucket: 'P1', reason: 'Only one' }] },
      { items: [null, { id: 'm2', bucket: 'P4', reason: 'ok' }] },
      { items: [{ id: 'm1', bucket: 'P1', reason: 'ok', extra: true }, { id: 'm2', bucket: 'P4', reason: 'ok' }] },
      { items: [{ id: 'm1', bucket: 'P1', reason: 'dup' }, { id: 'm1', bucket: 'P4', reason: 'dup' }] },
      { items: [{ id: 'm1', bucket: 'P1', reason: 'ok' }, { id: 'm3', bucket: 'P4', reason: 'unknown id' }] },
      { items: [{ id: 'm1', bucket: 'P5', reason: 'bad bucket' }, { id: 'm2', bucket: 'P4', reason: 'ok' }] },
      { items: [{ id: 'm1', bucket: 'P1', reason: '   ' }, { id: 'm2', bucket: 'P4', reason: 'ok' }] },
      { items: [{ id: 'm1', bucket: 'P1', reason: 'x'.repeat(1001) }, { id: 'm2', bucket: 'P4', reason: 'ok' }] },
    ]) {
      expect(classificationItems(invalid, ids)).toBeNull();
    }
  });
});

describe('auth.ts and http.ts', () => {
  function fakeEnv(overrides: Partial<Env> = {}): Env {
    const stub = {
      fetch: async (req: Request) => Response.json({ forwarded: new URL(req.url).pathname, reqId: req.headers.get('x-mailsort-request-id') }),
      setClock: async () => {},
      step: async (now: number) => ({ next: now + 1000, code: 'ok' }),
    };
    return {
      PUBLIC_HOST: 'sort.example.com',
      ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'a'.repeat(64),
      ACCESS_OWNER: 'Owner@Example.com ',
      DEV_AUTH_BYPASS: 'true',
      DEV_MANUAL_ALARMS: 'true',
      BUILD_SHA: 'test',
      MAILSORT: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => stub as unknown as DurableObjectStub<import('../src/state.ts').MailsortState>,
      } as unknown as DurableObjectNamespace<import('../src/state.ts').MailsortState>,
      ASSETS: {
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname.startsWith('/assets/')) {
            return new Response('console.log(1)', { status: 200, headers: { 'content-type': 'application/javascript' } });
          }
          return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
      } as unknown as Fetcher,
      ...overrides,
    };
  }

  it('builds access policy, computes allowed origins, and verifies dev-bypass authentication and CSRF', async () => {
    const env = fakeEnv();
    const policy = accessPolicy(env);
    expect(policy.nbfLeewaySeconds).toBe(NBF_LEEWAY_SECONDS);
    expect(policy.jwks).toEqual({ ttlMs: JWKS_TTL_MS, refreshCooldownMs: JWKS_REFRESH_COOLDOWN_MS });
    expect(policy.devBypass).toMatchObject({ enabled: true, principal: 'owner@example.com' });

    const localUrl = new URL('http://127.0.0.1:8787/api/v2/settings');
    expect(allowedOrigins(env, localUrl, true)).toEqual(['https://sort.example.com', 'http://127.0.0.1:8787']);
    expect(allowedOrigins({ ...env, PUBLIC_HOST: 'invalid host!' }, localUrl, false)).toEqual([]);

    const authOk = await authenticate(new Request('http://127.0.0.1/api/v2/settings'), env);
    expect(authOk).toEqual({ ok: true, owner: 'owner@example.com', bypassed: true });

    const authFail = await authenticate(new Request('https://sort.example.com/api/v2/settings'), { ...env, DEV_AUTH_BYPASS: 'false' });
    expect(authFail).toEqual({ ok: false, failure: 'missing_token' });

    const validMutation = new Request('http://127.0.0.1/api/v2/settings', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(await checkCsrf(validMutation, env, true)).toBe('ok');

    const badMutation = new Request('http://127.0.0.1/api/v2/settings', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'x-csrf-token': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(await checkCsrf(badMutation, env, true)).toBe('failed');
  });

  it('routes /health, /api/csrf, /api/v1/*, /api/v2/*, /__dev/*, and static assets with private headers', async () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{16}$/);
    const env = fakeEnv();

    // /health GET, HEAD, and POST (405)
    expect((await handleRequest(new Request('http://127.0.0.1/health'), env)).status).toBe(200);
    expect((await handleRequest(new Request('http://127.0.0.1/health', { method: 'HEAD' }), env)).status).toBe(200);
    const healthPost = await handleRequest(new Request('http://127.0.0.1/health', { method: 'POST' }), env);
    expect(healthPost.status).toBe(405);
    expect(healthPost.headers.get('allow')).toBe('GET, HEAD');

    // Unauthenticated / unconfigured Access
    const unauth = await handleRequest(new Request('https://sort.example.com/api/csrf'), { ...env, DEV_AUTH_BYPASS: 'false' });
    expect(unauth.status).toBe(401);
    const unconf = await handleRequest(new Request('https://sort.example.com/api/csrf'), { ...env, DEV_AUTH_BYPASS: 'false', ACCESS_ISSUER: '' });
    expect(unconf.status).toBe(503);

    // /api/csrf GET and POST (405)
    const csrfGet = await handleRequest(new Request('http://127.0.0.1/api/csrf'), env);
    expect(await csrfGet.json()).toEqual({ token: '1' });
    const csrfPost = await handleRequest(new Request('http://127.0.0.1/api/csrf', { method: 'POST' }), env);
    expect(csrfPost.status).toBe(405);

    // /api/v1/* -> 410 RELOAD_REQUIRED
    const v1 = await handleRequest(new Request('http://127.0.0.1/api/v1/labels'), env);
    expect(v1.status).toBe(410);

    // /api/v2/* oversized body, forwarded request, and DO throw -> 503
    const tooLarge = await handleRequest(
      new Request('http://127.0.0.1/api/v2/settings', {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1',
          'x-csrf-token': '1',
          'content-type': 'application/json',
          'content-length': String(MAX_BODY_BYTES + 1),
        },
        body: '{}',
      }),
      env,
    );
    expect(tooLarge.status).toBe(400);

    const forwarded = await handleRequest(new Request('http://127.0.0.1/api/v2/settings'), env);
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toMatchObject({ forwarded: '/api/v2/settings' });

    const throwingDoEnv = fakeEnv({
      MAILSORT: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({ fetch: () => Promise.reject(new Error('DO down')) }) as unknown as DurableObjectStub<import('../src/state.ts').MailsortState>,
      } as unknown as DurableObjectNamespace<import('../src/state.ts').MailsortState>,
    });
    expect((await handleRequest(new Request('http://127.0.0.1/api/v2/settings'), throwingDoEnv)).status).toBe(503);

    // Unknown /api path -> 404
    expect((await handleRequest(new Request('http://127.0.0.1/api/unknown'), env)).status).toBe(404);

    // /__dev/clock and /__dev/step controls
    expect((await handleRequest(new Request('http://127.0.0.1/__dev/clock'), env)).status).toBe(405);
    expect((await handleRequest(new Request('http://127.0.0.1/__dev/clock?now=0', { method: 'POST' }), env)).status).toBe(400);
    expect((await handleRequest(new Request(`http://127.0.0.1/__dev/clock?now=${String(T0)}`, { method: 'POST' }), env)).status).toBe(200);
    expect((await handleRequest(new Request(`http://127.0.0.1/__dev/step?now=${String(T0)}`, { method: 'POST' }), env)).status).toBe(200);
    expect((await handleRequest(new Request(`http://127.0.0.1/__dev/other?now=${String(T0)}`, { method: 'POST' }), env)).status).toBe(404);

    // Non-GET/HEAD on UI path -> 405; hashed asset gets immutable cache-control; asset failure -> 503
    expect((await handleRequest(new Request('http://127.0.0.1/overview', { method: 'POST' }), env)).status).toBe(405);
    const asset = await handleRequest(new Request('http://127.0.0.1/assets/app-123.js'), env);
    expect(asset.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const html = await handleRequest(new Request('http://127.0.0.1/overview'), env);
    expect(html.headers.get('cache-control')).toContain('no-store');

    const brokenAssetsEnv = fakeEnv({
      ASSETS: { fetch: () => Promise.reject(new Error('assets down')) } as unknown as Fetcher,
    });
    expect((await handleRequest(new Request('http://127.0.0.1/overview'), brokenAssetsEnv)).status).toBe(503);
  });
});

describe('label-identity.ts and feedback.ts', () => {
  it('maps merged label aliases across decisions, reviews, ledger entries, and merge history windows', () => {
    const { store } = seedPriorityStore();
    store.run(`INSERT INTO labels (id, seq, display_name, gmail_state, create_time, update_time, etag) VALUES ('old-p2', 5, 'OldP2', 'pending', ?, ?, 'e')`, T0, T0);
    store.run(
      `INSERT INTO decisions (message_id, thread_id, received_at, decided_at, subject, sender, sender_domain, dmarc, outcome, label_id, top_label, confidence, probabilities, probabilities2, decider, model, current_labels, verdict_label)
       VALUES ('m1', 't1', ?, ?, 'Sub', 's@example.com', 'example.com', 1, 'applied', 'old-p2', 'old-p2', 0.8, '{"old-p2":0.6,"p2":0.2}', '{"old-p2":0.5}', 'claude', 'claude-opus-5-5', '["old-p2","p1"]', 'old-p2')`,
      T0,
      T0,
    );
    store.run(
      `INSERT INTO review (id, message_id, state, suggested_label, candidates, reason, resolved_label, create_time)
       VALUES ('r1', 'm1', 'pending', 'old-p2', '[{"label":"old-p2","probability":0.6},{"label":"p2","probability":0.2}]', 'low_confidence', 'old-p2', ?)`,
      T0,
    );
    store.run(
      `INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, base_labels, base_inbox)
       VALUES ('l1', 'm1', 'old-p2', 'Label_99', 1, 'auto', 'applied', ?, '[]', 1)`,
      T0,
    );

    // Without active aliases, rows are returned unchanged.
    const rawDecision = store.decision('m1')!;
    expect(canonicalDecision(store, rawDecision)).toBe(rawDecision);

    // Activate merge alias old-p2 -> p2.
    store.run(`INSERT INTO label_aliases (source_label_id, target_label_id, job_id, active, create_time) VALUES ('old-p2', 'p2', 'j1', 1, ?)`, T0);
    const mappedDecision = canonicalDecision(store, rawDecision);
    expect(mappedDecision).toMatchObject({
      label_id: 'p2',
      top_label: 'p2',
      verdict_label: 'p2',
      current_labels: JSON.stringify(['p2', 'p1']),
      probabilities: JSON.stringify({ p2: 0.8 }),
      probabilities2: JSON.stringify({ p2: 0.5 }),
    });

    const rawReview = store.pendingReviewOf('m1')!;
    const mappedReview = canonicalReview(store, rawReview);
    expect(mappedReview).toMatchObject({
      suggested_label: 'p2',
      resolved_label: 'p2',
      candidates: JSON.stringify([{ label: 'p2', probability: 0.8 }]),
    });

    const rawLedger = store.ledgerRow('l1')!;
    expect(effectiveLedgerRow(store, rawLedger)).toMatchObject({ label_id: 'p2', superseded: 1 });

    // Merge feedback suppression window
    store.run(
      `INSERT INTO label_merge_items (job_id, group_index, message_id, source_label_id, source_gmail_id, target_label_id, target_gmail_id, state, history_start, history_end, update_time)
       VALUES ('j1', 0, 'm1', 'old-p2', 'Label_99', 'p2', 'Label_2', 'complete', '100', '105', ?)`,
      T0,
    );
    expect(isMergeFeedback(store, { message_id: 'm1', gmail_label_id: 'Label_2', seq: 100 })).toBe(false);
    expect(isMergeFeedback(store, { message_id: 'm1', gmail_label_id: 'Label_2', seq: 103 })).toBe(true);
    expect(isMergeFeedback(store, { message_id: 'm1', gmail_label_id: 'Label_2', seq: 106 })).toBe(false);
  });

  it('records and withdraws owner verdicts from review and Gmail feedback', () => {
    const { store } = seedPriorityStore();
    store.run(
      `INSERT INTO decisions (message_id, thread_id, received_at, decided_at, subject, sender, sender_domain, dmarc, outcome, label_id, top_label, probabilities, probabilities2, decider, model, current_labels)
       VALUES ('m1', 't1', ?, ?, 'Sub', 's@example.com', 'example.com', 1, 'applied', 'p2', 'p2', '{}', '{}', 'claude', 'claude-opus-5-5', '["p2"]')`,
      T0,
      T0,
    );
    store.run(
      `INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, base_labels, base_inbox)
       VALUES ('l1', 'm1', 'p2', 'Label_2', 1, 'auto', 'applied', ?, '[]', 1)`,
      T0,
    );
    store.run(
      `INSERT INTO review (id, message_id, state, suggested_label, candidates, reason, create_time)
       VALUES ('r1', 'm1', 'pending', 'p2', '[]', 'low_confidence', ?)`,
      T0,
    );
    store.run(
      `INSERT INTO examples (id, label_id, message_id, summary, origin, create_time)
       VALUES ('e1', 'p2', 'm1', 'Summary', 'confirmation', ?)`,
      T0,
    );

    setCurrentLabels(store, 'm1', ['p2', 'p2']);
    expect(store.decision('m1')?.current_labels).toBe('["p2"]');

    // Owner corrects m1 to p1 via Gmail feedback
    const owned = new Map([
      ['Label_1', 'p1'],
      ['Label_2', 'p2'],
    ]);
    store.run(`INSERT INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES ('k1', 'm1', 'removed', 'Label_2', 1), ('k2', 'm1', 'added', 'Label_1', 2)`);
    expect(applyFeedback(store, owned, T0 + 1000)).toBe(2);
    expect(store.decision('m1')).toMatchObject({ verdict: 'corrected', verdict_label: 'p1', verdict_source: 'gmail' });
    expect(store.ledgerRow('l1')?.superseded).toBe(1);
    expect(store.one(`SELECT state, resolved_label FROM review WHERE id = 'r1'`)).toEqual({ state: 'corrected', resolved_label: 'p1' });

    // Owner restores original p2 label in Gmail -> withdraws Gmail verdict and un-supersedes ledger
    store.run(`INSERT INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES ('k3', 'm1', 'removed', 'Label_1', 3), ('k4', 'm1', 'added', 'Label_2', 4)`);
    expect(applyFeedback(store, owned, T0 + 2000)).toBe(2);
    expect(store.decision('m1')).toMatchObject({ verdict: null, verdict_label: null, verdict_source: null });
    expect(store.ledgerRow('l1')?.superseded).toBe(0);

    // Explicit null verdict deletes example
    setVerdict(store, store.decision('m1')!, null, 'review', T0 + 3000);
    expect(store.one(`SELECT id FROM examples WHERE id = 'e1'`)).toBeUndefined();
    withdrawVerdict(store, store.decision('m1')!);
    expect(store.decision('m1')?.verdict).toBeNull();
  });
});

describe('session.ts and writes.ts', () => {
  it('tracks subrequest budget, grant fingerprints, and Google auth strikes', async () => {
    const store = createStore();
    const budget = new Budget(2);
    expect(budget.has(2)).toBe(true);
    expect(budget.take(2)).toBe(true);
    expect(budget.take(1)).toBe(false);

    expect(configured({})).toBe(false);
    expect(authState(store, {})).toBe('not_configured');
    expect(await openSession({ store, env: {}, fetch, now: () => T0, budget: new Budget(5), token: null })).toEqual({ reason: 'not_configured' });

    const env = { GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csec', GMAIL_REFRESH_TOKEN: 'rt-1' };
    expect(authState(store, env)).toBe('unknown');
    const first = await openSession({ store, env, fetch, now: () => T0, budget: new Budget(5), token: null });
    expect('client' in first).toBe(true);

    noteTokenOk(store, { token: 'at', expiresAt: T0 + 60_000, writeScope: true });
    expect(authState(store, env)).toBe('ok');
    expect(writeScope(store)).toBe(true);

    // Non-GoogleError stops the pass and records gmail_unexpected
    expect(noteGoogleError(store, new Error('boom'))).toBe(true);
    // Auth strikes up to AUTH_FAILURES_STOP mark auth_state = 'failed'
    for (let i = 1; i <= AUTH_FAILURES_STOP; i++) {
      expect(noteGoogleError(store, new GoogleError('auth', 'token_401', 401))).toBe(true);
    }
    expect(authState(store, env)).toBe('failed');
    expect(await openSession({ store, env, fetch, now: () => T0, budget: new Budget(5), token: null })).toEqual({ reason: 'stopped' });

    // Rotating the refresh token resets the failed state
    const rotated = await openSession({
      store,
      env: { ...env, GMAIL_REFRESH_TOKEN: 'rt-2' },
      fetch,
      now: () => T0,
      budget: new Budget(5),
      token: null,
    });
    expect('client' in rotated).toBe(true);
    expect(authState(store, { ...env, GMAIL_REFRESH_TOKEN: 'rt-2' })).toBe('unknown');
  });

  it('manages ledger intents, label creation/linking, mailChanged checks, abandonInFlight, and executeWrites', async () => {
    const { store, gmail } = seedPriorityStore();
    gmail.grants.set('synthetic-refresh', SCOPE_MODIFY);
    const session = await openSession({
      store,
      env: { GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csec', GMAIL_REFRESH_TOKEN: 'synthetic-refresh' },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return gmail.handle(req.method, new URL(req.url), req.headers, await req.text());
      },
      now: () => T0,
      budget: new Budget(50),
      token: null,
    });
    if (!('client' in session)) throw new Error('expected client');

    const p2 = store.label('p2')!;
    expect(labelCreationCost(p2)).toBe(0);
    expect(labelCreationCost({ display_name: 'New', gmail_state: 'pending', gmail_id: null })).toBe(2);

    const map = userLabelsByName([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_10', name: 'Club', type: 'user' },
      { id: 'Label_11', name: 'Club/Events', type: 'user' },
    ]);
    expect(hasSublabels(map, 'Club')).toBe(true);
    expect(hasSublabels(map, 'Other')).toBe(false);

    // Ensure pending label creation and name-taken detection
    store.run(`INSERT INTO labels (id, seq, display_name, gmail_state, create_time, update_time, etag) VALUES ('custom', 5, 'Custom', 'pending', ?, ?, 'e')`, T0, T0);
    let gateResult: string | null = null;
    const ctx: WriteContext = {
      store,
      gmail: session.client as GmailClient,
      budget: new Budget(50),
      now: () => T0,
      transact: (fn) => fn(),
      gate: () => gateResult,
    };
    const createdId = await ensureGmailLabel(ctx, store.label('custom')!);
    expect(createdId).toMatch(/^Label_/);
    expect(store.label('custom')?.gmail_state).toBe('linked');

    // Taken label name in Gmail (not own parent)
    const takenGmailId = gmail.createUserLabel('Taken');
    store.run(`INSERT INTO labels (id, seq, display_name, gmail_state, create_time, update_time, etag) VALUES ('taken', 6, 'Taken', 'pending', ?, ?, 'e')`, T0, T0);
    expect(await ensureGmailLabel(ctx, store.label('taken')!)).toBeNull();
    expect(store.label('taken')?.gmail_name_taken).toBe(1);

    // Own parent in gmail_parents is linked and removed from gmail_parents
    store.run(`INSERT INTO gmail_parents (path, gmail_id) VALUES ('Taken', ?)`, takenGmailId);
    expect(isOwnParent(store, takenGmailId)).toBe(true);
    setNameTaken(store, 'taken', false, T0);
    linkGmailLabel(store, 'taken', takenGmailId, false, T0);
    expect(isOwnParent(store, takenGmailId)).toBe(false);
    expect(store.label('taken')?.gmail_adopted).toBe(0);

    // Deliver a message and test intend, mailChanged, alreadyLabelled, executeWrites, and undo
    const msgId = MAILS.bankEn.id;
    gmail.deliver(message({ ...MAILS.bankEn, id: msgId, labels: ['INBOX', 'UNREAD'] }));
    store.run(
      `INSERT INTO decisions (message_id, thread_id, received_at, decided_at, subject, sender, sender_domain, dmarc, outcome, label_id, top_label, probabilities, probabilities2, decider, model, current_labels)
       VALUES (?, 't1', ?, ?, 'Sub', 's@example.com', 'example.com', 1, 'applied', 'p2', 'p2', '{}', '{}', 'claude', 'claude-opus-5-5', '[]')`,
      msgId,
      T0,
      T0,
    );
    const ledgerId = intend(store, msgId, store.label('p2')!, true, 'auto', T0, ['INBOX', 'UNREAD']);
    const row = store.ledgerRow(ledgerId)!;
    expect(mailChanged(row, ['INBOX', 'UNREAD'])).toBe(false);
    expect(mailChanged(row, ['UNREAD'])).toBe(true); // archived before write
    expect(mailChanged(row, ['INBOX', 'UNREAD', 'Label_999'])).toBe(true); // extra user label
    expect(alreadyLabelled(row, p2.gmail_id!, [p2.gmail_id!])).toBe(true);
    expect(alreadyLabelled(row, p2.gmail_id!, null)).toBe(false);

    // Execute write and undo
    const appliedOut = await executeWrites(ctx, [ledgerId], 10);
    expect(appliedOut).toEqual({ applied: 1, undone: 0, failed: 0, stopped: false });
    const appliedRow = store.ledgerRow(ledgerId)!;
    expect(undoable(appliedRow, store.ownedGmailIds())).toBe(true);
    intendUndo(store, appliedRow);
    const undoneOut = await executeWrites(ctx, [ledgerId], 10);
    expect(undoneOut).toEqual({ applied: 0, undone: 1, failed: 0, stopped: false });
    expect(store.ledgerRow(ledgerId)?.state).toBe('undone');

    // abandonInFlight converts intended -> failed and undo_intended -> applied
    const inFlightId = intend(store, msgId, store.label('p2')!, true, 'auto', T0 + 1, ['INBOX']);
    const undoInFlightId = intend(store, msgId, store.label('p1')!, false, 'owner', T0 + 2, ['INBOX']);
    store.run(`UPDATE ledger SET state = 'undo_intended' WHERE id = ?`, undoInFlightId);
    expect(abandonInFlight(store, 'restored')).toBe(2);
    expect(store.ledgerRow(inFlightId)).toMatchObject({ state: 'failed', last_code: 'restored' });
    expect(store.ledgerRow(undoInFlightId)).toMatchObject({ state: 'applied', last_code: 'restored' });

    // Permanent GmailRefused error and transient GoogleError retry exhaustion
    const badId = intend(store, msgId, store.label('p2')!, true, 'auto', T0 + 3, ['INBOX']);
    const refusingCtx: WriteContext = {
      ...ctx,
      gmail: { classify: () => Promise.reject(new GmailRefused('bad')) } as unknown as GmailClient,
    };
    expect(await executeWrites(refusingCtx, [badId], 10)).toEqual({ applied: 0, undone: 0, failed: 1, stopped: false });
    expect(store.ledgerRow(badId)).toMatchObject({ state: 'failed', last_code: 'guard_refused' });

    const retryId = intend(store, msgId, store.label('p2')!, true, 'auto', T0 + 4, ['INBOX']);
    store.run(`UPDATE ledger SET attempts = ? WHERE id = ?`, WRITE_ATTEMPTS_MAX - 1, retryId);
    const rateLimitCtx: WriteContext = {
      ...ctx,
      gmail: {
        labelIdsOf: () => Promise.resolve(['INBOX']),
        classify: () => Promise.reject(new GoogleError('rate', 'message_modify_429', 429)),
      } as unknown as GmailClient,
    };
    expect(await executeWrites(rateLimitCtx, [retryId], 10)).toEqual({ applied: 0, undone: 0, failed: 1, stopped: true });
    expect(store.ledgerRow(retryId)).toMatchObject({ state: 'failed', last_code: 'attempts' });
  });
});
