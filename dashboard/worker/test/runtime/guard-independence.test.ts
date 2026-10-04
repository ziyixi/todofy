import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { HomeView, OverrideGuardResponse } from '../../src/api-types.ts';
import { d1Reads, NOW, PATHS, shedState, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

it('shows no aggregate shed after each service is restored while account usage remains high', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
  await h.tick(NOW - 20 * 60_000);
  for (const app of ['mail-hero', 'todofy', 'lab', 'watch'] as const) {
    expect((await h.post(PATHS.guard, { app, level: 'normal' })).status).toBe(200);
  }
  expect((await h.snapshot()).digest.items.some((item) => item.code === 'guard_shed')).toBe(false);
  await h.tick(NOW + 60_000);

  const home = await h.view<HomeView>('home');
  expect(home.body?.cloudflare.guard_level).toBe('normal');
  const snapshot = await h.snapshot();
  expect(snapshot.usage.rows.find((row) => row.id === 'd1_rows_read')?.percent).toBe(90);
  expect(snapshot.digest.items.some((item) => item.code === 'guard_shed')).toBe(false);
  expect(snapshot.ops.attention.items.some((item) => item.code === 'guard_shed')).toBe(false);
});

it('excludes a service without the guard capability from the aggregate target', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
  await h.answer('watch', 'status', { value: await status('watch', { capabilities: [] }) });
  await h.tick(NOW - 20 * 60_000);
  for (const app of ['mail-hero', 'todofy', 'lab'] as const) {
    expect((await h.post(PATHS.guard, { app, level: 'normal' })).status).toBe(200);
  }

  const home = await h.view<HomeView>('home');
  expect(home.body?.cloudflare.guard_level).toBe('normal');
  expect((await h.snapshot()).guard.apps.watch).toBeUndefined();
  expect(await h.callsOf('watch', 'setGuard')).toEqual([]);
});

it('shows one manually delayed service in Home and its own held marker', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
  await h.tick(NOW - 20 * 60_000);
  const held = shedState('2026-10-02T12:00:00.000Z', 'owner_shed', '2026-10-01T12:00:00.000Z');
  await h.answer('watch', 'setGuard', { value: held });
  expect((await h.post(PATHS.guard, { app: 'watch', level: 'shed' })).status).toBe(200);

  const home = await h.view<HomeView>('home');
  expect(home.body?.cloudflare.guard_level).toBe('shed');
  const snapshot = await h.snapshot();
  expect(snapshot.ops.attention.held).toContainEqual({ entry: 'watch', code: 'owner_shed', target: { view: 'ops', entry: 'watch' } });
  expect(snapshot.ops.attention.held.some((item) => item.code === 'owner_shed' && item.entry !== 'watch')).toBe(false);
  expect(snapshot.ops.attention.items.some((item) => item.code === 'guard_shed')).toBe(false);
  for (const app of ['mail-hero', 'todofy', 'lab'] as const) expect(await h.callsOf(app, 'setGuard')).toEqual([]);
});

it('restores a cached remote shed even when its earlier receipt was not saved', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
  await h.tick(NOW - 20 * 60_000);
  const held = shedState('2026-10-02T00:00:00.000Z', 'owner_shed', '2026-10-01T11:50:00.000Z');
  await h.answer('mail-hero', 'status', { value: await status('mail-hero', { guard: held }) });
  await h.refresh('home');

  const response = await h.post(PATHS.guard, { app: 'mail-hero', level: 'normal' });

  expect(response.status).toBe(200);
  expect(await h.callsOf('mail-hero', 'setGuard')).toEqual([[{ level: 'normal', reason: 'owner_clear', until: null }]]);
  for (const app of ['todofy', 'lab', 'watch'] as const) expect(await h.callsOf(app, 'setGuard')).toEqual([]);
});

it('replays the selected service answer and rejects reuse for another service', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
  await h.tick(NOW - 20 * 60_000);
  const requestId = 'e6316140-383e-4ee4-8467-6af6a2e03da7';
  const input = { app: 'mail-hero', level: 'shed', request_id: requestId };
  const first = await h.post(PATHS.guard, input);
  expect(first.status).toBe(200);
  const firstBody = await first.text();
  expect(await h.callsOf('mail-hero', 'setGuard')).toHaveLength(1);

  const replay = await h.post(PATHS.guard, input);
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(firstBody);
  expect(await h.callsOf('mail-hero', 'setGuard')).toEqual([]);

  const changed = await h.post(PATHS.guard, { ...input, app: 'todofy' });
  expect(changed.status).toBe(400);
  expect(await h.callsOf('todofy', 'setGuard')).toEqual([]);
  expect((await h.snapshot()).guard.apps.todofy?.override).toBeUndefined();
});

it('lets a service override expire without resetting another service', async () => {
  h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
  await h.tick(NOW - 20 * 60_000);
  const held = shedState('2026-10-02T12:00:00.000Z', 'owner_shed', '2026-10-01T12:00:00.000Z');
  await h.answer('watch', 'setGuard', { value: held });
  expect((await h.post(PATHS.guard, { app: 'watch', level: 'shed' })).status).toBe(200);
  expect(await h.callsOf('watch', 'setGuard')).toHaveLength(1);
  await h.answer('watch', 'setGuard', undefined);

  await h.tick('2026-10-02T12:01:00Z');

  expect(await h.callsOf('watch', 'setGuard')).toEqual([[{ level: 'normal', reason: 'quota_normal', until: null }]]);
  for (const app of ['mail-hero', 'todofy', 'lab'] as const) expect(await h.callsOf(app, 'setGuard')).toEqual([]);
});

it('migrates the previous global owner setting once, preserving its absolute expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-guard-migration-'));
  const legacy = { level: 'shed', until: NOW + 23 * 60 * 60_000, set_at: NOW - 60 * 60_000 };
  try {
    h = await startFlows({ persist: dir, bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(NOW - 20 * 60_000);
    await h.dispose();
    h = undefined;
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.sqlite'));
    let owners = 0;
    for (const file of files) {
      const db = new DatabaseSync(join(dir, file));
      try {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get()) continue;
        db.prepare('INSERT INTO state (key,doc,updated_at) VALUES (?,?,?)').run('guard_override', JSON.stringify(legacy), legacy.set_at);
        owners++;
      } finally {
        db.close();
      }
    }
    expect(owners).toBe(1);

    h = await startFlows({ persist: dir, bindings: { CANARY_UTC_HOUR: '23' } });
    const snapshot = await h.snapshot();
    expect(snapshot.guard.override).toBeNull();
    for (const app of ['mail-hero', 'todofy', 'lab', 'watch'] as const) {
      expect(snapshot.guard.apps[app]?.override).toEqual({ level: 'shed', until: '2026-10-02T11:00:00.000Z', set_at: '2026-10-01T11:00:00.000Z' });
    }
    const response = await h.post(PATHS.guard, { app: 'mail-hero', level: 'normal' });
    expect(response.status).toBe(200);
    const changed = await response.json() as OverrideGuardResponse;
    expect(changed.guard.apps['mail-hero']?.override?.level).toBe('normal');
    expect(changed.guard.apps.todofy?.override?.level).toBe('shed');
    await h.redeploy({ BUILD_SHA: 'migration-restart' });
    expect((await h.snapshot()).guard.apps['mail-hero']?.override?.level).toBe('normal');
  } finally {
    await h?.dispose();
    h = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});
