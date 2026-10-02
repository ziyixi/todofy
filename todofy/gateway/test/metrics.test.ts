import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { routeOf } from '../src/metrics.ts';
import { fakes, hooks, owner, send } from './helpers.ts';

const EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001';

/** The gateway env with a recording Analytics Engine dataset. */
function withMetrics(env: Env, fail = false): { env: Env; points: AnalyticsEngineDataPoint[] } {
  const points: AnalyticsEngineDataPoint[] = [];
  const METRICS: AnalyticsEngineDataset = {
    writeDataPoint(point) {
      if (fail) throw new Error('dataset unavailable');
      if (point) points.push(point);
    },
  };
  return { env: { ...env, METRICS }, points };
}

describe('route labels', () => {
  it.each([
    ['owner', '/api/csrf', '/api/csrf'],
    ['owner', '/api/v1/mailEvents', '/api/v1/mailEvents'],
    ['owner', `/api/v1/mailEvents/${EVENT_ID}`, '/api/v1/mailEvents/{id}'],
    ['owner', `/api/v1/mailEvents/${EVENT_ID}:reconcile`, '/api/v1/mailEvents/{id}:reconcile'],
    ['owner', '/api/v1/legacyTexts/legacy%3Aabc', '/api/v1/legacyTexts/{id}'],
    ['owner', '/api/v1/latestReports:recompute', '/api/v1/latestReports:recompute'],
    ['owner', '/api/v1/metricDays', '/api/v1/metricDays'],
    ['owner', '/api/v1/gtdReviews', '/api/v1/gtdReviews'],
    // The owner API before todofy.ui.v1 (410 for one release).
    ['owner', '/api/v1/events', '/api/v1/events'],
    ['owner', `/api/v1/events/${EVENT_ID}/reconcile`, '/api/v1/events/{id}/reconcile'],
    ['owner', '/api/v1/legacy_text/legacy:abc', '/api/v1/legacy_text/{id}'],
    ['owner', '/api/v1/anything/else', '/api/other'],
    ['owner', '/assets/app-1a2b3c.js', 'asset'],
    ['owner', `/events/${EVENT_ID}`, 'page'],
    ['hooks', '/hooks/mail', '/hooks/mail'],
    ['hooks', '/hooks/mail/extra', 'other'],
    ['unknown', '/health', 'other'],
    ['cron', '', 'wake'],
  ] as const)('%s %s → %s', (kind, path, label) => {
    expect(routeOf(kind, path)).toBe(label);
  });
});

describe('request data points', () => {
  it('writes one point per request with the route template, never the path or query', async () => {
    const { env, points } = withMetrics(fakes().env);
    const response = await owner(env, `/api/v1/mailEvents/${EVENT_ID}?secret=1`);
    expect(points).toEqual([
      {
        indexes: ['/api/v1/mailEvents/{id}'],
        blobs: ['owner', 'GET', '/api/v1/mailEvents/{id}', `${String(Math.floor(response.status / 100))}xx`],
        doubles: [expect.any(Number), 0, 0],
      },
    ]);
    expect(JSON.stringify(points)).not.toContain(EVENT_ID);
    expect(JSON.stringify(points)).not.toContain('secret');
  });

  it('records the declared sizes and the status class of a rejected webhook', async () => {
    const { env, points } = withMetrics(fakes({ MAIL_WEBHOOK_TOKEN_SHA256: 'ab'.repeat(32) }).env);
    const response = await hooks(env, '/hooks/mail', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json', 'content-length': '2' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs).toEqual(['hooks', 'POST', '/hooks/mail', '4xx']);
    expect(points[0]?.doubles?.slice(1)).toEqual([2, Number(response.headers.get('content-length') ?? 0)]);
  });

  it('labels unknown hosts and methods without their names', async () => {
    const { env, points } = withMetrics(fakes().env);
    await send(env, 'http://elsewhere.example/whatever', { method: 'PROPFIND' });
    expect(points[0]?.blobs).toEqual(['unknown', 'OTHER', 'other', '4xx']);
  });

  it('never lets a failing dataset change the answer', async () => {
    const { env } = withMetrics(fakes().env, true);
    const response = await hooks(env, '/health');
    expect(response.status).toBe(200);
  });
});

describe('cron data points', () => {
  it('records a successful wake', async () => {
    const { env, points } = withMetrics(fakes().env);
    await worker.scheduled({ cron: '*/10 * * * *' } as ScheduledController, env);
    expect(points).toEqual([
      { indexes: ['wake'], blobs: ['cron', 'POST', 'wake', '2xx'], doubles: [expect.any(Number), 0, 0] },
    ]);
  });

  it('records a failed wake as 5xx and still fails the invocation', async () => {
    const { env, points } = withMetrics(
      fakes({}, () => {
        throw new Error('stub down');
      }).env,
    );
    await expect(worker.scheduled({ cron: '*/10 * * * *' } as ScheduledController, env)).rejects.toThrow('stub down');
    expect(points[0]?.blobs).toEqual(['cron', 'POST', 'wake', '5xx']);
  });
});
