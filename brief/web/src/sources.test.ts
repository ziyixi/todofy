/**
 * 来源 and 偏好 against the fake API: the line of counts, a card per section in the registry's order, each state's chip
 * and sentence, the last item, volume, weight and votes, disabled sources folded away; the topics' weights with their
 * format and votes, and 重置 behind a confirmation.
 */
import { Section } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { Source_Role, Source_State } from '@ziyixi/proto/brief/ui/v1/source_pb'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { FakeServer, HOUR, NOW, settle, source } from './test/fakeServer.ts'
import { buttonNamed, open, testHost, toastText } from './test/helpers.ts'

const DAY = 24 * HOUR

describe('来源', () => {
  it('shows each source’s health, volume, last item and learned weight by section', async () => {
    const fake = new FakeServer()
    fake.sources = [
      source('quakes', { displayName: 'Synthetic Seismica', weight: 1.18, shownCount: 4, upCount: 2, downCount: 0, moreCount: 1 }),
      source('arxiv-geo', { displayName: 'arXiv · 合成地球物理', state: Source_State.FAILING, failureCount: 2, lastErrorCode: 'http_403' }),
      source('wiley', { displayName: 'Synthetic Wiley Journal', state: Source_State.PAUSED, failureCount: 5, lastErrorCode: 'timeout' }),
      source('frozen', { displayName: 'Synthetic Frozen Feed', state: Source_State.STALE, lastItemTime: timestampFromMs(NOW - 12 * DAY), usualGapHours: 30, recentItemCount: 0 }),
      source('fresh', { displayName: 'Synthetic New Lab', state: Source_State.NEW, lastItemTitle: '', lastItemTime: undefined, recentItemCount: 0 }),
      source('news', { displayName: 'Synthetic News', section: Section.WORLD }),
      source('paywall', { displayName: 'Synthetic Paywall Times', section: Section.WORLD, role: Source_Role.SIGNAL_ONLY }),
      source('old', { displayName: 'Synthetic Retired Feed', state: Source_State.DISABLED, lastItemTitle: '', lastItemTime: undefined }),
    ]
    const root = await open(fake, '/sources')
    expect([...root.querySelectorAll('.facts.lead > span')].map((node) => [node.textContent, node.className])).toEqual([
      ['在用 7 个', ''],
      ['正常 3', ''],
      ['失败 1', 'warn'],
      ['已暂停 1', 'warn'],
      ['沉寂 1', 'warn'],
      ['未抓取 1', ''],
    ])
    const cards = [...root.querySelectorAll('.card')]
    expect(cards.map((card) => [card.querySelector('h2')?.textContent, card.querySelector('.card-head .meta')?.textContent])).toEqual([
      ['研究前沿', '5 个'],
      ['世界与经济', '2 个'],
    ])
    const rows = [...(cards[0]?.querySelectorAll('li') ?? [])]
    const read = (row: Element | undefined) => ({
      name: row?.querySelector('.row-title')?.textContent,
      chips: [...(row?.querySelectorAll('.row-head .chip') ?? [])].map((node) => [node.textContent, node.className]),
      sub: row?.querySelector('.row-sub')?.textContent ?? null,
      facts: [...(row?.querySelectorAll('.facts span') ?? [])].map((node) => node.textContent),
      trouble: row?.querySelector('.hint.warn')?.textContent ?? null,
    })
    expect(read(rows[0])).toEqual({ name: 'Synthetic Seismica', chips: [], sub: '最新：A synthetic paper from quakes', facts: ['近 7 天 12 条', '上次 3 小时前', '权重 ×1.18', '上过 4 条 · 👍 2 · 👎 0 · 多来点 1'], trouble: null })
    expect(read(rows[1])).toMatchObject({ chips: [['失败', 'chip warn']], trouble: '连续失败 2 次（HTTP 403），照常再试' })
    expect(read(rows[2])).toMatchObject({ chips: [['已暂停', 'chip warn']], trouble: '连续失败 5 次后暂停（超时），每天再试一次' })
    expect(read(rows[3])).toMatchObject({ chips: [['沉寂', 'chip warn']], trouble: '12 天没有新条目，通常每 30 小时一条：可能换了地址或过滤太严' })
    expect(read(rows[4])).toMatchObject({ chips: [['未抓取', 'chip muted']], sub: null, facts: ['近 7 天 0 条'], trouble: null })
    expect(read(cards[1]?.querySelectorAll('li')[1])).toMatchObject({ name: 'Synthetic Paywall Times', chips: [['仅信号', 'chip muted']] })
    const off = root.querySelector('details.more')
    expect(off?.querySelector('summary')?.textContent).toBe('已停用 1 个')
    expect(off?.hasAttribute('open')).toBe(false)
    expect(off?.querySelector('.row-title')?.textContent).toBe('Synthetic Retired Feed')
  })

  it('tells sources that share a name apart by their registry ID', async () => {
    const fake = new FakeServer()
    fake.sources = [source('arxiv-agents', { displayName: 'arXiv' }), source('arxiv-geo', { displayName: 'arXiv' }), source('quakes', { displayName: 'Synthetic Seismica' })]
    const root = await open(fake, '/sources')
    expect([...root.querySelectorAll('.row-title')].map((node) => [node.textContent, node.querySelector('.meta')?.textContent ?? null])).toEqual([
      ['arXiv arxiv-agents', ' arxiv-agents'],
      ['arXiv arxiv-geo', ' arxiv-geo'],
      ['Synthetic Seismica', null],
    ])
  })
})

describe('偏好', () => {
  it('shows every topic’s weight with its format and the votes behind it', async () => {
    const root = await open(new FakeServer(), '/profile')
    const rows = [...root.querySelectorAll('.weights li')]
    expect(rows.map((row) => [row.querySelector('.row-title')?.textContent, row.querySelector('.chip')?.textContent, row.querySelector('.row-head .meta')?.textContent, row.querySelector('.facts')?.textContent])).toEqual([
      ['地震学', '专业', '×1.12', '上过 6 条 · 👍 3 · 👎 0 · 多来点 1'],
      ['训练与推理', '熟悉', '×0.9', '上过 4 条 · 👍 0 · 👎 2 · 多来点 0'],
      ['经济', '通俗', '×1', '近 8 周没有上过'],
    ])
    // The meter spans the weights' range, 0.6 to 1.4 (its mark is 1): 1.12 is 65% of it. A low weight is a preference,
    // not a problem, so it keeps the accent.
    const meters = rows.map((row) => row.querySelector<HTMLElement>('.meter'))
    expect(meters.map((node) => node?.querySelector('span')?.style.width)).toEqual(['65%', '38%', '50%'])
    expect(meters.map((node) => node?.className)).toEqual(['meter', 'meter', 'meter'])
    expect(root.querySelector('.card-head .meta')?.textContent).toBe('更新于 今天 03:00')
  })

  it('resets the weights after a confirmation, and not without one', async () => {
    const fake = new FakeServer()
    const no = testHost(false)
    let root = await open(fake, '/profile', no)
    buttonNamed(root, '重置').click()
    await settle()
    expect(no.asked).toHaveLength(1)
    expect(fake.mutations()).toEqual([])
    document.body.replaceChildren()
    root = await open(fake, '/profile')
    buttonNamed(root, '重置').click()
    await settle()
    expect(fake.mutations().map((call) => [call.method, call.path])).toEqual([['POST', '/api/v1/profile:reset']])
    expect([...root.querySelectorAll('.weights .row-head .meta')].map((node) => node.textContent)).toEqual(['×1', '×1', '×1'])
    expect(toastText(root)).toBe('已重置偏好')
    expect(root.querySelector('.actions .hint')?.textContent).toBe('上次重置 今天 23:00')
  })
})
