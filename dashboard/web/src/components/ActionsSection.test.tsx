import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CanaryRun } from '../../../worker/src/api-types.ts'
import type { GuardViewV2 } from '../../../worker/src/api-v2-types.ts'
import { canaryActive, canaryDisabled, guardShed, healthy, type Scenario } from '../test/fixtures'
import { apiError, freezeClock, json, renderApp, serve, type Call, type Handler } from '../test/harness'
import { SHED_CONFIRM_TEXT, canaryConfirmText, clearConfirmText } from './ActionsSection'

const STARTED: CanaryRun = {
  ...canaryActive().ops.canary.active!,
  run_id: 'canary-manual-20260929T170000Z',
  phase: 'starting',
  queued_at: null,
}

/** Opens 操作与记录 on `scenario`; `mutation` answers the POSTs. */
async function open(scenario: Scenario | (() => Scenario), mutation: Handler) {
  freezeClock()
  const calls = serve(scenario, mutation)
  renderApp('#/ops')
  const actions = await screen.findByRole('region', { name: '降载与操作' })
  return { calls, actions, user: userEvent.setup() }
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST')

describe('actions', () => {
  it('confirms a canary run with the exact text and sends it with the CSRF token', async () => {
    const { calls, actions, user } = await open(healthy(), () => json({ run: STARTED }, 202))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    await user.click(button)

    const dialog = screen.getByRole('dialog', { name: '立即运行金丝雀？' })
    expect(dialog).toHaveAccessibleDescription(canaryConfirmText(3))
    expect(within(dialog).getByText(canaryConfirmText(3))).toBeInTheDocument()
    expect(canaryConfirmText(3)).toBe(
      '调用 Mail Hero 直接创建一封固定内容的合成测试邮件（不经过来源转发、Email Routing 收件、原件保存与解析），经正常投递链路发给 Todofy；Todofy 按正常流程调用 Gemini 摘要并校验（暂时性失败最多尝试 3 次，计入 Gemini 预算），不创建 Todoist 任务、不进入列表或提醒。本 UTC 日还可手动运行 3 次。',
    )
    // Focus starts on 取消, so Enter never confirms by accident.
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
    expect(posts(calls)).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: '确认运行' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const [post] = posts(calls)
    expect(post).toMatchObject({ path: '/api/v2/canary', body: '{"canary_id":"mail-todofy"}' })
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
    const { calls, actions, user } = await open(healthy(), () => {
      attempts += 1
      return attempts === 1 ? apiError(403, 'csrf_failed') : json({ run: STARTED }, 202)
    })
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    await waitFor(() => expect(within(actions).getByRole('status')).toHaveTextContent('已启动金丝雀'))
    expect(posts(calls).map((call) => call.headers['x-csrf-token'])).toEqual(['token-1', 'token-2'])
    expect(calls.filter((call) => call.path === '/api/v2/csrf')).toHaveLength(2)
  })

  it('does not retry a second csrf_failed and shows the error', async () => {
    const { calls, actions, user } = await open(healthy(), () => apiError(403, 'csrf_failed', '页面安全校验失败', 'bbbbbbbbbbbbbbbb'))
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    expect(await within(actions).findByRole('alert')).toHaveTextContent(
      '未能启动金丝雀：页面安全校验失败（请求 bbbbbbbbbbbbbbbb）',
    )
    expect(posts(calls)).toHaveLength(2)
  })

  it('reports canary_active without retrying', async () => {
    const { calls, actions, user } = await open(healthy(), () => apiError(409, 'canary_active', '已有金丝雀正在运行'))
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    expect(await within(actions).findByRole('alert')).toHaveTextContent('未能启动金丝雀：已有金丝雀正在运行')
    expect(posts(calls)).toHaveLength(1)
  })

  it('says why a manual run did not start at once (paused or unavailable)', async () => {
    const waiting: CanaryRun = { ...STARTED, start_code: 'send_paused' }
    let current = healthy()
    const { actions, user } = await open(
      () => current,
      () => {
        const canary = { ...current.ops.canary, active: waiting, today: waiting, recent: [waiting, ...current.ops.canary.recent], manual_today: 1 }
        const mail = current.flows.flows[0]!
        current = {
          ...current,
          ops: { ...current.ops, canary },
          flows: { ...current.flows, flows: [{ ...mail, canary: { ...canary, last_ok_at: null } }, ...current.flows.flows.slice(1)] },
        }
        return json({ run: waiting }, 202)
      },
    )
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认运行' }))
    await waitFor(() =>
      expect(within(actions).getByRole('status')).toHaveTextContent(
        '未能立即启动金丝雀 canary-manual-20260929T170000Z：投递已强制暂停；截止前每 30 分钟重试一次。',
      ),
    )
    // The mail flow's canary block shows the same run, waiting to be queued.
    await user.click(screen.getByRole('link', { name: '业务流程' }))
    const mail = await screen.findByRole('article', { name: '邮件 → 任务' })
    await user.click(within(mail).getByRole('button', { name: '展开 邮件 → 任务' }))
    const steps = within(within(mail).getByRole('list', { name: '运行阶段' })).getAllByRole('listitem')
    expect(steps[1]?.textContent).toBe('已排队进行中等待：投递已强制暂停（每 30 分钟重试，直到截止）')
  })

  it('keeps the canary button focusable but inert while a run is active', async () => {
    const { calls, actions, user } = await open(canaryActive(), () => json({}))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(
      '已有运行 canary-manual-20260929T165500Z 正在进行，结束后才能再次运行。',
    )
    await user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(calls)).toHaveLength(0)
  })

  it('disables the canary button while CANARY_ENABLED=false, even with a run in progress', async () => {
    const { calls, actions, user } = await open(canaryDisabled(), () => json({}))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).toHaveAccessibleDescription('金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false），不能手动运行。')
    await user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(calls)).toHaveLength(0)
  })

  it('shows the Worker\'s canary_disabled refusal (switched off since the page loaded)', async () => {
    const { calls, actions, user } = await open(healthy(), () =>
      apiError(409, 'canary_disabled', '金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）', 'dddddddddddddddd'),
    )
    await user.click(within(actions).getByRole('button', { name: '立即运行金丝雀' }))
    await user.click(screen.getByRole('button', { name: '确认运行' }))

    expect(await within(actions).findByRole('alert')).toHaveTextContent(
      '未能启动金丝雀：金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）（请求 dddddddddddddddd）',
    )
    expect(posts(calls)).toHaveLength(1)
  })

  it('stops manual runs at the daily limit', async () => {
    const scenario = healthy()
    const { actions } = await open({ ...scenario, ops: { ...scenario.ops, canary: { ...scenario.ops.canary, manual_today: 3 } } }, () => json({}))
    const button = within(actions).getByRole('button', { name: '立即运行金丝雀' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription('本 UTC 日的 3 次手动运行已用完。')
  })

  it('forces shed after confirmation and reports per-app failures', async () => {
    const guard: GuardViewV2 = guardShed().ops.guard
    const shed: GuardViewV2 = {
      ...guard,
      desired: { level: 'shed', reason: 'owner_shed', until: '2026-09-30T17:00:00.000Z', source: 'owner' },
      override: { level: 'shed', until: '2026-09-30T17:00:00.000Z', set_at: '2026-09-29T17:00:00.000Z' },
    }
    let current = healthy()
    const { calls, actions, user } = await open(
      () => current,
      () => {
        current = { ...current, ops: { ...current.ops, guard: shed } }
        return json({ guard: shed })
      },
    )
    await user.click(within(actions).getByRole('button', { name: '强制降载' }))

    const dialog = screen.getByRole('dialog', { name: '强制降载？' })
    expect(dialog).toHaveAccessibleDescription(SHED_CONFIRM_TEXT)
    expect(SHED_CONFIRM_TEXT).toBe(
      '立即让两个应用降载 24 小时：Mail Hero 推迟原件对账、保留期清理、金丝雀清理和告警历史清理（每项最多推迟 48 小时）；Todofy 推迟开始新一轮每周备份（上次完整备份超过 7.5 天仍会执行）、过期数据清理和趋势统计汇总（最多推迟 72 小时，之后补上）。收件、解析、投递、重试、已在进行的备份和真实邮件处理不受影响。可随时解除。',
    )
    await user.click(within(dialog).getByRole('button', { name: '确认降载' }))

    await waitFor(() => expect(within(actions).getByRole('status')).toHaveTextContent('已要求两个应用降载'))
    expect(within(actions).getByRole('status')).toHaveTextContent(
      '已要求两个应用降载，直到 10月1日 01:00。Todofy 调用失败（超时），下次定时检查会重试。',
    )
    const [post] = posts(calls)
    expect(post).toMatchObject({ path: '/api/v2/guard', body: '{"level":"shed"}' })
    expect(post?.headers['x-csrf-token']).toBe('token-1')
    expect(within(actions).getByText('手动')).toBeInTheDocument()
    expect(within(actions).getByText(/强制降载，至/)).toBeInTheDocument()
  })

  it('clears the guard after confirmation', async () => {
    const scenario = guardShed()
    const guard = scenario.ops.guard
    const cleared: GuardViewV2 = {
      ...guard,
      desired: { level: 'normal', reason: 'owner_clear', until: null, source: 'owner' },
      override: { level: 'normal', until: '2026-09-30T00:00:00.000Z', set_at: '2026-09-29T17:00:00.000Z' },
      apps: {
        'mail-hero': { ...guard.apps['mail-hero']!, last_error: null },
        todofy: { ...guard.apps.todofy!, last_error: null },
      },
    }
    const { calls, actions, user } = await open(scenario, () => json({ guard: cleared }))
    await user.click(within(actions).getByRole('button', { name: '解除降载' }))

    const dialog = screen.getByRole('dialog', { name: '解除降载？' })
    // The fixed clock is 17:00 UTC; the next 00:00 UTC is 08:00 in Asia/Shanghai.
    expect(dialog).toHaveAccessibleDescription(clearConfirmText('08:00'))
    expect(clearConfirmText('08:00')).toBe(
      '立即结束两个应用的降载，并在本 UTC 日剩余时间内暂停自动降载；次日 00:00 UTC（本地 08:00）起恢复自动判断。',
    )
    await user.click(within(dialog).getByRole('button', { name: '确认解除' }))

    await waitFor(() =>
      expect(within(actions).getByRole('status')).toHaveTextContent('已解除降载，本 UTC 日剩余时间内不会自动降载。'),
    )
    expect(posts(calls)[0]).toMatchObject({ path: '/api/v2/guard', body: '{"level":"normal"}' })
  })

  it('closes on Escape without sending and returns focus; Tab stays inside the dialog', async () => {
    const { calls, actions, user } = await open(healthy(), () => json({}))
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
