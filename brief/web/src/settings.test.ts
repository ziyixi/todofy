/**
 * 设置 against the fake API: the run's facts in words, 暂停 (only `paused` and the etag in the mask), a stale etag that
 * reloads the page's values, the monthly budget (its meter and remainder, a value outside 5-100 refused before
 * sending, a saved one in the header), 恢复调用 after a refusal behind a confirmation, a missing key, mail not
 * configured while sending, an issue being made, and the recent error codes.
 */
import { Mode, ServiceStatus_KeyState } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { FakeServer, settle } from './test/fakeServer.ts'
import { buttonNamed, open, statusLine, testHost, toastText } from './test/helpers.ts'

const facts = (root: HTMLElement) => [...root.querySelectorAll('.kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
const card = (root: HTMLElement, title: string) => [...root.querySelectorAll('.card')].find((node) => node.querySelector('h2')?.textContent === title)
const query = (path: string) => Object.fromEntries(new URL(path, 'https://brief.ziyixi.science').searchParams.entries())

describe('设置', () => {
  it('states the run in words', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect(facts(root)).toEqual([
      ['模式', '正式工作日 06:30、周六 07:30（美西时间）发信（部署变量 BRIEF_MODE）'],
      ['Claude 密钥', '正常'],
      ['发信', '已配置'],
      ['下次运行', '2 小时后'],
      ['今日', '抓取 230 条 · 初筛 180 条 · 向量 64 神经元'],
      ['来源', '正常 40'],
    ])
    expect(root.querySelector('.build')?.textContent).toBe('版本 0123456')
    expect(root.querySelector('details.more')).toBeNull()
  })

  it('pauses with only `paused` and the etag in the mask, then shows it in the header', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const input = root.querySelector<HTMLInputElement>('input.switch')
    if (input === null) throw new Error('no switch')
    expect(input.checked).toBe(false)
    input.checked = true
    input.dispatchEvent(new Event('change'))
    await settle()
    const [call] = fake.mutations()
    expect(call?.method).toBe('PATCH')
    expect(query(call?.path ?? '')).toMatchObject({ update_mask: 'paused,etag' })
    // The name is the path (/api/v1/settings); the body holds only what the mask names.
    expect(call?.path.split('?')[0]).toBe('/api/v1/settings')
    expect(call?.body).toEqual({ paused: true, etag: 's1' })
    expect(toastText(root)).toBe('已暂停')
    expect(root.querySelector<HTMLInputElement>('input.switch')?.checked).toBe(true)
    expect(statusLine(root)).toContainEqual(['已暂停', 'problem'])
  })

  it('reloads the values when the settings changed elsewhere', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    fake.settings.paused = true
    fake.settings.etag = 's2'
    const input = root.querySelector<HTMLInputElement>('input.switch')
    if (input === null) throw new Error('no switch')
    input.checked = true
    input.dispatchEvent(new Event('change'))
    await settle()
    expect(toastText(root)).toBe('设置已在别处修改，已载入最新内容')
    expect(fake.settings.etag).toBe('s2')
    expect(root.querySelector<HTMLInputElement>('input.switch')?.checked).toBe(true)
  })

  it('shows the month against the budget and saves a new budget', async () => {
    const fake = new FakeServer()
    fake.status = { reservedUsd: 1.85 }
    const root = await open(fake, '/settings')
    const budget = card(root, '预算')
    expect(budget?.querySelector('.card-head .meta')?.textContent).toBe('本月 $9.80 / $40')
    expect(budget?.querySelector<HTMLElement>('.meter span')?.style.width).toBe('29%')
    expect([...(budget?.querySelectorAll('.facts span') ?? [])].map((node) => node.textContent)).toEqual(['今日 $0.12', '预留 $1.85', '剩余 $28.35'])
    const field = budget?.querySelector<HTMLInputElement>('input[type="number"]')
    if (field === undefined || field === null) throw new Error('no field')
    expect([field.value, field.min, field.max]).toEqual(['40', '5', '100'])
    field.value = '150'
    budget?.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(toastText(root)).toBe('每月预算须在 5 到 100 美元之间')
    expect(fake.mutations()).toEqual([])
    field.value = '60'
    budget?.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    const [call] = fake.mutations()
    expect(query(call?.path ?? '')).toMatchObject({ update_mask: 'monthly_budget_usd,etag' })
    expect(call?.body).toEqual({ monthly_budget_usd: 60, etag: 's1' })
    expect(toastText(root)).toBe('每月预算改为 $60')
    expect(card(root, '预算')?.querySelector('.card-head .meta')?.textContent).toBe('本月 $9.80 / $60')
    expect(statusLine(root)).toContainEqual(['本月 $9.80 / $60', ''])
  })

  it('resumes the model calls after a refusal, only once the owner confirms', async () => {
    const fake = new FakeServer()
    fake.status = { keyState: ServiceStatus_KeyState.REJECTED, rejectedStatus: 7, rejectedErrorType: 'MODEL_AUTH' }
    const no = testHost(false)
    let root = await open(fake, '/settings', no)
    expect(root.querySelector('.key .warn')?.textContent).toBe('被拒（code 7 · MODEL_AUTH），模型调用已全部停止')
    buttonNamed(root, '恢复调用').click()
    await settle()
    expect(no.asked).toHaveLength(1)
    expect(fake.mutations()).toEqual([])
    document.body.replaceChildren()
    root = await open(fake, '/settings')
    buttonNamed(root, '恢复调用').click()
    await settle()
    expect(fake.mutations().map((call) => [call.method, call.path])).toEqual([['POST', '/api/v1/serviceStatus:resumeModelCalls']])
    expect(toastText(root)).toBe('已恢复调用')
    expect(facts(root)[1]).toEqual(['Claude 密钥', '正常'])
    expect(statusLine(root).map(([text]) => text)).not.toContain('调用被拒')
  })

  it('names a missing key, mail not configured while sending, the issue being made and recent error codes', async () => {
    const fake = new FakeServer()
    fake.status = {
      mode: Mode.SHADOW,
      keyState: ServiceStatus_KeyState.NOT_CONFIGURED,
      mailConfigured: false,
      currentIssue: 'issues/2026-10-12',
      currentStep: 'write',
      failingSourceCount: 2,
      staleSourceCount: 1,
      recentErrorCodes: ['write_attempts', 'resend_429'],
    }
    const root = await open(fake, '/settings')
    expect(facts(root)).toEqual([
      ['模式', '影子发信，标题带“[影子版]”（部署变量 BRIEF_MODE）'],
      ['Claude 密钥', '未绑定 Model Router'],
      ['发信', '未配置'],
      ['进行中', '正在制作 10月12日 周一 · 写作'],
      ['今日', '抓取 230 条 · 初筛 180 条 · 向量 64 神经元'],
      ['来源', '正常 40 · 失败 2 · 沉寂 1'],
    ])
    expect(root.querySelector('.kv dd .warn')?.textContent).toBe('未绑定 Model Router')
    const codes = root.querySelector('details.more')
    expect(codes?.querySelector('summary')?.textContent).toBe('最近的错误代码（2）')
    expect([...(codes?.querySelectorAll('li') ?? [])].map((node) => node.textContent)).toEqual(['write_attempts', 'resend_429'])
  })
})
