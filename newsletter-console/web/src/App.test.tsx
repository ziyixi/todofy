import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { parseStatus } from '@ziyixi/proto/rpc-status';
import { App, linkOf } from './App.tsx';
import { client } from './api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The error the shared client throws for a Status body with this ErrorInfo reason. */
function statusError(httpStatus: number, reason: string): RpcStatusError {
  const body = { error: { code: httpStatus, message: '', status: 'UNAVAILABLE', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'news.ziyixi.science' },
  ] } };
  const status = parseStatus(httpStatus, body);
  if (status === null) throw new Error('synthetic Status did not parse');
  return new RpcStatusError(status);
}

function show(failure: unknown): void {
  vi.spyOn(client, 'getOverview').mockRejectedValue(failure);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><App /></QueryClientProvider>);
}

describe('the console shell', () => {
  it('names the record and the backup in the masthead', async () => {
    show(statusError(503, 'NOT_CONFIGURED'));
    expect(screen.getByRole('heading', { level: 1, name: '每日简报' })).toBeVisible();
    expect(screen.getByText('记录以 Newsletter 的 SQLite 为准；Notion 是异步备份。')).toBeVisible();
    expect(screen.getByRole('link', { name: '跳到正文' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('link', { name: '返回 Home' })).toHaveAttribute('href', import.meta.env.VITE_HOME_URL);
    expect(await screen.findByRole('heading', { name: /尚未接通/ })).toBeVisible();
  });

  it('says the read path is not connected yet while the Worker answers NOT_CONFIGURED', async () => {
    show(statusError(503, 'NOT_CONFIGURED'));
    expect(await screen.findByText('控制台已就位，Newsletter 的只读接口尚未接通。')).toBeVisible();
    expect(screen.queryByText(/无法连接/)).toBeNull();
  });

  it('shows the host-down notice when Newsletter does not answer', async () => {
    show(statusError(503, 'UNAVAILABLE'));
    expect(await screen.findByRole('heading', { name: /无法连接 Newsletter 服务/ })).toBeVisible();
    expect(screen.getByText('主机、隧道或正在进行的发布都会造成这种情况。Notion 中的备份仍可阅读。')).toBeVisible();
  });

  it('asks for a new login when Access no longer admits the request', async () => {
    show(statusError(401, 'UNAUTHORIZED'));
    expect(await screen.findByRole('heading', { name: '登录已过期' })).toBeVisible();
  });

  it('names both causes when fetch itself fails, never claiming the login expired', async () => {
    show(new TypeError('Failed to fetch'));
    expect(await screen.findByRole('heading', { name: /无法连接控制台，或登录已过期/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '登录已过期' })).toBeNull();
  });

  it('reads each answer of the overview read as one connection state', () => {
    expect(linkOf(true, null)).toBe('checking');
    expect(linkOf(false, null)).toBe('connected');
    expect(linkOf(false, statusError(503, 'NOT_CONFIGURED'))).toBe('not_configured');
    expect(linkOf(false, statusError(503, 'UNAVAILABLE'))).toBe('unavailable');
    expect(linkOf(false, statusError(401, 'UNAUTHORIZED'))).toBe('signed_out');
    // fetch refuses to follow Access's redirect to its login page (redirect: 'error'), and fails the same way offline.
    expect(linkOf(false, new TypeError('redirect'))).toBe('unreachable');
    expect(linkOf(false, statusError(500, 'INTERNAL'))).toBe('failed');
    expect(linkOf(false, new Error('unexpected'))).toBe('failed');
  });

  it('is light only', () => {
    const css = readFileSync(join(import.meta.dirname, 'style.css'), 'utf8');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain('color-scheme: light');
    expect(readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')).toContain('<meta name="color-scheme" content="light" />');
  });
});
