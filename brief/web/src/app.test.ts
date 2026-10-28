/**
 * The shell against the fake API: the four tabs (only marked, so a tab chosen by keyboard keeps the focus), the quiet
 * status line and what it raises in the warning color (paused, a refused key, a missing key, mail not configured while
 * sending, the month's budget spent), the step being made, a failed status, an unknown path, and back.
 */
import { Mode, ServiceStatus_KeyState } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { FakeServer, HOUR, NOW, settle } from './test/fakeServer.ts'
import { open, statusLine } from './test/helpers.ts'

describe('the shell', () => {
  it('has four tabs and the quiet status line, and answers an unknown path', async () => {
    const root = await open(new FakeServer(), '/nowhere')
    expect(root.querySelector('.brand')?.textContent).toBe('简报')
    expect([...root.querySelectorAll<HTMLAnchorElement>('.tabs a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['期刊', '/'],
      ['来源', '/sources'],
      ['偏好', '/profile'],
      ['设置', '/settings'],
    ])
    expect(root.querySelector('.tabs a[aria-current]')).toBeNull()
    expect(statusLine(root)).toEqual([
      ['正式', 'chip accent'],
      ['下次运行 2 小时后', ''],
      ['今日 $0.12', ''],
      ['本月 $9.80 / $40', ''],
    ])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('says in the warning color what needs the owner', async () => {
    const fake = new FakeServer()
    fake.settings.paused = true
    fake.status = { mode: Mode.SHADOW, keyState: ServiceStatus_KeyState.REJECTED, rejectedStatus: 402, rejectedErrorType: 'billing_error', mailConfigured: false, monthCostUsd: 40.2 }
    const root = await open(fake, '/')
    expect(statusLine(root)).toEqual([
      ['影子', 'chip muted'],
      ['已暂停', 'problem'],
      ['调用被拒', 'problem'],
      ['发信未配置', 'problem'],
      ['下次运行 2 小时后', ''],
      ['今日 $0.12', ''],
      ['本月 $40.20 / $40', 'problem'],
    ])
  })

  it('names a missing key, leaves mail alone in archive mode, and shows the step being made', async () => {
    const fake = new FakeServer()
    fake.status = { mode: Mode.ARCHIVE, keyState: ServiceStatus_KeyState.NOT_CONFIGURED, mailConfigured: false, currentIssue: 'issues/2026-10-12', currentStep: 'write' }
    const root = await open(fake, '/')
    expect(statusLine(root).slice(0, 3)).toEqual([
      ['仅归档', 'chip muted'],
      ['未绑定 Model Router', 'problem'],
      ['制作中：写作', ''],
    ])
  })

  it('marks the mode off in the warning color and a failed status as a problem', async () => {
    const off = new FakeServer()
    off.status = { mode: Mode.OFF, nextAlarmTime: timestampFromMs(NOW - HOUR) }
    expect(statusLine(await open(off, '/'))[0]).toEqual(['关闭', 'chip warn'])
    document.body.replaceChildren()
    const failing = new FakeServer()
    failing.statusFailures = 1
    expect(statusLine(await open(failing, '/'))).toEqual([['状态读取失败', 'problem']])
  })

  it('keeps the focus on a tab chosen by keyboard, marks the tab of an issue, and goes back', async () => {
    const root = await open(new FakeServer(), '/')
    const sources = root.querySelector<HTMLAnchorElement>('.tabs a[href="/sources"]')
    if (sources === null) throw new Error('no tab')
    sources.focus()
    sources.click()
    await settle()
    expect(window.location.pathname).toBe('/sources')
    expect(document.activeElement).toBe(sources)
    expect(sources.getAttribute('aria-current')).toBe('page')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/"]')?.click()
    await settle()
    root.querySelector<HTMLAnchorElement>('a.row-link')?.click()
    await settle()
    expect(window.location.pathname).toBe('/issues/2026-10-12')
    expect(root.querySelector('.tabs a[aria-current]')?.textContent).toBe('期刊')
    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settle()
    expect(window.location.pathname).toBe('/')
    expect(root.querySelectorAll('a.row-link')).toHaveLength(2)
  })

  it('answers a malformed issue path as an unknown page', async () => {
    const root = await open(new FakeServer(), '/issues/latest')
    expect(root.textContent).toContain('找不到这个页面')
  })
})
