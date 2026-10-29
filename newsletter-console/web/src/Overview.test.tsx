import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayMark } from './Overview.tsx';
import { fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('概览', () => {
  it('leads with the latest issue: its title, introduction and the three marks', async () => {
    serve(world());
    show('#/');
    const hero = await section('合成期刊 10/29');
    expect(hero.getByText('最新一期 · 10月29日 周四 · 日常')).toBeVisible();
    expect(hero.getByText('合成导读。')).toBeVisible();
    expect(hero.getByText('运行').nextElementSibling).toHaveTextContent('●已生成');
    expect(hero.getByText('投递').nextElementSibling).toHaveTextContent('●邮件服务已接收');
    expect(hero.getByText('Notion 备份').nextElementSibling).toHaveTextContent('◆同步中');
    expect(hero.getByRole('link', { name: '查看运行' })).toHaveAttribute('href', '#/runs/00000000-0000-4000-8000-000000002900');
  });

  it('shows Fleet\'s counts and words for the service', async () => {
    serve(world());
    show('#/');
    const service = await section('服务状态');
    expect(service.getByText('后台进程').nextElementSibling).toHaveTextContent('健康');
    expect(service.getByText('发布入口').nextElementSibling).toHaveTextContent('可接收');
    expect(service.getByText('排队').nextElementSibling).toHaveTextContent('0');
    expect(service.getByText('进行中').nextElementSibling).toHaveTextContent('0');
    expect(service.getByText('未确认完成记录').nextElementSibling).toHaveTextContent('2');
    expect(service.getByText(/Notion 创建 1 · Notion 更新 1/)).toBeVisible();
  });

  it('marks each of the 14 days with a shape and a word, oldest first, with a table twin', async () => {
    serve(world());
    show('#/');
    const strip = await section('最近 14 天');
    const days = strip.getAllByRole('listitem').filter((item) => item.closest('ol'));
    expect(days).toHaveLength(14);
    expect(days[0]).toHaveTextContent('16');
    expect(strip.getByRole('link', { name: '10月28日 周三：未发出 · 选题 · 没有可发布内容' })).toHaveAttribute('href', '#/runs/00000000-0000-4000-8000-000000002800');
    expect(strip.getByRole('link', { name: '10月29日 周四：已投递' })).toBeVisible();
    expect(strip.getByRole('link', { name: '10月26日 周一：已生成未投递' })).toBeVisible();
    expect(strip.getByRole('img', { name: '10月16日 周五：尚未运行' })).toBeVisible();
    expect(strip.getByRole('table')).toBeInTheDocument();
  });

  it('reads each strip day by its run and delivery', () => {
    expect(dayMark({ issue_date: '2026-10-01' })).toEqual({ label: '尚未运行', tone: 'none' });
    expect(dayMark({ run: 'runs/a', run_state: 'running' })).toEqual({ label: '运行中', tone: 'unknown' });
    expect(dayMark({ run: 'runs/a', run_state: 'ready', delivery_state: 'unknown' })).toEqual({ label: '结果未确认', tone: 'unknown' });
    expect(dayMark({ run: 'runs/a', run_state: 'ready', delivery_state: 'rejected' })).toEqual({ label: '未发出', tone: 'bad' });
    expect(dayMark({ run: 'runs/a', run_state: 'failed' })).toEqual({ label: '未发出', tone: 'bad' });
  });

  it('counts deliveries, the latest run, model use, feeds and the backup', async () => {
    serve(world());
    show('#/');
    const tiles = within(await screen.findByLabelText('关键数字'));
    expect(tiles.getByText('投递').nextElementSibling).toHaveTextContent('4 / 14');
    expect(tiles.getByText('最近一次运行用时').nextElementSibling).toHaveTextContent('29 分 59 秒');
    expect(tiles.getByText('模型调用 · 7 天').nextElementSibling).toHaveTextContent('19 次');
    expect(tiles.getByText('输入 tokens · 7 天').nextElementSibling).toHaveTextContent('21.8 万');
    expect(tiles.getByText('订阅源 · 最近一次').nextElementSibling).toHaveTextContent('2 / 3 正常');
    expect(tiles.getByText('Notion 待同步').nextElementSibling).toHaveTextContent('7');
  });

  it('draws the flow from the run\'s frozen graph, with Notion beside it and never a step of it', async () => {
    serve(world());
    show('#/');
    const flow = await section('今日流程');
    const steps = within(await flow.findByRole('list', { name: '流程各步' })).getAllByRole('listitem');
    expect(steps.map((step) => step.querySelector('.step-name')?.textContent)).toEqual(
      ['历史', '订阅源', '搜集', '候选', '选题', '规划', '简讯', '深读', '发布', '投递']);
    for (const step of steps) expect(step).not.toHaveTextContent('Notion');
    expect(steps[1]).toHaveTextContent('部分失败');
    expect(flow.getByText('Notion 备份').closest('.side-note')).toHaveTextContent('发布之后异步复制，不是流程中的一步');
  });

  it('lists the external interfaces, the backup as an asynchronous copy', async () => {
    serve(world());
    show('#/');
    const deps = await section('外部接口');
    const rows = deps.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['订阅源 HTTP', 'Model Router', 'Todofy 个人事项', '邮件服务', 'Notion 备份']);
    expect(rows[4]).toHaveTextContent('异步副本，写在记录之后');
    expect(rows[2]).toHaveTextContent('可选，仅你可见');
  });

  it("shows the content configuration in Fleet's words", async () => {
    serve(world());
    show('#/');
    const config = await section('内容配置');
    expect(config.getByText('与上次检查目标一致')).toBeVisible();
    expect(config.getByRole('link', { name: '89abcde' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never links a configuration revision that is not http or https', async () => {
    const overview = fixture<{ config: Record<string, unknown> }>('overview');
    serve(world({ '/api/v1/overview': { ...overview, config: { ...overview.config, revision_url: 'javascript:alert(1)' } } }));
    show('#/');
    const config = await section('内容配置');
    expect(config.queryByRole('link')).toBeNull();
  });
});
