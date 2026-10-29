import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartImage, chartMetadata, isolatedMail, MAIL_CSP } from './Reader.tsx';
import { EDITION, fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const ID = EDITION.replace('editions/', '');
const article = async () => within(await screen.findByRole('article'));
const rail = async () => within(await screen.findByRole('complementary', { name: '本期记录' }));

describe('阅读: the edition from its structured body', () => {
  it('renders model text as text: markup in a paragraph stays literal and never becomes an element', async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const body = await article();
    expect(body.getByRole('heading', { level: 2, name: '合成期刊：港口与小模型' })).toBeVisible();
    const paragraph = body.getByText(/合成段落，含不可信文本/);
    expect(paragraph.textContent).toContain('<img src=x onerror=alert(1)>');
    // The only image is the chart the email embedded, as a PNG data: URL.
    const images = screen.getByRole('article').querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(images[0]).toHaveAttribute('alt', '合成图表替代文本。');
  });

  it("labels the sections and limits in the email's own words, in the email's order", async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const body = await article();
    const kickers = [...screen.getByRole('article').querySelectorAll('.reader-kicker')].map((node) => node.textContent);
    expect(kickers).toEqual(['01 / 世界简报', '02 / 研究与进展', '一图看懂 / 数据视角', '研究介绍', '本期边界', '来源与核对', '个人事项 · 来自 Todofy仅你可见']);
    expect(body.getByText('边界：合成边界说明。')).toBeVisible();
    expect(body.getByText('合成本期说明。')).toBeVisible();
  });

  it('numbers citations as the email does and moves to the reference without leaving the page', async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const body = await article();
    const cites = body.getAllByRole('link', { name: '[1]' });
    expect(cites[0]).toHaveAttribute('href', '#ref-1');
    expect(cites[0]).toHaveAttribute('title', '合成报告：港口吞吐');
    fireEvent.click(cites[0]!);
    expect(document.activeElement).toBe(document.getElementById('ref-1'));
    expect(window.location.hash).toBe(`#/issues/${ID}`);
    const references = within(body.getByRole('region', { name: '来源与核对' })).getAllByRole('listitem');
    expect(references.map((item) => item.querySelector('.ref-number')?.textContent)).toEqual(['[1]', '[2]', '[3]', '[4]']);
    expect(references[0]).toHaveTextContent('example.org · 摘要 · 2026-10-26');
  });

  it('links only http and https references, outside any frame, without a referrer or opener', async () => {
    const edition = fixture<{ references: Record<string, unknown>[] }>('edition');
    const references = [...edition.references];
    references[1] = { ...references[1], url: 'javascript:alert(1)' };
    references[3] = { ...references[3], url: 'data:text/html,<b>x</b>' };
    serve(world({ [`/api/v1/${EDITION}`]: { ...edition, references } }));
    show(`#/issues/${ID}`);
    const list = within((await article()).getByRole('region', { name: '来源与核对' }));
    const links = list.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.org/report', 'https://example.org/report']);
    for (const link of links) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('target', '_blank');
    }
    expect(list.getByText('合成复现记录').closest('a')).toBeNull();
    expect(list.getByText('合成数据集说明').closest('a')).toBeNull();
  });

  it("states the chart's values as the email's table does, a missing value with its reason", async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const chart = within((await article()).getByRole('figure'));
    expect(chart.getByText('指标：吞吐（万标箱） · 范围：2026 年 9 月', { exact: false })).toBeVisible();
    const rows = chart.getAllByRole('row');
    expect(rows[0]).toHaveTextContent('甲港12.5[1]');
    expect(rows[1]).toHaveTextContent('乙港缺失（未公布）');
    expect(chart.getByText('边界：合成图表边界。')).toBeVisible();
  });

  it('labels the Todofy section as the owner\'s alone, and says whether the backup copies it', async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const personal = within((await article()).getByRole('region', { name: '今天与你有关' }));
    expect(personal.getByText('仅你可见')).toBeVisible();
    expect(personal.getByText(/来自 Todofy/)).toBeVisible();
    expect(personal.getByText('3 条来源记录', { exact: false })).toBeVisible();
    expect(personal.getByText('这一节不写入 Notion 备份。')).toBeVisible();
    expect(personal.getAllByRole('listitem')).toHaveLength(2);
    cleanup();
    const edition = fixture<{ personal_digest: Record<string, unknown> }>('edition');
    serve(world({ [`/api/v1/${EDITION}`]: { ...edition, personal_digest: { ...edition.personal_digest, backup_included: true } } }));
    show(`#/issues/${ID}`);
    expect((await article()).getByText('这一节随本期写入 Notion 备份。')).toBeVisible();
  });
});

describe('the record beside the issue', () => {
  it('shows the run, delivery, the Notion copy as a copy, model use and the review', async () => {
    serve(world());
    show(`#/issues/${ID}`);
    const record = await rail();
    expect(record.getByRole('link', { name: /查看运行/ })).toHaveAttribute('href', '#/runs/00000000-0000-4000-8000-000000002700');
    expect(record.getByText('邮件服务已接收不代表进入收件箱。')).toBeVisible();
    expect(record.getByText('这一天已发修订 1 次')).toBeVisible();
    expect(record.getByText('异步副本，以这里的记录为准；在 Notion 中的修改不会回写。')).toBeVisible();
    expect(record.getByRole('link', { name: '在 Notion 中打开' })).toHaveAttribute('href', 'https://www.notion.so/0123456789abcdef0123456789abcdef');
    expect(record.getByText(/5 次调用/)).toBeVisible();
    expect(record.getByText('通过')).toBeVisible();
    expect(record.getByText('合成审核意见。')).toBeVisible();
  });

  it('never calls a review failed without findings: a missing review is only not recorded', async () => {
    const edition = fixture<Record<string, unknown>>('edition');
    serve(world({ [`/api/v1/${EDITION}`]: { ...edition, review_passed: false, review_findings: [] } }));
    show(`#/issues/${ID}`);
    const record = await rail();
    expect(record.getByText('审校').nextElementSibling).toHaveTextContent('○无通过记录');
    cleanup();
    serve(world({ [`/api/v1/${EDITION}`]: { ...edition, review_passed: false } }));
    show(`#/issues/${ID}`);
    expect((await rail()).getByText('审校').nextElementSibling).toHaveTextContent('▲未通过');
  });

  it('never links a Notion page that is not https', async () => {
    const edition = fixture<{ backup: Record<string, unknown> }>('edition');
    serve(world({ [`/api/v1/${EDITION}`]: { ...edition, backup: { ...edition.backup, notion_url: 'http://www.notion.so/x' } } }));
    show(`#/issues/${ID}`);
    expect((await rail()).queryByRole('link', { name: '在 Notion 中打开' })).toBeNull();
  });
});

describe('邮件原样 and 纯文本', () => {
  it('reads the frozen email only when it is opened', async () => {
    const requested = serve(world());
    show(`#/issues/${ID}`);
    await article();
    expect(requested.filter((url) => url.includes('/rendering'))).toEqual([]);
    fireEvent.click(screen.getByRole('link', { name: '邮件原样' }));
    expect(await screen.findByTitle('邮件原样')).toBeInTheDocument();
    expect(requested.filter((url) => url.includes('/rendering'))).toHaveLength(1);
  });

  it('shows the email in a sandboxed frame with no scripts, network or referrer', async () => {
    serve(world());
    show(`#/issues/${ID}?view=mail`);
    const frame = await screen.findByTitle('邮件原样');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const source = frame.getAttribute('srcdoc') ?? '';
    expect(source.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}">`)).toBe(true);
    expect(source).toContain('<h1>合成期刊：港口与小模型</h1>');
    expect(screen.getByText(/隔离窗口展示，链接不可点击/)).toBeVisible();
    expect(screen.getByRole('link', { name: '邮件原样' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the plain-text part as text', async () => {
    serve(world());
    show(`#/issues/${ID}?view=text`);
    const text = await screen.findByText(/合成纯文本。/);
    expect(text.tagName).toBe('PRE');
  });

  it('says so when the rendering does not match the edition it belongs to', async () => {
    serve(world({ [`/api/v1/${EDITION}/rendering`]: { ...fixture<Record<string, unknown>>('edition-rendering'), render_hash: 'f'.repeat(64) } }));
    show(`#/issues/${ID}?view=text`);
    expect(await screen.findByText('渲染指纹与期刊记录不一致')).toBeVisible();
  });
});

describe('the frame and image guards', () => {
  it("puts the email's policy and a refused link target first, after the email's own doctype", () => {
    expect(isolatedMail('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><body>x</body></html>')).toBe(
      `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><base target="_blank"><html><body>x</body></html>`);
    expect(isolatedMail('<p>x</p>')).toBe(`<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><base target="_blank"><p>x</p>`);
    expect(MAIL_CSP).toContain("default-src 'none'");
    expect(MAIL_CSP).toContain('img-src data:;');
  });

  it('makes a data: image only from plain base64', () => {
    expect(chartImage('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    for (const value of ['', undefined, 'abc" onerror="x', 'abc)url(x', 'a b']) expect(chartImage(value)).toBeNull();
  });

  it("describes the measure as the email's chart does", () => {
    expect(chartMetadata({ metric: '吞吐', unit: '万标箱', period: '9 月' })).toBe('指标：吞吐（万标箱） · 范围：9 月');
    expect(chartMetadata({ metric: '占比（%）', unit: '%', period: '本周' })).toBe('指标：占比（%） · 范围：本周');
  });
});
