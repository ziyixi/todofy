/**
 * 期刊 against the fake API: a row per issue (its title, cost, chips and item count), the chips of each state, 更多
 * page by page, the empty archive, and a row opening its issue.
 */
import { Issue_Kind, Issue_QuietReason, Issue_State } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { FakeServer, issue, settle } from './test/fakeServer.ts'
import { buttonNamed, open } from './test/helpers.ts'

const rows = (root: HTMLElement) =>
  [...root.querySelectorAll('a.row-link')].map((row) => [row.querySelector('.row-title')?.textContent, row.querySelector('.row-head .meta')?.textContent ?? null, [...row.querySelectorAll('.row-chips > *')].map((part) => part.textContent)])

describe('期刊', () => {
  it('lists the issues newest first: title, cost, chips and items', async () => {
    const fake = new FakeServer()
    fake.issues = [
      issue('2026-10-13', { state: Issue_State.BUILDING, itemCount: 0, costUsd: 0, stepCosts: [] }),
      issue('2026-10-12', { shadow: true, itemCount: 6 }),
      issue('2026-10-10', { kind: Issue_Kind.DEEP_READ, title: '深读 · 10月10日：合成地幔的故事', itemCount: 1, state: Issue_State.SEND_UNKNOWN, costUsd: 1.234 }),
      issue('2026-10-09', { state: Issue_State.ARCHIVED, quietReason: Issue_QuietReason.NO_CANDIDATES, itemCount: 0, costUsd: 0.004 }),
      issue('2026-10-08', { state: Issue_State.SEND_REJECTED }),
      issue('2026-10-07', { state: Issue_State.FAILED, itemCount: 0, costUsd: 0 }),
      issue('2026-10-06', { state: Issue_State.READY }),
    ]
    const root = await open(fake, '/')
    expect(rows(root)).toEqual([
      ['简报 · 10月13日（周二）', null, ['制作中']],
      ['简报 · 10月12日（周一）', '$0.82', ['影子版', '6 条']],
      ['深读 · 10月10日：合成地幔的故事', '$1.23', ['未知', '1 条']],
      ['简报 · 10月9日（周五）', '<$0.01', ['未发送', '无条目']],
      ['简报 · 10月8日（周四）', '$0.82', ['未发送', '2 条']],
      ['简报 · 10月7日（周三）', '$0', ['失败']],
      ['简报 · 10月6日（周二）', '$0.82', ['待发送', '2 条']],
    ])
    // A send whose outcome is unknown, a refused one and a failure are problems; an archived day is not.
    const tones = [...root.querySelectorAll('.row-chips .chip')].map((node) => [node.textContent, node.className])
    expect(tones).toContainEqual(['未知', 'chip warn'])
    expect(tones).toContainEqual(['失败', 'chip warn'])
    expect(tones.filter(([text]) => text === '未发送').map(([, tone]) => tone)).toEqual(['chip muted', 'chip warn'])
    expect(root.querySelector('a.row-link')?.getAttribute('href')).toBe('/issues/2026-10-13')
  })

  it('reads the next page with 更多 until the last', async () => {
    const fake = new FakeServer()
    fake.issues = Array.from({ length: 35 }, (_, index) => issue(new Date(Date.UTC(2026, 9, 12) - index * 86_400_000).toISOString().slice(0, 10)))
    const root = await open(fake, '/')
    expect(root.querySelectorAll('a.row-link')).toHaveLength(30)
    buttonNamed(root, '更多').click()
    await settle()
    expect(root.querySelectorAll('a.row-link')).toHaveLength(35)
    expect([...root.querySelectorAll('button')].some((node) => node.textContent === '更多')).toBe(false)
    expect(fake.calls.filter((call) => call.path.startsWith('/api/v1/issues?')).map((call) => call.path)).toEqual(['/api/v1/issues?page_size=30', '/api/v1/issues?page_size=30&page_token=30'])
  })

  it('says when there is no issue yet', async () => {
    const fake = new FakeServer()
    fake.issues = []
    const root = await open(fake, '/')
    expect(root.querySelector('.empty strong')?.textContent).toBe('还没有期刊')
  })

  it('opens an issue from its row', async () => {
    const root = await open(new FakeServer(), '/')
    root.querySelectorAll<HTMLAnchorElement>('a.row-link')[1]?.click()
    await settle()
    expect(window.location.pathname).toBe('/issues/2026-10-09')
    expect(root.querySelector('h2.issue-title')?.textContent).toBe('简报 · 10月9日（周五）')
  })
})
