/**
 * The HTTP surface around LabUiService in workerd (src/http.ts): Status errors under /api/v1, the transcoder's
 * edges as Lab configures them (CSRF before the body, the body limit, 405/OPTIONS/HEAD), and the old UI's
 * routes answering 410 `reload_required` in their old envelope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});

interface StatusBody {
  error: { code: number; message: string; status: string; details: { '@type': string; reason?: string; locale?: string; message?: string; request_id?: string }[] };
}

async function status(response: Response): Promise<StatusBody['error']> {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  return ((await response.json()) as StatusBody).error;
}

const reason = (error: StatusBody['error']) => error.details.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason;

describe('errors under /api/v1', () => {
  it('are google.rpc.Status bodies with ErrorInfo, the Chinese copy and the request ID', async () => {
    const response = await h.fetch('/api/v1/decks/2026-09-29');
    expect(response.status).toBe(404);
    const error = await status(response);
    expect(error).toMatchObject({ code: 404, status: 'NOT_FOUND' });
    expect(error.details).toEqual([
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'DECK_NOT_FOUND', domain: 'lab.ziyixi.science' },
      { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '找不到这组卡片' },
      { '@type': 'type.googleapis.com/google.rpc.RequestInfo', request_id: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown as string },
    ]);
    // Private headers as on every response.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('answer an unknown path NOT_FOUND, another method 405 with Allow, OPTIONS 204 and HEAD without a body', async () => {
    expect(reason(await status(await h.fetch('/api/v1/nothing')))).toBe('NOT_FOUND');
    expect(reason(await status(await h.fetch('/api/v1')))).toBe('NOT_FOUND');
    const put = await h.fetch('/api/v1/settings', { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, PATCH, OPTIONS');
    expect(reason(await status(put))).toBe('METHOD_NOT_ALLOWED');
    const options = await h.fetch('/api/v1/settings', { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD, PATCH, OPTIONS');
    expect(options.headers.get('access-control-allow-origin')).toBeNull();
    const head = await h.fetch('/api/v1/settings', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('check CSRF before the body, refuse large bodies, unknown fields and query parameters', async () => {
    const noCsrf = await h.fetch('/api/v1/seeds/2601.00042?request_id=' + op(), { method: 'DELETE', headers: { origin: 'http://127.0.0.1' } });
    expect(noCsrf.status).toBe(403);
    expect(reason(await status(noCsrf))).toBe('CSRF_FAILED');
    const big = await h.mutate('POST', '/api/v1/seeds:import', { request_id: op(), inputs: ['x'.repeat(17 * 1024)] });
    expect(big.status).toBe(400);
    expect(reason(await status(big))).toBe('BAD_REQUEST');
    expect((await h.mutate('POST', '/api/v1/seeds:import', { request_id: op(), inputs: ['2601.00042'], ids: [] })).status).toBe(400);
    expect((await h.fetch('/api/v1/seeds?color=red')).status).toBe(400);
    // A query value that is not UTF-8 is refused, not read as U+FFFD.
    const latin1 = await h.fetch('/api/v1/likedPapers?filter=%FF');
    expect(latin1.status).toBe(400);
    expect(reason(await status(latin1))).toBe('BAD_REQUEST');
    // A DELETE answers google.protobuf.Empty; a seed that is not there is NOT_FOUND (AIP-135).
    expect((await h.mutate('POST', '/api/v1/seeds:import', { request_id: op(), inputs: ['2601.00042'] })).status).toBe(200);
    const deleted = await h.mutate('DELETE', `/api/v1/seeds/2601.00042?request_id=${op()}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});
    const gone = await h.mutate('DELETE', `/api/v1/seeds/2601.00042?request_id=${op()}`);
    expect(gone.status).toBe(404);
    expect(reason(await status(gone))).toBe('NOT_FOUND');
  });

  it('answer a failed D1 read UNAVAILABLE (the UI may repeat it), never a bug', async () => {
    // Every handler's direct D1 read goes through the same wrapper as LabState's calls.
    await h.sql('ALTER TABLE sends RENAME TO sends_gone');
    try {
      const failed = await h.fetch('/api/v1/decks/2026-09-30/send');
      expect(failed.status).toBe(503);
      const error = await status(failed);
      expect(error.status).toBe('UNAVAILABLE');
      expect(reason(error)).toBe('UNAVAILABLE');
      expect(JSON.stringify(error)).not.toContain('sends');
    } finally {
      await h.sql('ALTER TABLE sends_gone RENAME TO sends');
    }
  });
});

describe('the old UI routes', () => {
  it('answer 410 reload_required in the old envelope, after Access', async () => {
    for (const [method, path] of [
      ['GET', '/api/today'],
      ['GET', '/api/decks/2026-09-30'],
      ['POST', '/api/decks/2026-09-30/decide'],
      ['DELETE', '/api/seeds'],
      ['GET', '/api'],
    ] as const) {
      const response = await h.fetch(path, { method });
      expect(response.status, path).toBe(410);
      const body = (await response.json()) as { error: { code: string; message: string; request_id: string } };
      expect(body.error).toMatchObject({ code: 'reload_required', message: 'Lab 已更新，请刷新页面' });
    }
    // The CSRF token stays where both UIs fetch it.
    const csrf = await h.fetch('/api/csrf');
    expect(csrf.status).toBe(200);
    expect(((await csrf.json()) as { token: string }).token).toMatch(/./);
    expect((await h.fetch('/api/csrf', { method: 'POST' })).status).toBe(405);
  });
});
