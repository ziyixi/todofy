import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrationStatements } from './migrations.mjs';
import { detailOf, idOf, query, reasonOf } from './owner-api.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = [
  'From: Synthetic Sender <sender@example.org>', 'To: inbox@mail.example.org',
  'Subject: =?UTF-8?B?5ZCI5oiQ5rWL6K+V?=', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="parts"', '', '--parts',
  'Content-Type: text/html; charset=UTF-8', '',
  '<p>Hello 合成邮件</p><script>alert(1)</script><img src="https://tracker.example.org/x">',
  '--parts', 'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"', '', 'safe attachment',
  '--parts--', '',
].join('\r\n');

async function waitFor(read, predicate, label, timeout = 12000) {
  const until = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(100);
  } while (Date.now() < until);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

test('native workerd: durable archive, protected API, stable retry identity and content deletion', { timeout: 90000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-native-test-'));
  const calls = [];
  const bundle = await build({
    stdin: { contents: `
      import app from './src/native/index';
      import { emailHandler } from './src/native/ingest';
      import { enqueue } from './src/native/pipeline';
      export { MailCoordinator } from './src/native/coordinator';
      export default { async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        if (path === '/__test/email') {
          let rejected = '';
          await emailHandler({ from: 'sender@example.org', to: env.RECEIVE_ADDRESS,
            raw: request.body, rawSize: Number(request.headers.get('x-raw-size')),
            setReject(reason) { rejected = reason; } }, env, ctx);
          return new Response(rejected || null, {status: rejected ? 422 : 204});
        }
        if (path === '/__test/enqueue') {
          await enqueue(env, await request.json()); return new Response(null, {status:204});
        }
        return app.fetch(request, env, ctx);
      }};`, resolveDir: root, sourcefile: 'native-runtime-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', conditions: ['browser'], external: ['cloudflare:workers'], write: false,
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'mail-hero-runtime-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'native-test' }, d1Persist: join(temp, 'd1'),
    r2Buckets: ['MAIL_STORE'], r2Persist: join(temp, 'r2'),
    durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } },
    durableObjectsPersist: join(temp, 'do'),
    bindings: { RECEIVE_ADDRESS: 'inbox@mail.example.org', DEV_AUTH_BYPASS: 'true',
      ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic',
      ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64),
      WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org', FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false' },
    serviceBindings: { ASSETS: () => new Response('<html>Mail Hero</html>', { headers: { 'content-type': 'text/html' } }) },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'consumer.example.org', 'no unexpected outbound fetch');
      calls.push({ body: await request.text(), key: request.headers.get('Idempotency-Key'), authorization: request.headers.get('Authorization'),
        userAgent: request.headers.get('User-Agent'), contentType: request.headers.get('Content-Type') });
      return new Response(null, { status: calls.length === 1 || calls.length === 3 ? 503 : 204 });
    },
  }));
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join(root, 'migrations', name), 'utf8');
      await db.batch(migrationStatements(sql).map(s => db.prepare(s)));
    }
    const publicRequest = await mf.dispatchFetch('https://public.example.org/api/v2/messages');
    assert.equal(publicRequest.status, 503, 'DEV bypass fails closed outside localhost');
    assert.equal(reasonOf(await publicRequest.json()), 'ACCESS_NOT_CONFIGURED');
    const spoofed = await mf.dispatchFetch('http://localhost/api/v2/messages', { headers: { 'CF-Ray': 'spoof' } });
    assert.equal(spoofed.status, 503);
    const csrf = await mf.dispatchFetch('http://localhost/api/csrf');
    assert.equal(csrf.status, 200);
    const csrfValue = (await csrf.json()).token;
    const cookie = csrf.headers.get('set-cookie').split(';')[0];
    /** mailhero.ui.v2 through the Worker, as the UI calls it; a refusal fails the test. */
    async function api(path, method = 'GET', body) {
      const response = await mf.dispatchFetch(`http://localhost/api/v2${path}`, { method,
        headers: { Origin: 'http://localhost', Cookie: cookie, 'X-CSRF-Token': csrfValue, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    const stats = (from, to, extra = {}) => `/deliveries/-/attempts:summarize${query({ start_time: from, end_time: to, granularity: 'hour', ...extra })}`;
    const forbidden = await mf.dispatchFetch('http://localhost/api/v2/settings?update_mask=send_paused', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403, 'mutations require origin and CSRF');
    assert.equal(reasonOf(await forbidden.json()), 'CSRF_FAILED');
    const legacy = await mf.dispatchFetch('http://localhost/api/v1/messages');
    assert.deepEqual([legacy.status, (await legacy.json()).error.code], [410, 'reload_required'], 'an old tab is asked to reload');
    async function receive() {
      const response = await mf.dispatchFetch('http://localhost/__test/email', { method: 'POST', headers: { 'x-raw-size': String(Buffer.byteLength(fixture)) }, body: fixture });
      assert.equal(response.status, 204, await response.text());
    }
    await receive();
    const message = await waitFor(() => db.prepare('SELECT * FROM messages LIMIT 1').first(), row => row?.parse_state === 'ready', 'mail becomes readable');
    assert.equal((await api(`/messages/${message.id}`)).subject, '合成测试');
    const detail = await api(`/messages/${message.id}/content`);
    assert.match(detail.text, /合成邮件/);
    assert.doesNotMatch(detail.html, /tracker|script|<img/i);
    assert.equal(detail.attachments.length, 1);
    assert.equal((await api('/deliveries')).deliveries, undefined, 'archive mode does not send');
    const attachment = await mf.dispatchFetch(`http://localhost${detail.attachments[0].download_uri}`);
    assert.equal(attachment.status, 200);
    assert.match(await attachment.text(), /safe attachment/);
    const actionID = crypto.randomUUID();
    const endpointBody = { display_name: 'Synthetic consumer', uri: 'https://consumer.example.org/hooks/mail',
      auth_type: 'bearer', credential: 'synthetic-token-not-a-real-secret', rate_per_minute: 60, timeout_seconds: 2 };
    const created = await api(`/endpoints?request_id=${actionID}`, 'POST', endpointBody);
    assert.equal((await api(`/endpoints?request_id=${actionID}`, 'POST', endpointBody)).name, created.name, 'double click creates one endpoint');
    assert.ok(!JSON.stringify(created).includes(endpointBody.credential));
    const endpoint = { ...created, id: idOf(created.name), ...(await db.prepare('SELECT current_revision_id FROM webhook_endpoints WHERE id=?').bind(idOf(created.name)).first()) };
    const send = { endpoint: created.name, request_id: crypto.randomUUID() };
    const sent = await api(`/messages/${message.id}:send`, 'POST', send);
    const event = { event_id: idOf(sent.delivery.name) };
    assert.equal((await api(`/messages/${message.id}:send`, 'POST', send)).delivery.name, sent.delivery.name);
    await waitFor(() => db.prepare('SELECT * FROM deliveries WHERE event_id=?').bind(event.event_id).first(), row => row?.state === 'retry_wait', '503 is durable retry');
    assert.equal(calls.length, 1);
    // Advance only the test's persisted clocks; production backoff remains intact.
    await db.batch([
      db.prepare("UPDATE deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").bind(event.event_id),
      db.prepare('UPDATE webhook_endpoints SET next_send_at=NULL'), db.prepare('UPDATE app_settings SET next_send_at=NULL'),
    ]);
    const retry = await mf.dispatchFetch('http://localhost/__test/enqueue', { method: 'POST', body: JSON.stringify({ type: 'deliver', eventID: event.event_id }) });
    assert.equal(retry.status, 204);
    await waitFor(() => db.prepare('SELECT * FROM deliveries WHERE event_id=?').bind(event.event_id).first(), row => row?.state === 'delivered', 'same event completes');
    assert.equal(calls.length, 2);
    const statsFrom = new Date(Date.now() - 3600_000).toISOString();
    const statsTo = new Date(Date.now() + 3600_000).toISOString();
    const totals = await api(stats(statsFrom, statsTo));
    assert.deepEqual(totals.totals, { succeeded_count: 1, retried_count: 1 }, 'workerd reads actual completed attempts');
    assert.deepEqual((await db.prepare('SELECT outcome FROM delivery_attempts WHERE event_id=? ORDER BY attempt_no').bind(event.event_id).all()).results.map(row => row.outcome), ['retryable', 'delivered']);
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='delivery_attempts_finished_idx'").first(), 'range index migrated in workerd D1');
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].key, event.event_id);
    assert.equal(calls[1].key, event.event_id);
    assert.equal(JSON.parse(calls[0].body).event_id, event.event_id);
    assert.equal(calls[0].authorization, 'Bearer ' + endpointBody.credential);
    assert.equal(calls[0].userAgent, 'MailHero/1.0');
    assert.equal(calls[0].contentType, 'application/json');
    // Pause the endpoint while creating a second event so its first attempt
    // cannot race the test's retry-mode setup. A single manual attempt that
    // receives 503 is terminal and must be counted as failed, not retried.
    await db.prepare('UPDATE webhook_endpoints SET paused=1 WHERE id=?').bind(endpoint.id).run();
    const beforeReplay = await api(`/messages/${message.id}`);
    // The coordinator creates the delivery (/deliveries/create); its refusal reaches the owner as before.
    const stale = await mf.dispatchFetch(`http://localhost/api/v2/deliveries/${event.event_id}:resend`, { method: 'POST',
      headers: { Origin: 'http://localhost', Cookie: cookie, 'X-CSRF-Token': csrfValue, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: endpoint.name, message_etag: String(Number(beforeReplay.etag) + 1), request_id: crypto.randomUUID() }) });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.deepEqual(reasonOf(staleBody), 'ETAG_MISMATCH');
    // In workerd too, the mismatch carries the delivery's message as it is now (AIP-154).
    assert.deepEqual(detailOf(staleBody, 'mailhero.ui.v2.Message'), beforeReplay);
    const terminal = { event_id: idOf((await api(`/deliveries/${event.event_id}:resend`, 'POST', { endpoint: endpoint.name,
      message_etag: beforeReplay.etag, request_id: crypto.randomUUID() })).delivery.name) };
    await db.batch([
      db.prepare("UPDATE deliveries SET retry_mode='once',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").bind(terminal.event_id),
      db.prepare('UPDATE webhook_endpoints SET paused=0,next_send_at=NULL WHERE id=?').bind(endpoint.id),
      db.prepare('UPDATE app_settings SET next_send_at=NULL'),
    ]);
    assert.equal((await mf.dispatchFetch('http://localhost/__test/enqueue', { method: 'POST', body: JSON.stringify({ type: 'deliver', eventID: terminal.event_id }) })).status, 204);
    await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(terminal.event_id).first(), row => row?.state === 'failed', 'single transient attempt is terminal');
    assert.equal((await db.prepare('SELECT outcome FROM delivery_attempts WHERE event_id=?').bind(terminal.event_id).first()).outcome, 'failed');
    const finalStats = await api(stats(statsFrom, statsTo));
    assert.deepEqual(finalStats.totals, { succeeded_count: 1, retried_count: 1, failed_count: 1 });
    const fresh = await api(`/messages/${message.id}`);
    await api(`/messages/${message.id}:clearContent`, 'POST', { etag: fresh.etag, request_id: crypto.randomUUID() });
    assert.equal((await mf.dispatchFetch(`http://localhost/api/v2/messages/${message.id}/raw`)).status, 410);
    await receive();
    await waitFor(() => db.prepare('SELECT COUNT(*) n FROM ingest_receipts').first(), row => row?.n === 2, 'duplicate is indexed once');
    const tombstone = await db.prepare('SELECT * FROM messages WHERE id=?').bind(message.id).first();
    assert.ok(tombstone.content_deleted_at);
    assert.equal(tombstone.raw_key, null);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM messages').first()).n, 1);
    assert.equal(calls.length, 3, 'deletion and redelivery do not replay side effects');

    // A Gmail-style automatic forward uses the already-configured target.
    // It must leave pending, expose the decoded Chinese body, and deliver once.
    await db.batch([
      db.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=?,next_send_at=NULL WHERE id=1").bind(endpoint.id),
      db.prepare('UPDATE webhook_endpoints SET next_send_at=NULL WHERE id=?').bind(endpoint.id),
    ]);
    const gmailForward = [
      'Return-Path: <sender@example.org>',
      'X-Forwarded-To: inbox@mail.example.org',
      'From: Synthetic Sender <sender@example.org>',
      'To: original@example.org',
      'Subject: test',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '', Buffer.from('测试邮件', 'utf8').toString('base64'), '',
    ].join('\r\n');
    const forwarded = await mf.dispatchFetch('http://localhost/__test/email', { method: 'POST',
      headers: { 'x-raw-size': String(Buffer.byteLength(gmailForward)) }, body: gmailForward });
    assert.equal(forwarded.status, 204, await forwarded.text());
    const forwardedRow = await waitFor(() => db.prepare("SELECT * FROM messages WHERE subject='test'").first(),
      row => row?.parse_state === 'ready', 'Gmail-style forward is parsed');
    assert.equal(forwardedRow.receive_mode, 'forward');
    assert.equal(forwardedRow.from_text, 'Synthetic Sender <sender@example.org>');
    assert.equal((await api(`/messages/${forwardedRow.id}/content`)).text, '测试邮件');
    const automatic = await waitFor(() => db.prepare('SELECT * FROM deliveries WHERE message_id=?').bind(forwardedRow.id).first(),
      row => row?.state === 'delivered', 'forwarded mail auto-delivers');
    assert.equal(automatic.endpoint_revision_id, endpoint.current_revision_id);
    assert.equal(calls.length, 4);
    const posted = JSON.parse(calls[3].body);
    assert.equal(posted.message.subject, 'test');
    assert.equal(posted.message.text, '测试邮件');
    assert.equal(posted.message.from[0].address, 'sender@example.org');
    // workerd's Intl and real D1 evaluate the local-time CASE with numbered parameters.
    await db.prepare(`INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,finished_at,outcome)
      VALUES(?,?,90,'2026-11-01T08:30:00.000Z','2026-11-01T08:30:00.000Z','retryable'),(?,?,91,'2026-11-01T09:30:00.000Z','2026-11-01T09:30:00.000Z','delivered')`)
      .bind(crypto.randomUUID(), automatic.event_id, crypto.randomUUID(), automatic.event_id).run();
    const local = await api(stats('2026-11-01T06:00:00.000Z', '2026-11-01T12:00:00.000Z', { time_zone: 'America/Los_Angeles' }));
    assert.equal(local.time_zone, 'America/Los_Angeles');
    assert.deepEqual(local.buckets.map(item => [item.start_time.slice(11, 13), item.counts.retried_count ?? 0, item.counts.succeeded_count ?? 0]),
      [['06', 0, 0], ['07', 0, 0], ['08', 1, 0], ['09', 0, 1], ['10', 0, 0], ['11', 0, 0]], 'the repeated 01:00 stays two buckets');
    const zone = await mf.dispatchFetch(`http://localhost/api/v2${stats('2026-11-01T06:00:00.000Z', '2026-11-01T12:00:00.000Z', { time_zone: 'Not/AZone' })}`);
    assert.deepEqual([zone.status, reasonOf(await zone.json())], [400, 'INVALID_TIME_ZONE']);

    // Mixed versions: an event an older build froze (its R2 payload/<eventID>.json) is retried with exactly those bytes.
    // Nothing builds an event twice, so this build's codec never rewrites one (pre_storage_v1 lacks storage-v1's fields,
    // which the codec would add).
    const legacyBytes = await readFile(join(root, '../../contracts/mail-received-v1/fixtures/legacy/pre_storage_v1.json'));
    await db.prepare('UPDATE webhook_endpoints SET paused=1 WHERE id=?').bind(endpoint.id).run();
    const latest = await api(`/messages/${forwardedRow.id}`);
    const frozen = { event_id: idOf((await api(`/deliveries/${automatic.event_id}:resend`, 'POST', { endpoint: endpoint.name,
      message_etag: latest.etag, request_id: crypto.randomUUID() })).delivery.name) };
    const { payload_key: frozenKey } = await db.prepare('SELECT payload_key FROM deliveries WHERE event_id=?').bind(frozen.event_id).first();
    await (await mf.getR2Bucket('MAIL_STORE')).put(frozenKey, legacyBytes);
    await db.batch([
      db.prepare("UPDATE deliveries SET payload_sha256=?,payload_size_bytes=?,next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?")
        .bind(createHash('sha256').update(legacyBytes).digest('hex'), legacyBytes.byteLength, frozen.event_id),
      db.prepare('UPDATE webhook_endpoints SET paused=0,next_send_at=NULL WHERE id=?').bind(endpoint.id),
      db.prepare('UPDATE app_settings SET next_send_at=NULL'),
    ]);
    assert.equal((await mf.dispatchFetch('http://localhost/__test/enqueue', { method: 'POST', body: JSON.stringify({ type: 'deliver', eventID: frozen.event_id }) })).status, 204);
    await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(frozen.event_id).first(), row => row?.state === 'delivered', 'a frozen older event is delivered');
    assert.equal(calls.length, 5);
    assert.equal(calls[4].body, legacyBytes.toString('utf8'), 'the frozen bytes, never rebuilt');
    assert.equal(calls[4].key, frozen.event_id);
  } finally {
    await mf.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});

test('native workerd: MAINTENANCE_MODE refuses a mutation before Access, with a Status on the owner API', { timeout: 60000 }, async () => {
  const bundle = await build({ entryPoints: [join(root, 'src/native/index.ts')], bundle: true, format: 'esm', platform: 'neutral', conditions: ['browser'], external: ['cloudflare:workers'], write: false });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'mail-hero-maintenance-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'maintenance-test' }, r2Buckets: ['MAIL_STORE'], durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } },
    bindings: { RECEIVE_ADDRESS: 'inbox@mail.example.org', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic',
      ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org', FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'true' },
    serviceBindings: { ASSETS: () => new Response('<html>Mail Hero</html>', { headers: { 'content-type': 'text/html' } }) },
  }));
  try {
    // No login at all: maintenance answers first, as before; the owner API's answer is a Status, every other path's the envelope.
    for (const path of ['/api/v2/settings?update_mask=send_paused', '/api/csrf']) {
      const response = await mf.dispatchFetch(`https://mail.example.org${path}`, { method: 'PATCH', body: '{}' });
      assert.equal(response.status, 503, path);
      assert.equal(reasonOf(await response.json()), 'MAINTENANCE', path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    const other = await mf.dispatchFetch('https://mail.example.org/api/v1/settings', { method: 'PATCH', body: '{}' });
    assert.deepEqual([other.status, (await other.json()).error.code], [503, 'maintenance']);
    const read = await mf.dispatchFetch('https://mail.example.org/api/v2/settings');
    assert.deepEqual([read.status, reasonOf(await read.json())], [401, 'UNAUTHORIZED'], 'a read still needs Access');
  } finally {
    await mf.dispose();
  }
});
