import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { budgetMark, outcomeText } from './Sources.tsx';
import { fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('来源', () => {
  it('never mentions Notion: the backup is an output of the record, not an input', async () => {
    serve(world());
    show('#/sources');
    await section('输入从哪里来');
    expect(screen.getByRole('main').textContent).not.toMatch(/notion/i);
  });

  it("shows the content configuration in Fleet's words, and the revisions recent runs froze", async () => {
    serve(world());
    show('#/sources');
    expect((await section('内容配置')).getByText('与上次检查目标一致')).toBeVisible();
    const history = within((await section('最近运行冻结的版本')).getByRole('list')).getAllByRole('listitem');
    expect(history[0]).toHaveTextContent('89abcde生效中10月29日 · 2 次运行');
    expect(history[1]).toHaveTextContent('012345610月24日 – 10月28日 · 5 次运行');
  });

  it('names the four inputs, the personal one as optional and private', async () => {
    serve(world());
    show('#/sources');
    const inputs = await section('输入从哪里来');
    expect(inputs.getByText('订阅源 · 研究员').nextElementSibling).toHaveTextContent('3 / 4 启用');
    expect(inputs.getByText('10月29日：2 个正常，1 个失败')).toBeVisible();
    expect(inputs.getByText('搜集方向 · 模型检索').nextElementSibling).toHaveTextContent('2 个方向');
    expect(inputs.getByText('个人事项 · Todofy，可选').nextElementSibling).toHaveTextContent('已启用');
    expect(inputs.getByText(/仅你可见/)).toBeVisible();
    expect(inputs.getByText('历史去重').nextElementSibling).toHaveTextContent('1 条');
  });

  it('lists each direction with its sources, their last seven outcomes and the latest in words', async () => {
    serve(world());
    show('#/sources');
    const ai = await section('AI / ML 候选发现');
    expect(ai.getByText('完成')).toBeVisible();
    const sources = ai.getAllByRole('listitem');
    expect(sources[0]).toHaveTextContent('Synthetic ML NotesRSS');
    expect(sources[0]).toHaveTextContent('4 条线索（14 条中 6 条可用）');
    expect(sources[1]).toHaveTextContent('arXiv');
    expect(within(sources[1]!).getByRole('img')).toHaveAccessibleName('最近 5 次：10月24日 正常；10月25日 正常；10月27日 正常；10月28日 超时；10月29日 正常');
    expect(ai.getByRole('link', { name: 'synthetic-ml-feed' })).toHaveAttribute('rel', 'noopener noreferrer');
    const world3 = await section('世界简报');
    expect(world3.getByText('无法访问（http_error）')).toBeVisible();
    expect(world3.getByText('已停用')).toBeVisible();
    expect(world3.getByText('运行不读取')).toBeVisible();
    // The direction's instructions are text in a disclosure, never markup.
    expect(world3.getByText('检索说明')).toBeVisible();
  });

  it('shows an outcome code it does not know as it is, never as normal; and a count not recorded as such', () => {
    expect(outcomeText({ code: 'brand_new' })).toBe('brand_new');
    expect(outcomeText({ code: 'timeout' })).toBe('超时（timeout）');
    expect(outcomeText({ code: 'ok' })).toBe('正常 · 线索数上线前未记录');
    expect(outcomeText({ code: 'ok', seed_count: 0 })).toBe('正常 · 没有新线索');
    expect(outcomeText(undefined)).toBe('尚无运行记录');
  });

  it('never links a source URL that is not http or https', async () => {
    const catalog = fixture<{ sources: Record<string, unknown>[] }>('source-catalog');
    const sources = catalog.sources.map((source, index) => (index === 0 ? { ...source, url: 'javascript:alert(1)' } : source));
    serve(world({ '/api/v1/sourceCatalog': { ...catalog, sources } }));
    show('#/sources');
    const ai = await section('AI / ML 候选发现');
    expect(ai.queryByRole('link', { name: 'synthetic-ml-feed' })).toBeNull();
    expect(ai.getByText('synthetic-ml-feed')).toBeVisible();
  });

  it("compares each node's recent time with its budget: an overrun of a run's frozen budget first", async () => {
    serve(world());
    show('#/sources');
    const rows = (await section('节点预算')).getAllByRole('row');
    const row = (name: string) => rows.find((item) => item.querySelector('th')?.textContent === name);
    expect(row('选题')).toHaveTextContent('420 秒59 秒161 秒5 次■超出 1 次');
    expect(row('简讯')).toHaveTextContent('▲接近预算');
    expect(row('订阅源')).toHaveTextContent('●在预算内');
    expect(row('历史')).toHaveTextContent('○无单独预算');
    expect(budgetMark({ budget_seconds: 100 })).toEqual({ label: '尚无记录', tone: 'none' });
  });

  it('lists the editorial rules in the order an issue is composed', async () => {
    serve(world());
    show('#/sources');
    const rules = await section('编辑规则');
    expect([...rules.getAllByRole('term')].map((term) => term.textContent)).toEqual(['每期条目上限', '其中研究条目上限', '每期深读上限', '研究候选上限']);
  });
});
