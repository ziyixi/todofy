import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
const forwarded: { method: string; headers: Headers; body: string }[] = [];
beforeAll(async () => {
  harness = await startHarness({
    planning: async (request) => {
      forwarded.push({ method: request.method, headers: request.headers, body: await request.text() });
      return Response.json({ categories: [], etag: 'synthetic' });
    },
  });
});
afterAll(async () => { await harness.dispose(); });

test('forwards Mail reads and authorized writes without browser credentials', async () => {
  const read = await harness.fetch('/api/plus/v1/mailSettings:read');
  expect(await read.json()).toEqual({ categories: [], etag: 'synthetic' });
  const input = { categories: [], etag: 'synthetic' };
  const write = await harness.mutate('POST', '/api/plus/v1/mailSettings:updateCategories', input);
  expect(write.status).toBe(200);
  const writeRequest = forwarded[1];
  if (!writeRequest) throw new Error("Missing forwarded write");
  expect(JSON.parse(writeRequest.body)).toEqual(input);
  for (const request of forwarded) {
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cf-access-jwt-assertion')).toBe(false);
    expect(request.headers.has('x-csrf-token')).toBe(false);
  }
  const refused = await harness.fetch('/api/plus/v1/mailSettings:updateCategories', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: harness.url.origin }, body: JSON.stringify(input),
  });
  expect(refused.status).toBe(403);
  expect(forwarded).toHaveLength(2);
});

test("answers FlowDay's old Focus paths as unknown routes and forwards nothing", async () => {
  const before = forwarded.length;
  for (const [method, path] of [
    ['GET', '/api/plus/flowday/api/v1/timerSession'],
    ['GET', '/api/plus/flowday/api/v1/flows/2026-10-13'],
  ] as const) {
    const response = await harness.fetch(path, { method });
    expect(response.status).toBe(404);
  }
  const write = await harness.mutate('POST', '/api/plus/flowday/api/v1/timerSession:command', { action: 'start' });
  expect(write.status).toBe(404);
  expect(forwarded).toHaveLength(before);
});
