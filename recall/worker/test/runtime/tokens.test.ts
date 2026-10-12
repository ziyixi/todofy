// The machine tokens made in 设置 (../../../docs/design.md §2.2) in workerd: none before the owner makes one (503);
// RegenerateMachineToken answers the token once, keeps only its SHA-256 (not in meta, not in the request log, not in
// the status), and a repeated request answers without it; the token opens its route only; a regenerated token's
// predecessor works 24 hours more, or stops at once with revoke_previous; DeleteMachineToken stops the route; the
// mutations need Origin and the CSRF token; a digest put as a Worker secret is still accepted beside them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, uuid, visit } from './data.ts';
import { DAY, HOUR, INGEST_TOKEN, MINUTE, op, reasonOf, rejection, sha256, startHarness, T0, type Harness } from './harness.ts';

const noSecrets = { INGEST_TOKEN_SHA256: undefined, EXPORT_TOKEN_SHA256: undefined };

async function upload(h: Harness, token: string): Promise<number> {
  const item = await visit({ id: uuid(1), url: 'https://example.com/token', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] });
  return (await h.upload(batch([item]), { token })).status;
}

describe('tokens made in 设置', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ bindings: noSecrets });
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('answer 503 on every machine route before the owner makes one', async () => {
    expect(await upload(h, `recall_ingest_${'x'.repeat(43)}`)).toBe(503);
    expect((await h.changes('?after=0', null)).status).toBe(503);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.machineTokens.map((token) => [token.name, token.createTime, token.workerSecret])).toEqual([
      ['machineTokens/ingest', undefined, false],
      ['machineTokens/export', undefined, false],
    ]);
  });

  it('shows a new token once and keeps only its digest', async () => {
    const requestId = op();
    const made = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId });
    expect(made.token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(made.createTime).toBeDefined();
    const [meta] = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'token_ingest'`);
    expect(meta?.value).toContain(sha256(made.token));
    expect(meta?.value).not.toContain(made.token);
    const everything = JSON.stringify(await h.sql(`SELECT * FROM meta`)) + JSON.stringify(await h.sql(`SELECT * FROM requests`));
    expect(everything).not.toContain(made.token);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(await (await h.fetch('/api/v1/serviceStatus')).text()).not.toContain(made.token);
    expect(status.machineTokens[0]).toMatchObject({ name: 'machineTokens/ingest', token: '' });
    // The same request again changes nothing and answers without the token.
    const again = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId });
    expect(again.token).toBe('');
    expect(again.createTime).toEqual(made.createTime);
    expect((await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'token_ingest'`))[0]?.value).toBe(meta?.value);
    // It opens the upload, and nothing else.
    expect(await upload(h, made.token)).toBe(200);
    expect((await h.changes('?after=0', made.token)).status).toBe(503);
    expect((await h.fetch('/api/v1/serviceStatus', { headers: { authorization: `Bearer ${made.token}` } })).status).toBe(200);
  });

  it('keeps the replaced token 24 hours, or not at all after a leak', async () => {
    const first = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: op() });
    await h.clock(T0 + HOUR);
    const second = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: op() });
    expect(second.previousExpireTime).toBeDefined();
    expect(await upload(h, first.token)).toBe(200);
    expect(await upload(h, second.token)).toBe(200);
    await h.clock(T0 + HOUR + DAY + MINUTE);
    expect(await upload(h, first.token)).toBe(401);
    expect(await upload(h, second.token)).toBe(200);
    const third = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', revokePrevious: true, requestId: op() });
    expect(third.previousExpireTime).toBeUndefined();
    expect(await upload(h, second.token)).toBe(401);
    expect(await upload(h, third.token)).toBe(200);
  });

  it('makes an export token for the feed, and stops a route when its token is deleted', async () => {
    const exported = await h.api.regenerateMachineToken({ name: 'machineTokens/export', requestId: op() });
    expect(exported.token).toMatch(/^recall_export_/);
    expect((await h.changes('?after=0', exported.token)).status).toBe(200);
    await h.api.deleteMachineToken({ name: 'machineTokens/export', requestId: op() });
    expect((await h.changes('?after=0', exported.token)).status).toBe(503);
    expect(reasonOf(await rejection(h.api.deleteMachineToken({ name: 'machineTokens/export', requestId: op() })))).toBe('NOT_FOUND');
    expect(reasonOf(await rejection(h.api.regenerateMachineToken({ name: 'machineTokens/other', requestId: op() })))).toBe('NOT_FOUND');
  });

  it('keeps independent named upload credentials and the existing global token valid', async () => {
    const legacy = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: op() });
    const requestId = op();
    const phone = await h.api.createMachineToken({ machineToken: { label: 'iPhone' }, requestId });
    const desktop = await h.api.createMachineToken({ machineToken: { label: 'Mac Studio' }, requestId: op() });
    expect(phone.name).toMatch(/^machineTokens\/[0-9a-f-]{36}$/);
    expect(phone.token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(desktop.name).not.toBe(phone.name);
    expect(await upload(h, legacy.token)).toBe(200);
    expect(await upload(h, phone.token)).toBe(200);
    expect(await upload(h, desktop.token)).toBe(200);
    const replay = await h.api.createMachineToken({ machineToken: { label: 'iPhone' }, requestId });
    expect(replay).toMatchObject({ name: phone.name, label: 'iPhone', token: '' });
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.machineTokens.slice(2).map((token) => token.label)).toEqual(['iPhone', 'Mac Studio']);
    const stored = JSON.stringify(await h.sql(`SELECT * FROM meta`)) + JSON.stringify(await h.sql(`SELECT * FROM requests`));
    expect(stored).not.toContain(phone.token);
    expect(stored).not.toContain(desktop.token);
    expect(status.machineTokens.every((token) => token.token === '')).toBe(true);
    await h.api.deleteMachineToken({ name: phone.name, requestId: op() });
    expect(await upload(h, phone.token)).toBe(401);
    expect(await upload(h, desktop.token)).toBe(200);
    expect(await upload(h, legacy.token)).toBe(200);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).machineTokens.map((token) => token.name)).not.toContain(phone.name);
    await h.api.deleteMachineToken({ name: desktop.name, requestId: op() });
  });

  it('rejects empty labels and bounds the named credential list', async () => {
    expect(reasonOf(await rejection(h.api.createMachineToken({ machineToken: { label: '  ' }, requestId: op() })))).toBe('BAD_REQUEST');
    const made = [];
    for (let i = 0; i < 16; i++) made.push(await h.api.createMachineToken({ machineToken: { label: `Device ${String(i)}` }, requestId: op() }));
    expect(reasonOf(await rejection(h.api.createMachineToken({ machineToken: { label: 'Too many' }, requestId: op() })))).toBe('LIMIT_REACHED');
    for (const token of made) await h.api.deleteMachineToken({ name: token.name, requestId: op() });
  });

  it('needs Origin and the CSRF token to make or delete one', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/machineTokens/ingest:regenerate'],
      ['POST', '/api/v1/machineTokens'],
      ['DELETE', '/api/v1/machineTokens/ingest'],
    ] as const) {
      const bare = await h.fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(bare.status, path).toBe(403);
      const foreign = await h.fetch(path, { method, headers: { 'content-type': 'application/json', origin: 'https://evil.example.net' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(foreign.status, path).toBe(403);
    }
  });
});

describe('a digest put as a Worker secret', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('is still accepted, beside a token made in 设置', async () => {
    expect(await upload(h, INGEST_TOKEN)).toBe(200);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.machineTokens.map((token) => token.workerSecret)).toEqual([true, true]);
    const made = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', revokePrevious: true, requestId: op() });
    expect(await upload(h, made.token)).toBe(200);
    expect(await upload(h, INGEST_TOKEN)).toBe(200);
    const named = await h.api.createMachineToken({ machineToken: { label: 'Phone' }, requestId: op() });
    expect(await upload(h, named.token)).toBe(200);
    await h.api.deleteMachineToken({ name: named.name, requestId: op() });
    expect(await upload(h, INGEST_TOKEN)).toBe(200);
    expect(await upload(h, made.token)).toBe(200);
  });
});
