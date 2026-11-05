/**
 * contracts/ops-v1: the exact bytes the links app's Ops answers for fixed synthetic facts (src/ops-status.ts). Home reads
 * them through its LINKS binding. The healthy and degraded answers are the shared contract fixtures
 * OpsStatus/links-ok.json and OpsStatus/links-degraded.json, which Home and the other contract readers consume; every
 * answer passes the generated schema. All facts are synthetic.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { allowedOrigins, authenticate, checkCsrf } from '../src/auth.ts';
import { planBackup } from '../src/backup.ts';
import { backupFacts, MANIFEST, runBackup, STATE } from '../src/backup-runner.ts';
import type { Env } from '../src/env.ts';
import { handleRequest } from '../src/http.ts';
import { linksStatus } from '../src/ops-status.ts';

const CONTRACT = decodeURIComponent(new URL('../../../contracts/ops-v1/', import.meta.url).pathname);
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/OpsStatus/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-28T06:00:00Z');
const HOUR = 3_600_000;
const host = 's.example.org';

test('a backup half an hour old: healthy, with its age and time', () => {
  const answer = linksStatus({
    now: NOW,
    host,
    database: true,
    backup: { status: 'ok', last_backup_at: NOW - HOUR / 2, since: NOW - 40 * 24 * HOUR },
  });
  expect(JSON.stringify(answer)).toBe(JSON.stringify(fixture('links-ok.json')));
  expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});

test('no complete backup for four days and the last job failed: degraded, stale first', () => {
  const answer = linksStatus({
    now: NOW,
    host,
    database: true,
    backup: { status: 'failed', last_backup_at: NOW - 4 * 24 * HOUR, since: NOW - 40 * 24 * HOUR },
  });
  expect(JSON.stringify(answer)).toBe(JSON.stringify(fixture('links-degraded.json')));
  expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});

test('before the first backup, without the bucket, and without the database', () => {
  const never = linksStatus({ now: NOW, host, database: true, backup: { status: 'never', last_backup_at: null, since: null } });
  expect(never).toMatchObject({ health: 'ok', signals: [], counters: { database_ready: 1 }, last_backup_at: null });
  expect(linksStatus({ now: NOW, host, database: true, backup: null })).toEqual(never);
  const down = linksStatus({ now: NOW, host: null, database: false, backup: null });
  expect(down).toMatchObject({ health: 'down', signals: [{ code: 'status_unavailable', severity: 'critical' }], counters: {} });
  expect(down.ui_url).toBeNull();
  for (const answer of [never, down]) expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});

test('auth: missing Access config answers 503 ACCESS_NOT_CONFIGURED and non-bypass CSRF enforces the public origin', async () => {
  const unconfiguredEnv: Env = { DB: {} as D1Database, ASSETS: {} as Fetcher, PUBLIC_HOST: host };
  expect(await authenticate(new Request('https://s.example.org/_/api/v1/links'), unconfiguredEnv)).toEqual({
    ok: false,
    failure: 'not_configured',
  });
  const response = await handleRequest(new Request('https://s.example.org/_/api/v1/links'), unconfiguredEnv);
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('ACCESS_NOT_CONFIGURED');

  expect(allowedOrigins(unconfiguredEnv, new URL('http://127.0.0.1/_/api/v1/links'), false)).toEqual(['https://s.example.org']);
  expect(allowedOrigins({ DB: {} as D1Database, ASSETS: {} as Fetcher }, new URL('https://s.example.org/_/api/v1/links'), false)).toEqual([]);

  const validCsrfRequest = new Request('https://s.example.org/_/api/v1/links', {
    method: 'POST',
    headers: { origin: 'https://s.example.org', 'x-csrf-token': '1', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(await checkCsrf(validCsrfRequest, unconfiguredEnv, false)).toBe('ok');

  const loopbackOriginRequest = new Request('http://127.0.0.1/_/api/v1/links', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(await checkCsrf(loopbackOriginRequest, unconfiguredEnv, false)).toBe('failed');
  expect(await checkCsrf(validCsrfRequest, { DB: {} as D1Database, ASSETS: {} as Fetcher }, false)).toBe('failed');

  const bypassEnv: Env = { ...unconfiguredEnv, DEV_AUTH_BYPASS: 'true', ACCESS_OWNER: 'owner@example.org' };
  const csrfGet = await handleRequest(new Request('http://127.0.0.1/_/api/csrf'), bypassEnv);
  expect(csrfGet.status).toBe(200);
  expect(await csrfGet.json()).toEqual({ token: '1' });
  const csrfPost = await handleRequest(new Request('http://127.0.0.1/_/api/csrf', { method: 'POST' }), bypassEnv);
  expect(csrfPost.status).toBe(405);
  expect(csrfPost.headers.get('allow')).toBe('GET');
});

test('backup-runner: recovers from state_corrupt, records empty schema_unmigrated, and preserves concurrent_write change marks', async () => {
  const objects = new Map<string, { body: string | Uint8Array; customMetadata?: Record<string, string> }>();
  const bucket = {
    get: (key: string) => {
      const entry = objects.get(key);
      if (!entry) return Promise.resolve(null);
      const text = typeof entry.body === 'string' ? entry.body : new TextDecoder().decode(entry.body);
      return Promise.resolve({
        json: () => {
          try {
            return Promise.resolve(JSON.parse(text) as unknown);
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    },
    put: (key: string, value: string | Uint8Array, options?: { customMetadata?: Record<string, string> }) => {
      objects.set(key, {
        body: value,
        ...(options?.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
      });
      return Promise.resolve();
    },
    list: ({ prefix }: { prefix: string }) =>
      Promise.resolve({
        objects: Array.from(objects.entries())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({
            key,
            size: typeof value.body === 'string' ? value.body.length : value.body.byteLength,
            customMetadata: value.customMetadata,
          })),
        truncated: false,
      }),
    delete: () => Promise.resolve(),
  } as unknown as R2Bucket;

  let updateTime = 100;
  const db = {
    prepare: (query: string) => ({
      query,
      bind: () => ({
        all: () => Promise.resolve({ results: [] }),
      }),
    }),
    batch: (statements: { query: string }[]) =>
      Promise.resolve(
        statements.map((statement) => {
          if (statement.query.includes('d1_migrations')) return { results: [] };
          if (statement.query.includes('max(update_time)')) return { results: [{ n: updateTime }] };
          return { results: [{ n: 0 }] };
        }),
      ),
  } as unknown as D1Database;

  const env: Env = { DB: db, ASSETS: {} as Fetcher, BACKUPS: bucket };

  // 1. state_corrupt: corrupt state.json is treated as lost and replaced by a new plan step.
  objects.set(STATE, { body: '{corrupt-state-json' });
  expect(await backupFacts(env)).toEqual({ status: 'never', last_backup_at: null, since: null });

  // 2. schema_unmigrated: empty d1_migrations table produces schema_version: ''.
  const planned = await planBackup(db);
  expect(planned.schema_version).toBe('');

  const step1 = await runBackup(env, NOW);
  expect(step1.step).toBe('plan');
  const step2 = await runBackup(env, NOW + 1000);
  expect(step2.step).toBe('export');

  // 3. concurrent_write: update_time advances before finish, recording distinct start and end change_marks.
  updateTime = 250;
  const step3 = await runBackup(env, NOW + 2000);
  expect(step3.step).toBe('finish');

  const manifestEntry = Array.from(objects.entries()).find(([key]) => key.endsWith(`/${MANIFEST}`));
  expect(manifestEntry).toBeDefined();
  const manifest = JSON.parse(String(manifestEntry?.[1].body)) as {
    links: {
      schema_version: string;
      change_mark: { start: { update_time: number }; end: { update_time: number } };
    };
  };
  expect(manifest.links.schema_version).toBe('');
  expect(manifest.links.change_mark.start.update_time).toBe(100);
  expect(manifest.links.change_mark.end.update_time).toBe(250);
});

