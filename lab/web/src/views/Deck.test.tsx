import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiError, FakeServer } from '../test/fakeServer'
import { card, cards, DAY } from '../test/fixtures'
import { renderApp } from '../test/harness'
import { motion } from '../test/setup'

const title = (n: number) => `Synthetic Paper ${n}: Ranking Things With Other Things`

function topCard() {
  return screen.getByRole('article', { name: /Synthetic Paper/ })
}

async function openDeck(server: FakeServer) {
  server.install()
  renderApp('/')
  await screen.findByRole('article', { name: title(1) })
}

const liveText = () => screen.getByTestId('live-region').textContent ?? ''

describe('the daily deck', () => {
  it('shows one card at a time with the 简介, progress and links', async () => {
    await openDeck(new FakeServer(cards(4)))
    const article = topCard()
    expect(article).toHaveAttribute('aria-roledescription', '论文卡片')
    expect(within(article).getByText(/这是第 1 篇合成论文的简介/)).toBeInTheDocument()
    expect(within(article).getByText('AI 根据摘要生成')).toBeInTheDocument()
    expect(within(article).getByText('Ada Example, Ben Sample 等 4 人')).toBeInTheDocument()
    expect(within(article).getByRole('link', { name: 'arXiv' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByTestId('progress')).toHaveTextContent('1 / 4 篇 · 已喜欢 0')
    // Only the top card is exposed; the peeking ones are hidden and inert.
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('likes with the button: optimistic, one POST with op_id and base_version, focus and announcement', async () => {
    const server = new FakeServer(cards(4))
    await openDeck(server)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    expect(topCard()).toHaveAccessibleName(title(2))
    expect(screen.getByTestId('progress')).toHaveTextContent('2 / 4 篇 · 已喜欢 1')
    await waitFor(() => expect(server.mutations('/decide')).toHaveLength(1))
    const body = server.mutations('/decide')[0]?.body
    expect(body).toMatchObject({ base_version: 1, paper_id: 'arxiv:2609.10001', decision: 'like' })
    expect(body?.op_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(server.mutations('/decide')[0]?.headers['x-csrf-token']).toBe('token-1')
    await waitFor(() => expect(liveText()).toBe(`已喜欢。第 2 篇，共 4 篇：${title(2)}`))
    expect(screen.getByTestId('snackbar')).toHaveTextContent('已喜欢《Synthetic Paper 1:…》')
    // Focus stays on the button so it can be pressed again.
    expect(screen.getByRole('button', { name: '喜欢' })).toHaveFocus()
  })

  it('drives the whole deck from the keyboard', async () => {
    const server = new FakeServer(cards(3))
    await openDeck(server)
    const user = userEvent.setup()
    // Space expands the abstract.
    const disclosure = within(topCard()).getByRole('button', { name: '展开原文摘要' })
    await user.keyboard(' ')
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(within(topCard()).getByText(/We study synthetic problem 1/)).toBeVisible()
    await user.keyboard('{ArrowRight}')
    expect(topCard()).toHaveAccessibleName(title(2))
    // Focus follows to the new top card's title.
    expect(screen.getByRole('heading', { name: title(2) })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(topCard()).toHaveAccessibleName(title(3))
    await user.keyboard('z')
    expect(topCard()).toHaveAccessibleName(title(2))
    await waitFor(() => expect(liveText()).toBe(`已撤销：${title(2)}`))
    await user.keyboard('{Meta>}z{/Meta}')
    expect(topCard()).toHaveAccessibleName(title(1))
    await user.keyboard('h')
    expect(topCard()).toHaveAccessibleName(title(2))
    // ? opens the shortcuts; Esc closes them.
    await user.keyboard('?')
    expect(screen.getByRole('dialog', { name: '键盘快捷键' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(server.state().decisions).toEqual({ 'arxiv:2609.10001': 'dislike' }))
    const kinds = server.mutations().map((call) => call.path.split('/').pop())
    expect(kinds).toEqual(['decide', 'decide', 'undo', 'undo', 'decide'])
    // Each request carried the version the previous response returned.
    expect(server.mutations().map((call) => call.body?.base_version)).toEqual([1, 2, 3, 4, 5])
  })

  it('opens arXiv with O in a new tab without a referrer', async () => {
    await openDeck(new FakeServer(cards(2)))
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await userEvent.setup().keyboard('o')
    expect(open).toHaveBeenCalledWith(['https:', '', 'arxiv.org', 'abs', '2609.10001'].join('/'), '_blank', 'noopener,noreferrer')
  })

  it('swipes with a pointer drag past the threshold and springs back below it', async () => {
    const server = new FakeServer(cards(3))
    await openDeck(server)
    const article = topCard()
    // A short drag (under the 40 px a flick needs) springs back.
    fireEvent.pointerDown(article, { pointerId: 1, clientX: 100, clientY: 100, button: 0, pointerType: 'touch' })
    fireEvent.pointerMove(article, { pointerId: 1, clientX: 130, clientY: 102, pointerType: 'touch' })
    fireEvent.pointerUp(article, { pointerId: 1, clientX: 130, clientY: 102, pointerType: 'touch' })
    expect(topCard()).toHaveAccessibleName(title(1))
    // A vertical movement is a scroll, never a swipe.
    fireEvent.pointerDown(article, { pointerId: 2, clientX: 100, clientY: 100, pointerType: 'touch' })
    fireEvent.pointerMove(article, { pointerId: 2, clientX: 104, clientY: 160, pointerType: 'touch' })
    fireEvent.pointerMove(article, { pointerId: 2, clientX: 300, clientY: 170, pointerType: 'touch' })
    fireEvent.pointerUp(article, { pointerId: 2, clientX: 300, clientY: 170, pointerType: 'touch' })
    expect(topCard()).toHaveAccessibleName(title(1))
    // Left past 96 px (the minimum threshold): 不喜欢.
    fireEvent.pointerDown(article, { pointerId: 3, clientX: 300, clientY: 100, pointerType: 'touch' })
    fireEvent.pointerMove(article, { pointerId: 3, clientX: 280, clientY: 101, pointerType: 'touch' })
    fireEvent.pointerMove(article, { pointerId: 3, clientX: 150, clientY: 104, pointerType: 'touch' })
    fireEvent.pointerUp(article, { pointerId: 3, clientX: 150, clientY: 104, pointerType: 'touch' })
    expect(topCard()).toHaveAccessibleName(title(2))
    // The leaving copy is on screen for the exit animation but hidden from assistive tech.
    expect(screen.getByTestId('leaving-card')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(server.state().decisions).toEqual({ 'arxiv:2609.10001': 'dislike' }))
  })

  it('ignores drags that start on a link or button', async () => {
    await openDeck(new FakeServer(cards(2)))
    const link = within(topCard()).getByRole('link', { name: 'arXiv' })
    fireEvent.pointerDown(link, { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'mouse', button: 0 })
    fireEvent.pointerMove(link, { pointerId: 1, clientX: 400, clientY: 100, pointerType: 'mouse' })
    fireEvent.pointerUp(link, { pointerId: 1, clientX: 400, clientY: 100, pointerType: 'mouse' })
    expect(topCard()).toHaveAccessibleName(title(1))
  })

  it('undoes from the snackbar and from the button, any number of steps', async () => {
    const server = new FakeServer(cards(4))
    await openDeck(server)
    const user = userEvent.setup()
    const undo = screen.getByRole('button', { name: '撤销' })
    expect(undo).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    expect(topCard()).toHaveAccessibleName(title(4))
    await user.click(within(screen.getByTestId('snackbar')).getByRole('button', { name: '撤销' }))
    expect(topCard()).toHaveAccessibleName(title(3))
    await user.click(screen.getByRole('button', { name: /撤销/ }))
    await waitFor(() => expect(topCard()).toHaveAccessibleName(title(2)))
    await waitFor(() => expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(topCard()).toHaveAccessibleName(title(1)))
    await waitFor(() => expect(server.state().decisions).toEqual({}))
    expect(screen.getByRole('button', { name: /撤销/ })).toBeDisabled()
  })

  it('重来 clears the deck in one undoable step (snackbar and later 撤销)', async () => {
    const server = new FakeServer(cards(3))
    await openDeck(server)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    await user.click(screen.getByRole('button', { name: '更多' }))
    await user.click(screen.getByRole('button', { name: '重来这组' }))
    expect(topCard()).toHaveAccessibleName(title(1))
    expect(screen.getByTestId('progress')).toHaveTextContent('1 / 3 篇 · 已喜欢 0')
    expect(screen.getByTestId('snackbar')).toHaveTextContent('已清空 2 个选择')
    await waitFor(() => expect(server.mutations('/restart')).toHaveLength(1))
    // No confirmation dialog: the snackbar's 撤销 brings every choice back.
    await user.click(within(screen.getByTestId('snackbar')).getByRole('button', { name: '撤销' }))
    expect(topCard()).toHaveAccessibleName(title(3))
    await waitFor(() => expect(server.state().decisions).toEqual({ 'arxiv:2609.10001': 'like', 'arxiv:2609.10002': 'dislike' }))
  })

  it('adopts the other device’s state on a version conflict', async () => {
    const server = new FakeServer(cards(3))
    await openDeck(server)
    server.decideElsewhere('arxiv:2609.10001', 'like')
    server.decideElsewhere('arxiv:2609.10002', 'dislike')
    await userEvent.setup().click(screen.getByRole('button', { name: '不喜欢' }))
    await waitFor(() => expect(topCard()).toHaveAccessibleName(title(3)))
    expect(screen.getByTestId('snackbar')).toHaveTextContent('已同步其他设备上的选择')
    expect(screen.getByTestId('progress')).toHaveTextContent('3 / 3 篇 · 已喜欢 1')
  })

  it('rolls the card back after a network failure that a retry does not fix', async () => {
    const server = new FakeServer(cards(3))
    await openDeck(server)
    server.interceptors.push((call) => (call.path.endsWith('/decide') ? apiError(503, 'unavailable') : null))
    await userEvent.setup().click(screen.getByRole('button', { name: '喜欢' }))
    expect(topCard()).toHaveAccessibleName(title(2))
    await waitFor(() => expect(topCard()).toHaveAccessibleName(title(1)), { timeout: 3000 })
    expect(screen.getByTestId('snackbar')).toHaveTextContent('网络异常，已恢复这张卡片')
    // The same op_id was sent twice (a lost response is harmless).
    const ops = server.mutations('/decide').map((call) => call.body?.op_id)
    expect(ops).toHaveLength(2)
    expect(ops[0]).toBe(ops[1])
  })

  it('shows the abstract excerpt when the 简介 is missing, and no 为什么推荐 on explore decks', async () => {
    const server = new FakeServer([card(1, { brief: null }), card(2)], undefined, 'explore')
    server.today = { ...server.today, cold_start: true }
    await openDeck(server)
    expect(within(topCard()).getByText('原文摘要节选')).toBeInTheDocument()
    expect(within(topCard()).getByText('探索')).toBeInTheDocument()
    expect(screen.getByText(/还没有种子：先凭直觉划一组/)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '不喜欢' }))
    expect(within(topCard()).queryByText(/为什么推荐/)).not.toBeInTheDocument()
  })

  it('shows 为什么推荐 on ranked decks', async () => {
    await openDeck(new FakeServer(cards(3)))
    await userEvent.setup().click(screen.getByRole('button', { name: '喜欢' }))
    expect(within(topCard()).getByText(/为什么推荐：与你喜欢的《/)).toBeInTheDocument()
  })

  it('under reduced motion shows a static stamp and a short cross-fade instead of a fly-out', async () => {
    motion.reduced = true
    await openDeck(new FakeServer(cards(2)))
    await userEvent.setup().click(screen.getByRole('button', { name: '喜欢' }))
    const leaving = screen.getByTestId('leaving-card')
    expect(leaving.style.transform).toContain('rotate(0.00deg)')
    expect(leaving.style.transition).toContain('opacity 120ms')
    await waitFor(() => expect(screen.queryByTestId('leaving-card')).not.toBeInTheDocument())
  })

  it('reaches the summary after the last card', async () => {
    const server = new FakeServer(cards(2))
    await openDeck(server)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    expect(screen.getByText('看完了')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '2 篇看完了 · 喜欢 1 · 不喜欢 1' }, { timeout: 2000 })).toBeInTheDocument()
    await waitFor(() => expect(liveText()).toBe('不喜欢。2 篇都看完了'))
    expect(DAY).toBe('2026-09-30')
  })
})

describe('keyboard safety', () => {
  it('does not swipe while typing in a field', async () => {
    const server = new FakeServer(cards(2))
    await openDeck(server)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await act(async () => {
      await userEvent.setup().keyboard('l')
    })
    expect(topCard()).toHaveAccessibleName(title(1))
    input.remove()
  })
})
