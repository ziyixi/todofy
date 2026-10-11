// The options (src/settings.ts, src/options-view.ts): what the owner may type, where the token is kept, and what the
// page says about the uploads. Synthetic tokens only.
import { describe, expect, it } from 'vitest';
import { getToken, queueItem } from '../src/db.ts';
import { statusRows, ago, buildLine, SAVE_ERRORS } from '../src/options-view.ts';
import { currentDenylist, parseLabel, parseServer, parseToken, saveSettings, status } from '../src/settings.ts';
import { getDevice, lastError, uploadState, INITIAL_UPLOAD } from '../src/store.ts';
import type { Status } from '../src/messages.ts';
import { harness, INGEST_TOKEN, MINUTE, T0 } from './fake-chrome.ts';

describe('what the owner may type', () => {
  it('a server: https, or http on loopback, without a path, query, fragment or user', () => {
    expect(parseServer(' https://recall.ziyixi.science ')).toBe('https://recall.ziyixi.science');
    expect(parseServer('https://recall.example.com/')).toBe('https://recall.example.com');
    expect(parseServer('http://127.0.0.1:8797')).toBe('http://127.0.0.1:8797');
    expect(parseServer('http://localhost:8797/')).toBe('http://localhost:8797');
    for (const bad of ['http://recall.example.com', 'https://recall.example.com/api', 'https://recall.example.com/?a=1', 'https://user:pw@recall.example.com', 'ftp://recall.example.com', 'recall.example.com', '']) {
      expect(parseServer(bad), bad).toBeNull();
    }
  });

  it('an ingest token in the shape recall\'s 设置 makes, and the export token told apart', () => {
    expect(parseToken(` ${INGEST_TOKEN}\n`)).toEqual({ token: INGEST_TOKEN });
    expect(parseToken(`recall_export_${'A'.repeat(43)}`)).toEqual({ error: 'token_export' });
    for (const bad of ['', 'recall_ingest_short', `recall_ingest_${'A'.repeat(42)}!`, `Bearer ${INGEST_TOKEN}`]) {
      expect(parseToken(bad), bad).toEqual({ error: 'token_invalid' });
    }
  });

  it('a label of 1 to 64 characters, trimmed', () => {
    expect(parseLabel('  MacBook · 工作 ')).toBe('MacBook · 工作');
    expect(parseLabel('😀'.repeat(64))).toBe('😀'.repeat(64));
    expect(parseLabel('😀'.repeat(65))).toBeNull();
    expect(parseLabel('   ')).toBeNull();
  });
});

describe('saving', () => {
  it('keeps the token in the IndexedDB, never in chrome.storage, and keeps it when the field is left empty', async () => {
    const { ctx, browser } = await harness();
    expect(await saveSettings(ctx, { server: 'https://recall.ziyixi.science', label: 'MacBook', token: INGEST_TOKEN })).toEqual({ ok: true });
    expect(await getToken(ctx.db)).toBe(INGEST_TOKEN);
    expect(JSON.stringify([...browser.local.values, ...browser.session.values])).not.toContain('recall_ingest_');
    expect(await saveSettings(ctx, { server: 'https://recall.ziyixi.science', label: 'MacBook · 家', token: '' })).toEqual({ ok: true });
    expect(await getToken(ctx.db)).toBe(INGEST_TOKEN);
    expect((await getDevice(ctx.chrome, ctx.uuid)).label).toBe('MacBook · 家');
  });

  it('refuses what does not parse and changes nothing', async () => {
    const { ctx } = await harness();
    expect(await saveSettings(ctx, { server: 'http://recall.example.com', label: 'x', token: '' })).toEqual({ ok: false, error: 'server_invalid' });
    expect(await saveSettings(ctx, { server: 'https://recall.ziyixi.science', label: '', token: '' })).toEqual({ ok: false, error: 'label_invalid' });
    expect(await saveSettings(ctx, { server: 'https://recall.ziyixi.science', label: 'x', token: `recall_export_${'A'.repeat(43)}` })).toEqual({ ok: false, error: 'token_export' });
    expect(await getToken(ctx.db)).toBe('');
    expect((await getDevice(ctx.chrome, ctx.uuid)).label).toBe('Chrome');
  });

  it('a new server is one of recall\'s own hosts: its pages are never recorded', async () => {
    const { ctx } = await harness();
    await saveSettings(ctx, { server: 'https://recall.example.com', label: 'x', token: '' });
    expect((await currentDenylist(ctx)).ownHosts).toEqual(['recall.ziyixi.science', 'recall.example.com']);
  });
});

describe('the options page\'s status', () => {
  const base: Status = {
    now: T0,
    version: '2026.1010.900',
    versionName: 'abc1234',
    deviceId: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10',
    label: 'MacBook',
    server: 'https://recall.ziyixi.science',
    tokenSet: true,
    queued: 3,
    held: 0,
    upload: { ...INITIAL_UPLOAD, lastUploadAt: T0 - 3 * MINUTE },
    lastError: null,
  };
  const first = (status: Status) => statusRows(status)[0];

  it('says when the last upload was, and what waits', () => {
    expect(statusRows(base).map((row) => [row.label, row.value])).toEqual([
      ['状态', '最近上传 3 分钟前'],
      ['待上传', '3 条（移除扩展会删除还没上传的记录）'],
      ['设备 ID', base.deviceId],
    ]);
    expect(buildLine(base)).toBe('版本 2026.1010.900 · abc1234');
  });

  it('warns about a missing or refused token, failing uploads and refused items', () => {
    expect(first({ ...base, tokenSet: false })).toMatchObject({ value: '还没有令牌：先粘贴上传令牌并保存', warn: true });
    expect(first({ ...base, upload: { ...base.upload, tokenRefused: true } })).toMatchObject({ value: '令牌无效：recall 拒绝了它，请粘贴新的令牌', warn: true });
    expect(first({ ...base, upload: { ...base.upload, failingSince: T0 - 2 * 60 * MINUTE, nextAttemptAt: T0 + 30 * MINUTE } })).toMatchObject({
      value: '上传失败，30 分钟后重试（从 2 小时前开始）',
      warn: true,
    });
    expect(first({ ...base, upload: { ...base.upload, nextAttemptAt: T0 + 5 * 60 * MINUTE } })).toMatchObject({ value: 'recall 暂停接收，5 小时后继续', warn: false });
    expect(statusRows({ ...base, upload: { ...base.upload, rejectedCount: 2 } })[2]).toMatchObject({ label: '被拒', value: '2 条已丢失：扩展可能有问题', warn: true });
    expect(statusRows({ ...base, lastError: { code: 'capture_failed', at: T0 - 5 * MINUTE } })[2]).toMatchObject({ value: 'capture_failed（5 分钟前）' });
  });

  it('reads the extension\'s state', async () => {
    const { ctx } = await harness();
    await queueItem(ctx.db, { id: 'a', kind: 'visit', json: '{}', version: 1 }, T0);
    await uploadState.set(ctx.chrome, { ...INITIAL_UPLOAD, lastUploadAt: T0 - MINUTE });
    await lastError.set(ctx.chrome, 'upload_failed', T0);
    expect(await status(ctx)).toMatchObject({ version: '2026.1010.900', versionName: 'abc1234', tokenSet: false, queued: 1, lastError: { code: 'upload_failed' } });
  });

  it('formats times and explains every refused save', () => {
    expect([ago(30_000), ago(3 * MINUTE), ago(5 * 60 * MINUTE), ago(3 * 24 * 60 * MINUTE)]).toEqual(['刚刚', '3 分钟前', '5 小时前', '3 天前']);
    expect(Object.keys(SAVE_ERRORS).sort()).toEqual(['label_invalid', 'server_invalid', 'token_export', 'token_invalid']);
  });
});
