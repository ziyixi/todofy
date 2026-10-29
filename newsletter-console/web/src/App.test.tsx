import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { parseStatus } from '@ziyixi/proto/rpc-status';
import { linkOf } from './App.tsx';
import { routeOf } from './route.ts';
import { BLOCKED_RUN, EDITION, fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

/** A Status answer with this ErrorInfo reason, as the Worker writes it. */
function status(httpStatus: number, reason: string): () => Response {
  return () => Response.json({ error: { code: httpStatus, message: '', status: 'UNAVAILABLE', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'news.ziyixi.science' },
  ] } }, { status: httpStatus });
}

function statusError(httpStatus: number, reason: string): RpcStatusError {
  const parsed = parseStatus(httpStatus, { error: { code: httpStatus, message: '', status: 'UNAVAILABLE', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'news.ziyixi.science' },
  ] } });
  if (parsed === null) throw new Error('synthetic Status did not parse');
  return new RpcStatusError(parsed);
}

describe('the console shell', () => {
  it('names the record and the backup, links Home and Fleet, and marks the current tab', async () => {
    serve(world());
    show('#/');
    expect(screen.getByRole('heading', { level: 1, name: '每日简报' })).toBeVisible();
    expect(screen.getByText('记录以 Newsletter 的 SQLite 为准；Notion 是异步备份。')).toBeVisible();
    expect(screen.getByRole('link', { name: '跳到正文' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('link', { name: '返回 Home' })).toHaveAttribute('href', import.meta.env.VITE_HOME_URL);
    expect(screen.getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', import.meta.env.VITE_FLEET_URL);
    const tabs = within(screen.getByRole('navigation', { name: '页面' }));
    expect(tabs.getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: '运行' })).not.toHaveAttribute('aria-current');
    expect(await screen.findByText('数据时间')).toBeVisible();
  });

  it('routes the runs and a run to the 运行 tab', async () => {
    serve(world());
    show('#/runs');
    const tabs = within(screen.getByRole('navigation', { name: '页面' }));
    expect(tabs.getByRole('link', { name: '运行' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: '2026年10月' })).toBeVisible();
    cleanup();
    show(`#/${BLOCKED_RUN}`);
    expect(within(screen.getByRole('navigation', { name: '页面' })).getByRole('link', { name: '运行' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: '10月28日 周三' })).toBeVisible();
  });

  it('moves focus to the content from the skip link and stays on the page', async () => {
    serve(world());
    show('#/sources');
    await screen.findByRole('heading', { name: '来源' });
    fireEvent.click(screen.getByRole('link', { name: '跳到正文' }));
    expect(window.location.hash).toBe('#/sources');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('has a tab for each page, and gives an issue to 期刊 and a run to 运行', async () => {
    const pages: [string, string][] = [
      ['#/issues', '期刊'], [`#/${EDITION.replace('editions/', 'issues/')}`, '期刊'], ['#/sources', '来源'], ['#/models?days=90', '模型'], ['#/backup', '备份'],
    ];
    for (const [hash, tab] of pages) {
      serve(world());
      show(hash);
      const tabs = within(screen.getByRole('navigation', { name: '页面' }));
      expect(tabs.getAllByRole('link').map((link) => link.textContent)).toEqual(['概览', '期刊', '运行', '来源', '模型', '备份']);
      expect(tabs.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual([tab]);
      await screen.findByText('数据时间');
      cleanup();
    }
  });

  it('reads the hash as a page, a run or a month, never anything else', () => {
    expect(routeOf('')).toEqual({ page: 'overview' });
    expect(routeOf('#/')).toEqual({ page: 'overview' });
    expect(routeOf('#/runs')).toEqual({ page: 'runs', month: '' });
    expect(routeOf('#/runs?month=2026-09')).toEqual({ page: 'runs', month: '2026-09' });
    expect(routeOf('#/runs?month=../x')).toEqual({ page: 'runs', month: '' });
    expect(routeOf('#/runs/00000000-0000-4000-8000-000000002800')).toEqual({ page: 'run', id: '00000000-0000-4000-8000-000000002800' });
    expect(routeOf('#/runs/a%2Fb')).toEqual({ page: 'runs', month: '' });
    expect(routeOf('#/somewhere')).toEqual({ page: 'overview' });
    expect(routeOf('#/issues')).toEqual({ page: 'issues', month: '', filter: 'all' });
    expect(routeOf('#/issues?month=2026-09&show=unsent')).toEqual({ page: 'issues', month: '2026-09', filter: 'unsent' });
    expect(routeOf('#/issues?show=everything')).toEqual({ page: 'issues', month: '', filter: 'all' });
    expect(routeOf('#/issues/abc-1')).toEqual({ page: 'issue', id: 'abc-1', view: 'read' });
    expect(routeOf('#/issues/abc-1?view=mail')).toEqual({ page: 'issue', id: 'abc-1', view: 'mail' });
    expect(routeOf('#/issues/abc-1?view=html')).toEqual({ page: 'issue', id: 'abc-1', view: 'read' });
    expect(routeOf('#/issues/a%2Fb')).toEqual({ page: 'issues', month: '', filter: 'all' });
    expect(routeOf('#/models')).toEqual({ page: 'models', days: 7 });
    expect(routeOf('#/models?days=90')).toEqual({ page: 'models', days: 90 });
    expect(routeOf('#/models?days=1000')).toEqual({ page: 'models', days: 7 });
    expect(routeOf('#/sources')).toEqual({ page: 'sources' });
    expect(routeOf('#/backup')).toEqual({ page: 'backup' });
  });

  it('is light only', () => {
    const css = readFileSync(join(import.meta.dirname, 'style.css'), 'utf8');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain('color-scheme: light');
    expect(readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')).toContain('<meta name="color-scheme" content="light" />');
  });
});

/** The attention line, once the overview has been read. */
async function attentionLine(text: RegExp): Promise<HTMLElement> {
  const line = (await screen.findByText(text)).closest('p');
  if (line === null) throw new Error('no attention line');
  return line;
}

describe('the attention line', () => {
  it("says the newest scheduled run's issue reached the mail service", async () => {
    serve(world());
    show('#/');
    const line = await attentionLine(/已交给邮件服务/);
    expect(line).toHaveTextContent('●10月29日 已交给邮件服务查看运行 →');
    expect(within(line).getByRole('link', { name: '查看运行 →' })).toHaveAttribute('href', '#/runs/00000000-0000-4000-8000-000000002900');
  });

  it('says why nothing was sent, in words, with the budget the run froze', async () => {
    const overview = fixture('overview');
    serve(world({ '/api/v1/overview': { ...overview, latest_run: fixture<{ runs: unknown[] }>('runs').runs[2] } }));
    show('#/');
    const line = await attentionLine(/10月28日 未发出/);
    expect(line).toHaveTextContent('■10月28日 未发出 · 选题超出节点预算（用时 161 秒 / 预算 150 秒）');
    expect(line).toHaveClass('bad');
    expect(within(line).getByRole('link', { name: '查看运行 →' })).toHaveAttribute('href', `#/${BLOCKED_RUN}`);
  });

  it('shows an unknown stop code as it is, never as healthy', async () => {
    const overview = fixture('overview');
    serve(world({ '/api/v1/overview': { ...overview, latest_run: { name: BLOCKED_RUN, issue_date: '2026-10-28', state: 'failed', stop_reason: 'brand_new_code' } } }));
    show('#/');
    expect(await attentionLine(/10月28日 未发出/)).toHaveTextContent('■10月28日 未发出 · brand_new_code');
  });
});

describe('connection states', () => {
  it('shows the host-down notice, with Fleet and Home, when Newsletter does not answer', async () => {
    serve({ '/api/v1/overview': status(503, 'UNAVAILABLE') });
    show('#/');
    expect(await screen.findByRole('heading', { name: /无法连接 Newsletter 服务/ })).toBeVisible();
    expect(screen.getByText('主机、隧道或正在进行的发布都会造成这种情况。Notion 中的备份仍可阅读。')).toBeVisible();
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', import.meta.env.VITE_FLEET_URL);
    expect(main.getByRole('link', { name: 'Home' })).toHaveAttribute('href', import.meta.env.VITE_HOME_URL);
  });

  it('says the transport is not set up while the Worker answers NOT_CONFIGURED', async () => {
    serve({ '/api/v1/overview': status(503, 'NOT_CONFIGURED') });
    show('#/');
    expect(await screen.findByRole('heading', { name: /尚未接通/ })).toBeVisible();
    expect(screen.queryByText(/无法连接/)).toBeNull();
  });

  it('asks for a new login when Access no longer admits the request', async () => {
    serve({ '/api/v1/overview': status(401, 'UNAUTHORIZED') });
    show('#/');
    expect(await screen.findByRole('heading', { name: '登录已过期' })).toBeVisible();
  });

  it('names both causes when fetch itself fails, never claiming the login expired', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    show('#/');
    expect(await screen.findByRole('heading', { name: /无法连接控制台，或登录已过期/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '登录已过期' })).toBeNull();
  });

  it('says a refresh failed rather than show the earlier read as current', async () => {
    let reads = 0;
    serve(world({ '/api/v1/overview': () => (reads++ === 0 ? Response.json(fixture('overview')) : status(503, 'UNAVAILABLE')()) }));
    show('#/');
    await attentionLine(/已交给邮件服务/);
    expect(screen.queryByText(/刷新失败/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '刷新' }));
    expect(await screen.findByText(/^刷新失败：无法连接 Newsletter 服务。下方保留 .+ 读取的记录。$/)).toBeVisible();
    // The earlier read stays, under that line.
    expect(screen.getByRole('region', { name: '合成期刊 10/29' })).toBeVisible();
    expect(reads).toBe(2);
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
});
