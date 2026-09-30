import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CanaryRun, GuardView, OverviewResponse } from '../../../worker/src/api-types.ts'
import { canaryActiveOverview, guardActiveOverview, healthyOverview } from '../test/fixtures'
import { apiError, freezeClock, installFetch, json, renderApp, type Call, type Handler } from '../test/harness'
import { CLEAR_CONFIRM_TEXT, SHED_CONFIRM_TEXT, canaryConfirmText } from './ActionsSection'

const STARTED: CanaryRun = {
  ...canaryActiveOverview().canary.active!,
  run_id: 'canary-manual-20260929T170000Z',
  phase: 'starting',
  queued_at: null,
}

/** Serves the overview and the CSRF token; `mutation` answers the POSTs. */
function serve(overview: OverviewResponse | (() => OverviewResponse), mutation: Handler): Call[] {
  let tokens = 0
  return installFetch((call) => {
    if (call.path === '/api/v1/csrf') {
      tokens += 1
      return json({ token: `token-${tokens}` })
    }
    if (call.path.startsWith('/api/v1/overview')) return json(typeof overview === 'function' ? overview() : overview)
    return mutation(call)
  })
}

async function open(overview: OverviewResponse | (() => OverviewResponse), mutation: Handler) {
  freezeClock()
  const calls = serve(overview, mutation)
  renderApp()
  const actions = await screen.findByRole('region', { name: '降载与操作' })
  return { calls, actions, user: userEvent.setup() }
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST')

describe('actions', () => {
  it('confirms a canary run with the exact text and sends it with the CSRF token', async () => {
    const { calls, actions, user } = await open(healthyOverview(), () => json({ run: STARTED }, 202))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    await user.click(button)

    const dialog = screen.getByRole('dialog', { name: '立即运行金丝雀？' })
    expect(dialog).toHaveAccessibleDescription(canaryConfirmText(3))
    expect(within(dialog).getByText(canaryConfirmText(3))).toBeInTheDocument()
    expect(canaryConfirmText(3)).toBe(
      '调用 Mail Hero 创建一封固定内容的合成测试邮件，经正常投递链路发给 Todofy；Todofy 只调用一次 Gemini 并校验结果，不创建 Todoist 任务、不进入列表或提醒。今天还可手动运行 3 次。',
    )
    // Focus starts on 取消, so Enter never confirms by accident.
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
    expect(posts(calls)).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: '确认运行' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const [post] = posts(calls)
    expect(post).toMatchObject({ path: '/api/v1/canary', body: '{}' })
    expect(post?.headers['x-csrf-token']).toBe('token-1')
    expect(post?.headers['content-type']).toBe('application/json')
    expect(post?.init).toMatchObject({ credentials: 'same-origin', redirect: 'error' })
    expect(within(actions).getByRole('status')).toHaveTextContent(
      '已启动金丝雀 canary-manual-20260929T170000Z（启动中），之后每 30 分钟检查一次进度。',
    )
    expect(button).toHaveFocus()
  })

  it('retries once with a fresh token after 403 csrf_failed', async () => {
    let attempts = 0
    const { calls, actions, user } = await open(healthyOverview(), () => {
      attempts += 1
      return attempts === 1 ? apiError(403, 'csrf_failed') : json({ run: STARTED }, 202)
    })
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    await waitFor(() => expect(within(actions).getByRole('status')).toHaveTextContent('已启动金丝雀'))
    expect(posts(calls).map((call) => call.headers['x-csrf-token'])).toEqual(['token-1', 'token-2'])
    expect(calls.filter((call) => call.path === '/api/v1/csrf')).toHaveLength(2)
  })

  it('does not retry a second csrf_failed and shows the error', async () => {
    const { calls, actions, user } = await open(healthyOverview(), () => apiError(403, 'csrf_failed', '页面安全校验失败', 'bbbbbbbbbbbbbbbb'))
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    expect(await within(actions).findByRole('alert')).toHaveTextContent(
      '未能启动金丝雀：页面安全校验失败（请求 bbbbbbbbbbbbbbbb）',
    )
    expect(posts(calls)).toHaveLength(2)
  })

  it('reports canary_active without retrying', async () => {
    const { calls, actions, user } = await open(healthyOverview(), () => apiError(409, 'canary_active', '已有金丝雀正在运行'))
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    expect(await within(actions).findByRole('alert')).toHaveTextContent('未能启动金丝雀：已有金丝雀正在运行')
    expect(posts(calls)).toHaveLength(1)
  })

  it('keeps the canary button focusable but inert while a run is active', async () => {
    const { calls, actions, user } = await open(canaryActiveOverview(), () => json({}))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(
      '已有运行 canary-manual-20260929T165500Z 正在进行，结束后才能再次运行。',
    )
    await user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(calls)).toHaveLength(0)
  })

  it('stops manual runs at the daily limit', async () => {
    const overview = healthyOverview()
    const { actions } = await open({ ...overview, canary: { ...overview.canary, manual_today: 3 } }, () => json({}))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription('今天的 3 次手动运行已用完。')
  })

  it('forces shed after confirmation and reports per-app failures', async () => {
    const guard: GuardView = guardActiveOverview().guard
    const shed: GuardView = {
      ...guard,
      desired: { level: 'shed', reason: 'owner_shed', until: '2026-09-30T17:00:00.000Z', source: 'owner' },
      override: { level: 'shed', until: '2026-09-30T17:00:00.000Z', set_at: '2026-09-29T17:00:00.000Z' },
    }
    let current = healthyOverview()
    const { calls, actions, user } = await open(
      () => current,
      () => {
        current = { ...current, guard: shed }
        return json({ guard: shed })
      },
    )
    await user.click(within(actions).getByRole('button', { name: '强制降载' }))

    const dialog = screen.getByRole('dialog', { name: '强制降载？' })
    expect(dialog).toHaveAccessibleDescription(SHED_CONFIRM_TEXT)
    expect(SHED_CONFIRM_TEXT).toBe(
      '立即让 Mail Hero 和 Todofy 在 24 小时内推迟可推迟的清理和安全网任务（各任务仍有自身上限）；收件、解析、投递、重试和真实邮件处理不受影响。可随时解除。',
    )
    await user.click(within(dialog).getByRole('button', { name: '确认降载' }))

    await waitFor(() => expect(within(actions).getByRole('status')).toHaveTextContent('已要求两个应用降载'))
    expect(within(actions).getByRole('status')).toHaveTextContent(
      '已要求两个应用降载，直到 10月1日 01:00。Todofy 调用失败（超时），下次定时检查会重试。',
    )
    const [post] = posts(calls)
    expect(post).toMatchObject({ path: '/api/v1/guard', body: '{"level":"shed"}' })
    expect(post?.headers['x-csrf-token']).toBe('token-1')
    expect(within(actions).getByText('手动')).toBeInTheDocument()
    expect(within(actions).getByText(/强制降载，至/)).toBeInTheDocument()
  })

  it('clears the guard after confirmation', async () => {
    const overview = guardActiveOverview()
    const cleared: GuardView = {
      ...overview.guard,
      desired: { level: 'normal', reason: 'owner_clear', until: null, source: 'owner' },
      override: { level: 'normal', until: '2026-09-30T00:00:00.000Z', set_at: '2026-09-29T17:00:00.000Z' },
      apps: {
        'mail-hero': { ...overview.guard.apps['mail-hero'], last_error: null },
        todofy: { ...overview.guard.apps.todofy, last_error: null },
      },
    }
    const { calls, actions, user } = await open(overview, () => json({ guard: cleared }))
    await user.click(within(actions).getByRole('button', { name: '解除降载' }))

    const dialog = screen.getByRole('dialog', { name: '解除降载？' })
    expect(dialog).toHaveAccessibleDescription(CLEAR_CONFIRM_TEXT)
    expect(CLEAR_CONFIRM_TEXT).toBe(
      '立即结束两个应用的降载，并在本 UTC 日剩余时间内暂停自动降载；次日 00:00 UTC 起恢复自动判断。',
    )
    await user.click(within(dialog).getByRole('button', { name: '确认解除' }))

    await waitFor(() =>
      expect(within(actions).getByRole('status')).toHaveTextContent('已解除降载，本 UTC 日剩余时间内不会自动降载。'),
    )
    expect(posts(calls)[0]).toMatchObject({ path: '/api/v1/guard', body: '{"level":"normal"}' })
  })

  it('closes on Escape without sending and returns focus; Tab stays inside the dialog', async () => {
    const { calls, actions, user } = await open(healthyOverview(), () => json({}))
    const button = within(actions).getByRole('button', { name: '强制降载' })
    button.focus()
    await user.keyboard('{Enter}')

    const dialog = screen.getByRole('dialog', { name: '强制降载？' })
    const cancel = within(dialog).getByRole('button', { name: '取消' })
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: '确认降载' })).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: '关闭' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(within(dialog).getByRole('button', { name: '确认降载' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
    expect(posts(calls)).toHaveLength(0)
  })
})
