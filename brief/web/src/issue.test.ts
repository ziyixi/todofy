/**
 * An issue against the fake API: the head in words, the items as in the email (topic and format, title, text, why, the
 * source line by code, the pick's reason), each `[n]` opening its quote with its document and the entailment log's
 * verdict, the votes and VoteItem, 还有, the deep read's headings and documents, a quiet day's note, an issue being
 * made, the send's problems, 成本明细, a document link that is not a web address, and an unknown day.
 */
import { Citation_Verdict, Issue_Kind, Issue_QuietReason, Issue_State, Item_Format, Item_Vote, MoreItemSchema, ParagraphSchema, ReferenceSchema, Review, Section, TextScope } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { create } from '@ziyixi/proto/protobuf'
import { FakeServer, issue, item, settle } from './test/fakeServer.ts'
import { buttonNamed, open, toastText } from './test/helpers.ts'

const DAY = '2026-10-12'
const text = (node: Element | null | undefined) => node?.textContent ?? null
const articles = (root: HTMLElement) => [...root.querySelectorAll('article.item')]

describe('an issue', () => {
  it('shows the head and the items as in the email, with what the archive adds', async () => {
    const root = await open(new FakeServer(), `/issues/${DAY}`)
    expect(text(root.querySelector('h2.issue-title'))).toBe('简报 · 10月12日（周一）')
    // The send time in the browser's zone (Asia/Shanghai in the tests): 06:31 in Los Angeles.
    expect([...root.querySelectorAll('.issue-head .facts > *')].map((node) => node.textContent)).toEqual(['已发送 · 今天 21:31', '从 48 张卡片中挑选'])
    expect([...root.querySelectorAll('h2.section-title')].map((node) => node.textContent)).toEqual(['研究前沿', '世界与经济'])
    const [research, world] = articles(root)
    expect(text(research?.querySelector('.kicker'))).toBe('地震学 · 专业')
    expect(text(research?.querySelector('h3.item-title'))).toBe('一种层析方法看到更深的地幔结构')
    expect(text(research?.querySelector('p.para'))).toBe('作者用 120 个台站的数据反演1，分辨率比原有模型高 2 倍2。')
    expect(text(research?.querySelector('.why'))).toBe('为什么看：与你的层析工作直接相关。')
    expect(text(research?.querySelector('.source-line'))).toBe('Synthetic Geophysics Letters · 同行评议 · 仅摘要 · 原文')
    const link = research?.querySelector<HTMLAnchorElement>('.source-line a')
    expect([link?.getAttribute('href'), link?.getAttribute('target'), link?.getAttribute('rel')]).toEqual(['https://synthetic-journal.org/papers/a1', '_blank', 'noopener noreferrer'])
    expect(text(research?.querySelector('.reason'))).toBe('入选理由：新数据揭示以前看不到的结构')
    expect(text(world?.querySelector('.kicker'))).toBe('经济 · 通俗')
    expect(text(world?.querySelector('.source-line'))).toBe('Synthetic News · 新闻报道 · 原文')
  })

  it('opens a marker’s quote under its paragraph: the source’s characters, its document and the log’s verdict', async () => {
    const root = await open(new FakeServer(), `/issues/${DAY}`)
    const research = articles(root)[0]
    if (research === undefined) throw new Error('no item')
    const panel = research.querySelector<HTMLElement>('.quote')
    expect(panel?.hidden).toBe(true)
    const second = buttonNamed(research, '引文 2')
    expect(second.closest('sup')).not.toBeNull()
    expect(second.getAttribute('aria-controls')).toBe(panel?.id)
    second.click()
    expect(panel?.hidden).toBe(false)
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(text(panel?.querySelector('blockquote'))).toBe('The resolution is twice that of earlier models.')
    expect(text(panel?.querySelector('.quote-source'))).toBe('[2] · Synthetic Geophysics Letters · Deeper mantle structure from dense arrays')
    expect([text(panel?.querySelector('.chip')), panel?.querySelector('.chip')?.className]).toEqual(['模型核对：说过头', 'chip warn'])
    // Another marker of the paragraph takes the panel; pressing it again closes it.
    const first = buttonNamed(research, '引文 1')
    first.click()
    expect([first.getAttribute('aria-expanded'), second.getAttribute('aria-expanded')]).toEqual(['true', 'false'])
    expect([text(panel?.querySelector('.chip')), panel?.querySelector('.chip')?.className]).toEqual(['模型核对：相符', 'chip muted'])
    first.click()
    expect(panel?.hidden).toBe(true)
  })

  it('leaves a marker without a checked quote as text, and an unchecked quote says so', async () => {
    const fake = new FakeServer()
    const plain = item(DAY, 'r1', { paragraphs: [create(ParagraphSchema, { text: '只有一条引文[1]，没有第三条[3]。' })] })
    const first = plain.citations[0]
    if (first !== undefined) first.verdict = Citation_Verdict.UNSPECIFIED
    fake.items = [plain]
    const root = await open(fake, `/issues/${DAY}`)
    expect(text(root.querySelector('p.para'))).toBe('只有一条引文1，没有第三条[3]。')
    buttonNamed(root, '引文 1').click()
    expect(text(root.querySelector('.quote .chip'))).toBe('模型核对：未检查')
  })

  it('shows the current vote and records a new one through VoteItem', async () => {
    const fake = new FakeServer()
    fake.items = [item(DAY, 'r1', { vote: Item_Vote.UP })]
    const root = await open(fake, `/issues/${DAY}`)
    const pressed = () => [...root.querySelectorAll('.votes button')].map((node) => [node.textContent, node.getAttribute('aria-pressed')])
    expect(pressed()).toEqual([
      ['👍', 'true'],
      ['👎', 'false'],
      ['多来点', 'false'],
    ])
    expect(buttonNamed(root, '👎 不适合我').textContent).toBe('👎')
    // The current vote again sends nothing.
    buttonNamed(root, '👍 选得好').click()
    await settle()
    expect(fake.mutations()).toEqual([])
    buttonNamed(root, '多来点').click()
    await settle()
    const [vote] = fake.mutations()
    expect([vote?.method, vote?.path, vote?.headers['x-csrf-token'], vote?.body?.['vote']]).toEqual(['POST', `/api/v1/issues/${DAY}/items/r1:vote`, '1', 'more'])
    expect(vote?.body?.['request_id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(pressed()).toEqual([
      ['👍', 'false'],
      ['👎', 'false'],
      ['多来点', 'true'],
    ])
    expect(toastText(root)).toBe('已记下 多来点')
    expect(fake.items[0]?.vote).toBe(Item_Vote.MORE)
  })

  it('lists 还有 after the research and gives the deep read its headings and its documents', async () => {
    const fake = new FakeServer()
    fake.issues = [
      issue(DAY, { moreItems: [create(MoreItemSchema, { source: 'sources/seismica', title: 'A synthetic catalogue of small events', venue: 'Synthetic Seismica', review: Review.PEER_REVIEWED, uri: 'https://synthetic-seismica.org/a2' })] }),
      issue('2026-10-10', { kind: Issue_Kind.DEEP_READ, title: '深读 · 10月10日：合成地幔' }),
    ]
    fake.items = [
      item(DAY, 'r1'),
      item('2026-10-10', 'deep', {
        section: Section.DEEP_READ,
        format: Item_Format.FAMILIAR,
        topic: 'llm.systems',
        why: '',
        reason: '',
        paragraphs: [create(ParagraphSchema, { heading: '原来卡在哪里', text: '第一段[1]。' }), create(ParagraphSchema, { heading: '这次怎么做', text: '第二段[2]。' })],
        references: [
          create(ReferenceSchema, { venue: 'arXiv', title: 'A synthetic kernel paper', uri: 'https://synthetic-arxiv.org/abs/1', review: Review.PREPRINT, textScope: TextScope.FULL_TEXT }),
          create(ReferenceSchema, { venue: 'Synthetic Lab Blog', title: 'Our synthetic kernels', uri: 'https://synthetic-lab.org/post', review: Review.INSTITUTION, textScope: TextScope.FEED_SUMMARY }),
        ],
      }),
    ]
    const root = await open(fake, `/issues/${DAY}`)
    const more = root.querySelector('.more-items')
    expect(more?.closest('.section')?.querySelector('h2')?.textContent).toBe('研究前沿')
    expect([...(more?.querySelectorAll('li') ?? [])].map((node) => [node.querySelector('a')?.textContent, node.querySelector('a')?.getAttribute('href'), node.querySelector('.meta')?.textContent])).toEqual([
      ['A synthetic catalogue of small events', 'https://synthetic-seismica.org/a2', 'Synthetic Seismica · 同行评议'],
    ])
    document.body.replaceChildren()
    const deep = await open(fake, '/issues/2026-10-10')
    expect(deep.querySelectorAll('h2.section-title')).toHaveLength(0)
    expect([...deep.querySelectorAll('h4.para-heading')].map((node) => node.textContent)).toEqual(['原来卡在哪里', '这次怎么做'])
    expect(text(deep.querySelector('.kicker'))).toBe('训练与推理 · 熟悉')
    expect(deep.querySelector('.source-line')).toBeNull()
    expect(deep.querySelector('.why')).toBeNull()
    expect([...deep.querySelectorAll('.refs li')].map((node) => node.textContent)).toEqual(['A synthetic kernel paper · arXiv · 预印本（未经同行评议）', 'Our synthetic kernels · Synthetic Lab Blog · 机构发布 · 仅摘要'])
    // Each paragraph has its own quote panel.
    buttonNamed(deep, '引文 2').click()
    expect([...deep.querySelectorAll<HTMLElement>('.quote')].map((node) => node.hidden)).toEqual([true, false])
  })

  it('says a quiet day’s reason instead of items', async () => {
    const fake = new FakeServer()
    fake.issues = [
      issue(DAY, { quietReason: Issue_QuietReason.NO_CANDIDATES, itemCount: 0, stepCosts: [], costUsd: 0 }),
      issue('2026-10-10', { kind: Issue_Kind.DEEP_READ, quietReason: Issue_QuietReason.NO_READABLE_THREAD, itemCount: 0 }),
    ]
    fake.items = []
    const root = await open(fake, `/issues/${DAY}`)
    expect(text(root.querySelector('.note'))).toBe('今日无条目：没有新的候选')
    expect(root.querySelectorAll('article.item')).toHaveLength(0)
    expect(text(root.querySelector('.card .hint'))).toBe('本期没有模型调用')
    document.body.replaceChildren()
    const saturday = await open(fake, '/issues/2026-10-10')
    expect(text(saturday.querySelector('.note'))).toBe('本周无深读：没有可读全文的线索')
  })

  it('shows an issue being made with its step, and no costs yet', async () => {
    const fake = new FakeServer()
    fake.issues = [issue(DAY, { state: Issue_State.BUILDING, itemCount: 0, stepCosts: [], sendTime: undefined })]
    fake.items = []
    fake.status = { currentIssue: `issues/${DAY}`, currentStep: 'read' }
    const root = await open(fake, `/issues/${DAY}`)
    expect(text(root.querySelector('.issue-head .facts > span'))).toBe('制作中：读全文')
    expect(root.textContent).toContain('还在制作，完成后这里显示条目')
    expect(root.querySelector('.card')).toBeNull()
  })

  it('says what went wrong with a send, the pick and the check', async () => {
    const fake = new FakeServer()
    fake.issues = [issue(DAY, { state: Issue_State.SEND_UNKNOWN, errorCode: 'resend_timeout', shadow: true, pickFallback: true, droppedItemCount: 1 })]
    const root = await open(fake, `/issues/${DAY}`)
    expect([...root.querySelectorAll('.issue-head .facts > *')].map((node) => [node.textContent, node.className])).toEqual([
      ['发送结果未知：请查看收件箱，不会重发', 'warn'],
      ['resend_timeout', 'mono'],
      ['影子版', 'chip muted'],
      ['从 48 张卡片中挑选', ''],
      ['核对删去 1 条', 'warn'],
    ])
    expect(text(root.querySelector('.issue-head > p.hint'))).toBe('挑选没有完成，本期按初筛的顺序选条目')
    // An archived issue says why in words; a code without words shows as it is.
    fake.issues = [issue(DAY, { state: Issue_State.ARCHIVED, errorCode: 'after_cutoff' })]
    document.body.replaceChildren()
    expect(text((await open(fake, `/issues/${DAY}`)).querySelector('.issue-head .facts > span'))).toBe('仅归档，未发信：到 12:00 截止时还没做完')
    fake.issues = [issue(DAY, { state: Issue_State.ARCHIVED, errorCode: 'odd_code', pickFallback: true })]
    document.body.replaceChildren()
    const odd = await open(fake, `/issues/${DAY}`)
    expect([...odd.querySelectorAll('.issue-head .facts > *')].slice(0, 2).map((node) => node.textContent)).toEqual(['仅归档，未发信', 'odd_code'])
    // A reason the pick never gave is not shown.
    fake.items = [item(DAY, 'r1', { reason: '' })]
    document.body.replaceChildren()
    expect((await open(fake, `/issues/${DAY}`)).querySelector('.reason')).toBeNull()
  })

  it('itemizes the cost of each step, and names a fallback writer', async () => {
    const fake = new FakeServer()
    fake.issues = [issue(DAY, { writerModels: ['claude-opus-5-5', 'claude-opus-5'] })]
    const root = await open(fake, `/issues/${DAY}`)
    const cost = [...root.querySelectorAll('.card')].find((node) => node.querySelector('h2')?.textContent === '成本明细')
    expect(text(cost?.querySelector('.card-head .meta'))).toBe('2 条 · 本期 $0.82')
    expect([...(cost?.querySelectorAll('li') ?? [])].map((row) => [row.querySelector('.row-title')?.textContent, row.querySelector('.meta')?.textContent, [...row.querySelectorAll('.facts span')].map((node) => node.textContent)])).toEqual([
      ['挑选 · Opus 5.5', '$0.18', ['1 次', '输入 1.5 万', '输出 6,100']],
      ['写作 · Opus 5.5', '$0.65', ['1 次', '输入 4.5 万', '输出 2.3 万']],
      ['核对日志 · Haiku 5.5', '<$0.01', ['1 次', '输入 9,000', '缓存 3,000', '输出 1,500']],
    ])
    expect(cost?.textContent).toContain('部分内容由 Opus 5 写作（服务端回退）')
  })

  it('never links a document whose address is not a web page’s', async () => {
    const fake = new FakeServer()
    const bad = item(DAY, 'r1')
    const ref = bad.references[0]
    if (ref !== undefined) ref.uri = 'javascript:alert(1)'
    fake.items = [bad]
    const root = await open(fake, `/issues/${DAY}`)
    expect(root.querySelector('.source-line a')).toBeNull()
    expect(text(root.querySelector('.source-line'))).toBe('Synthetic Geophysics Letters · 同行评议 · 仅摘要 · 原文')
    buttonNamed(root, '引文 1').click()
    expect(root.querySelector('.quote a')).toBeNull()
  })

  it('says when there is no such issue', async () => {
    const root = await open(new FakeServer(), '/issues/2026-01-01')
    expect(text(root.querySelector('.empty strong'))).toBe('找不到这一期')
  })
})
