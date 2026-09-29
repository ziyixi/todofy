import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrationStatements } from './migrations.mjs';

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
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false,
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
    const publicRequest = await mf.dispatchFetch('https://public.example.org/api/v1/messages');
    assert.equal(publicRequest.status, 503, 'DEV bypass fails closed outside localhost');
    const spoofed = await mf.dispatchFetch('http://localhost/api/v1/messages', { headers: { 'CF-Ray': 'spoof' } });
    assert.equal(spoofed.status, 503);
    const csrf = await mf.dispatchFetch('http://localhost/api/v1/csrf');
    assert.equal(csrf.status, 200);
    const csrfValue = (await csrf.json()).token;
    const cookie = csrf.headers.get('set-cookie').split(';')[0];
    async function api(path, method = 'GET', body) {
      const response = await mf.dispatchFetch(`http://localhost/api/v1${path}`, { method,
        headers: { Origin: 'http://localhost', Cookie: cookie, 'X-CSRF-Token': csrfValue, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const result = response.status === 204 ? null : await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    const forbidden = await mf.dispatchFetch('http://localhost/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403, 'mutations require origin and CSRF');
    async function receive() {
      const response = await mf.dispatchFetch('http://localhost/__test/email', { method: 'POST', headers: { 'x-raw-size': String(Buffer.byteLength(fixture)) }, body: fixture });
      assert.equal(response.status, 204, await response.text());
    }
    await receive();
    const message = await waitFor(() => db.prepare('SELECT * FROM messages LIMIT 1').first(), row => row?.parse_state === 'ready', 'mail becomes readable');
    const detail = await api(`/messages/${message.id}`);
    assert.equal(detail.message.subject, '合成测试');
    assert.match(detail.message.text, /合成邮件/);
    assert.doesNotMatch(detail.message.html, /tracker|script|<img/i);
    assert.equal(detail.message.attachments.length, 1);
    assert.equal((await api('/deliveries')).items.length, 0, 'archive mode does not send');
    const attachment = await mf.dispatchFetch(`http://localhost/api/v1/messages/${message.id}/attachments/1.1`);
    assert.equal(attachment.status, 200);
    assert.match(await attachment.text(), /safe attachment/);
    const actionID = crypto.randomUUID();
    const endpointBody = { action_request_id: actionID, label: 'Synthetic consumer', url: 'https://consumer.example.org/hooks/mail',
      auth_type: 'bearer', credential: 'synthetic-token-not-a-real-secret', rate_per_minute: 60, timeout_seconds: 2 };
    const endpoint = await api('/endpoints', 'POST', endpointBody);
    assert.equal((await api('/endpoints', 'POST', endpointBody)).id, endpoint.id, 'double click creates one endpoint');
    assert.ok(!JSON.stringify(endpoint).includes(endpointBody.credential));
    const send = { endpoint_id: endpoint.id, action_request_id: crypto.randomUUID() };
    const event = await api(`/messages/${message.id}/send`, 'POST', send);
    assert.equal((await api(`/messages/${message.id}/send`, 'POST', send)).event_id, event.event_id);
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
    const stats = await api(`/delivery-stats?from=${encodeURIComponent(statsFrom)}&to=${encodeURIComponent(statsTo)}&bucket=hour`);
    assert.deepEqual(stats.totals, { succeeded: 1, retried: 1, failed: 0, unknown: 0 }, 'workerd reads actual completed attempts');
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
    const beforeReplay = (await api(`/messages/${message.id}`)).message;
    const terminal = await api(`/deliveries/${event.event_id}/replay`, 'POST', { endpoint_id: endpoint.id,
      message_version: beforeReplay.version, action_request_id: crypto.randomUUID() });
    await db.batch([
      db.prepare("UPDATE deliveries SET retry_mode='once',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").bind(terminal.event_id),
      db.prepare('UPDATE webhook_endpoints SET paused=0,next_send_at=NULL WHERE id=?').bind(endpoint.id),
      db.prepare('UPDATE app_settings SET next_send_at=NULL'),
    ]);
    assert.equal((await mf.dispatchFetch('http://localhost/__test/enqueue', { method: 'POST', body: JSON.stringify({ type: 'deliver', eventID: terminal.event_id }) })).status, 204);
    await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(terminal.event_id).first(), row => row?.state === 'failed', 'single transient attempt is terminal');
    assert.equal((await db.prepare('SELECT outcome FROM delivery_attempts WHERE event_id=?').bind(terminal.event_id).first()).outcome, 'failed');
    const finalStats = await api(`/delivery-stats?from=${encodeURIComponent(statsFrom)}&to=${encodeURIComponent(statsTo)}&bucket=hour`);
    assert.deepEqual(finalStats.totals, { succeeded: 1, retried: 1, failed: 1, unknown: 0 });
    const fresh = (await api(`/messages/${message.id}`)).message;
    await api(`/messages/${message.id}/content`, 'DELETE', { version: fresh.version, action_request_id: crypto.randomUUID() });
    assert.equal((await mf.dispatchFetch(`http://localhost/api/v1/messages/${message.id}/raw`)).status, 410);
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
    assert.equal((await api(`/messages/${forwardedRow.id}`)).message.text, '测试邮件');
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
    const local = await api('/delivery-stats?from=2026-11-01T06%3A00%3A00.000Z&to=2026-11-01T12%3A00%3A00.000Z&bucket=hour&tz=America%2FLos_Angeles');
    assert.equal(local.time_zone, 'America/Los_Angeles');
    assert.deepEqual(local.buckets.map(item => [item.start.slice(11, 13), item.retried, item.succeeded]),
      [['06', 0, 0], ['07', 0, 0], ['08', 1, 0], ['09', 0, 1], ['10', 0, 0], ['11', 0, 0]], 'the repeated 01:00 stays two buckets');
    assert.equal((await mf.dispatchFetch('http://localhost/api/v1/delivery-stats?from=2026-11-01T06%3A00%3A00.000Z&to=2026-11-01T12%3A00%3A00.000Z&tz=Not%2FAZone')).status, 400);
  } finally {
    await mf.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
