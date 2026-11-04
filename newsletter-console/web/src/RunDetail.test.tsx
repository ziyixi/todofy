import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerHref } from './RunDetail.tsx';
import { BLOCKED_RUN, READY_RUN, fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('the 10-28 run (selection ran out of its frozen 150-second budget)', () => {
  it('says what stopped it in plain words, with the budget the run froze and the call in flight', async () => {
    serve(world());
    show(`#/${BLOCKED_RUN}`);
    const panel = await section('未发出：选题超出节点预算');
    expect(panel.getByText('订阅源 部分失败 1/3：synthetic-arxiv timeout')).toBeVisible();
    expect(await panel.findByText('选题 · 超出节点预算 · 用时 161 秒（预算 150 秒，含会话关闭最多约 30 秒） · 模型回合开始 1 次、完成 0 次')).toBeVisible();
    expect(panel.getByText('→ 运行停止：没有可发布内容')).toBeVisible();
    expect(panel.getByText('timeout')).toBeVisible();
  });

  it('draws the selection past its budget on the timeline, with a table twin', async () => {
    serve(world());
    show(`#/${BLOCKED_RUN}`);
    const timeline = await section('节点时间线');
    const rows = within(timeline.getByRole('list', { name: '节点时间线' })).getAllByRole('listitem');
    const selection = rows.find((row) => row.textContent?.includes('选题'));
    expect(selection).toHaveTextContent('161 秒 / 150 秒■超出预算');
    expect(selection?.querySelector('.bar.over')).not.toBeNull();
    expect(rows.find((row) => row.textContent?.includes('规划'))).toHaveTextContent('未开始');
    expect(timeline.getByRole('table')).toBeInTheDocument();
  });

  it('lists the model calls with their turns, the failed one without a Router answer', async () => {
    serve(world());
    show(`#/${BLOCKED_RUN}`);
    const calls = await section('模型调用');
    const row = (await calls.findAllByRole('row'))[1];
    expect(row).toHaveTextContent('选题');
    expect(row).toHaveTextContent('没有回答');
    expect(row).toHaveTextContent('■失败');
    expect(row).toHaveTextContent('0/1');
    expect(row).toHaveTextContent('只有会话记录');
  });

  it('says why there is no delivery, and never calls the unused mail service 正常', async () => {
    serve(world());
    show(`#/${BLOCKED_RUN}`);
    const delivery = await section('投递');
    expect(delivery.getByText('这次运行没有生成期刊，所以没有投递。')).toBeVisible();
    const mail = (await section('外部调用')).getAllByRole('listitem').find((row) => row.textContent?.includes('邮件服务'));
    expect(mail).toHaveTextContent('○没有调用');
  });
});

describe('a delivered run', () => {
  it('opens each answered call in Model Router, and its mapped nodes into their items', async () => {
    serve(world());
    show(`#/${READY_RUN}`);
    const calls = await section('模型调用');
    const links = await calls.findAllByRole('link', { name: '在 Model Router 中查看' });
    expect(links).toHaveLength(5);
    expect(links[0]).toHaveAttribute('href', `${import.meta.env.VITE_MODEL_ROUTER_URL}#/requests/00000000-0000-4000-8000-000000009711`);
    const timeline = await section('节点时间线');
    fireEvent.click(timeline.getByRole('button', { name: '2/2 完成' }));
    expect(timeline.getByText('03-world')).toBeVisible();
    const stories = await section('选题');
    expect(stories.getByText('合成选题：港口')).toBeVisible();
    expect(stories.getByText('通过')).toBeVisible();
    const delivery = await section('投递');
    expect(delivery.getByText('邮件服务已接收不代表已进入收件箱。')).toBeVisible();
    expect(delivery.getByRole('link', { name: '阅读这一期 →' })).toHaveAttribute('href', '#/issues/00000000-0000-4000-8000-000000000027');
  });

  it('says 上线前未记录 for a call recorded before purposes and times were', async () => {
    serve(world({ [`/api/v1/${READY_RUN}/modelCalls`]: { model_calls: [{
      name: `${READY_RUN}/modelCalls/00000000-0000-4000-8000-000000007700`, node_id: 'selection',
      requested_model: 'gpt-6.1-sol', state: 'completed', turn_count: 1, completed_turn_count: 1, input_tokens: 100,
    }] } }));
    show(`#/${READY_RUN}`);
    const row = (await (await section('模型调用')).findAllByRole('row'))[1];
    expect(row?.textContent?.match(/上线前未记录/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('links only a Router request name, never another value', () => {
    expect(routerHref('requests/00000000-0000-4000-8000-000000009711')).toBe(`${import.meta.env.VITE_MODEL_ROUTER_URL}#/requests/00000000-0000-4000-8000-000000009711`);
    for (const name of ['requests/x', 'conversations/00000000-0000-4000-8000-000000009711', 'javascript:alert(1)', '']) {
      expect(routerHref(name)).toBeNull();
    }
  });
});

describe('the runs of a month', () => {
  it('lists each run with its trigger, state and outcome, and the nearest months', async () => {
    serve(world());
    show('#/runs');
    const list = within(await screen.findByRole('list', { name: '2026年10月的运行' }));
    const rows = list.getAllByRole('link');
    expect(rows).toHaveLength(7);
    expect(rows[2]).toHaveTextContent('10月28日 周三每日■已停止选题超出节点预算（用时 161 秒 / 预算 150 秒）');
    expect(rows[2]).toHaveAttribute('href', `#/${BLOCKED_RUN}`);
    expect(rows[0]).toHaveTextContent('手动');
    expect(screen.getByText('‹ 没有更早的记录')).toBeVisible();
  });
});

describe('the retrieval funnel and must-know tracking', () => {
  it('counts each direction from its leads to the edition, with what the pool left out and why', async () => {
    serve(world());
    show(`#/${READY_RUN}`);
    const funnel = await section('检索漏斗');
    const [ai, worldRow] = within(funnel.getByRole('table')).getAllByRole('row').slice(1);
    expect(ai).toHaveTextContent('01-ai-ml');
    const cells = (row: HTMLElement | undefined) => within(row!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(ai).slice(0, 3)).toEqual(['7', '4', '3新闻 1 · 研究 2全文 2 · 摘要 1']);
    expect(cells(ai)[4]).toBe('7已见过 1 · 重复 1 · 研究名额已满 4 · 候选池已满 1');
    expect(cells(worldRow).slice(3, 7)).toEqual(['2', '0', '1', '1']);
    expect(cells(worldRow)[7]).toBe('1 分 30 秒估算 $0.0012');
    expect(funnel.queryByText(/上线前未记录/)).toBeNull();
  });

  it('follows the consensus lead and every reference event, naming what matched', async () => {
    serve(world());
    show(`#/${READY_RUN}`);
    const must = await section('必知追踪');
    const lead = must.getByRole('link', { name: 'Harbor workers end strike after port deal' });
    expect(lead).toHaveAttribute('rel', 'noopener noreferrer');
    expect(lead.closest('li')).toHaveTextContent('3 家●已刊 · 简讯');
    expect(must.getByText(/03-world · 头条源 3\/3 正常 · 窗口内 41 条，\s*29 组，3 家及以上 1 组/)).toBeVisible();
    const reference = must.getByRole('link', { name: '维基百科时事 · 10月26日（UTC）' });
    expect(reference).toHaveAttribute('href', 'https://reference.example.org/wiki/Portal:Current_events/2026_October_26');
    expect(must.getByText('已刊 1 · 未入选 1 · 入池被丢 2 · 往期已见 1 · 种子被截 1 · 未见 1 · 未确定 1')).toBeVisible();
    const row = (text: RegExp) => must.getByText(text).closest('li');
    expect(row(/^Synthetic Cloud cuts/)).toHaveTextContent('▲入池被丢Business and economy · 研究名额已满 · 匹配：Cloud GPU rental prices fall');
    expect(row(/^A landslide keeps/)).toHaveTextContent('○往期已见Disasters and accidents · 匹配：Landslide closes Synthetic Coast rail line');
    expect(row(/^The River Delta Council/)).toHaveTextContent('匹配：合成：河口防洪闸表决推迟');
    expect(row(/^Border guards/)).toHaveTextContent('▲未见Armed conflicts and attacks');
    expect(must.getByText(/这里不说明没有漏报/)).toBeVisible();
    // Reference and feed text is text: no event or match becomes a link.
    expect(must.getAllByRole('link')).toHaveLength(2);
  });

  it('says what a run from before the funnel did not record, never zero', async () => {
    serve(world());
    show(`#/${BLOCKED_RUN}`);
    const funnel = await section('检索漏斗');
    const [ai] = within(funnel.getByRole('table')).getAllByRole('row').slice(1);
    const cells = within(ai!).getAllByRole('cell').map((cell) => cell.textContent);
    expect([cells[1], cells[4]]).toEqual(['未记录', '未记录']);
    expect(funnel.getByText('尝试打开与丢弃：上线前未记录。')).toBeVisible();
    expect((await section('必知追踪')).getByText('上线前未记录。')).toBeVisible();
  });

  it('says the reference was unavailable instead of listing nothing, and links only an http page', async () => {
    const ready = fixture<Record<string, unknown>>('run-ready');
    serve(world({ [`/api/v1/${READY_RUN}`]: {
      ...ready,
      reference: { source_id: 'current-events', date: '2026-10-26', url: 'javascript:alert(1)', state: 'unavailable', error_code: 'http_error' },
    } }));
    show(`#/${READY_RUN}`);
    const must = await section('必知追踪');
    expect(must.getByText('参照不可用（http_error）')).toBeVisible();
    expect(must.getByText('这次读不到参照，不能据此判断有没有漏掉大事。')).toBeVisible();
    expect(must.getByRole('heading', { name: '维基百科时事 · 10月26日（UTC）' }).querySelector('a')).toBeNull();
  });
});
