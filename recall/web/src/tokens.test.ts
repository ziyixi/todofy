import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { MachineTokenSchema, ServiceStatusSchema } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api, ApiError } from './api.ts'
import type { ViewContext } from './app.ts'
import { buttonNamed, testHost } from './test/helpers.ts'
import { NOW } from './test/fakeServer.ts'
import { paintTokens } from './views/tokens.ts'

const named = 'machineTokens/00000000-0000-4000-8000-0000000000bb'
const secret = `recall_ingest_${'S'.repeat(43)}`

function setup() {
  const box = document.createElement('div')
  const toast = document.createElement('div')
  toast.id = 'toast'
  document.body.append(box, toast)
  const ctx: ViewContext = {
    main: box, host: testHost(), go: () => Promise.resolve(), replace: () => undefined, back: () => undefined,
    status: () => Promise.resolve(create(ServiceStatusSchema)), onLeave: () => undefined, keep: () => undefined, restored: () => undefined,
  }
  return { box, ctx }
}

afterEach(() => { vi.restoreAllMocks() })

describe('口令列表与改名', () => {
  it('lists named and shared uploads together with one name line and a folded export credential', () => {
    const { box, ctx } = setup()
    paintTokens(ctx, box, [
      create(MachineTokenSchema, { name: named, label: '日常浏览', createTime: timestampFromMs(NOW) }),
      create(MachineTokenSchema, { name: 'machineTokens/ingest', createTime: timestampFromMs(NOW) }),
      create(MachineTokenSchema, { name: 'machineTokens/export', label: '归档读取', createTime: timestampFromMs(NOW) }),
    ])
    const rows = box.querySelectorAll(':scope > .token-list > li')
    expect([...rows].map((row) => row.querySelector('.row-title')?.textContent)).toEqual(['日常浏览', '共享插件口令'])
    expect([...rows].map((row) => row.querySelector('.token-meta')?.textContent)).toEqual(['上传口令 · 刚刚生成', '共享上传口令 · 刚刚生成'])
    expect(box.querySelector('h3')).toBeNull()
    expect([...rows].every((row) => row.querySelector('.menu-items')?.hasAttribute('hidden'))).toBe(true)
    expect(box.querySelector('details')?.open).toBe(false)
    expect(box.querySelector('details .row-title')?.textContent).toBe('归档读取')
    expect(box.textContent).toContain('一个口令可用于多台设备')
  })

  it.each([named, 'machineTokens/ingest', 'machineTokens/export'])('renames %s without replacing its one-time visible secret', async (name) => {
    const { box, ctx } = setup()
    const token = create(MachineTokenSchema, { name, label: '原名称', createTime: timestampFromMs(NOW) })
    const update = vi.spyOn(api, 'updateMachineToken').mockResolvedValue(create(MachineTokenSchema, { ...token, label: '新名称' }))
    const regenerate = vi.spyOn(api, 'regenerateMachineToken')
    paintTokens(ctx, box, [token], { name, token: secret })
    buttonNamed(box, '原名称的更多操作').click()
    buttonNamed(box, '改名').click()
    const form = box.querySelector<HTMLFormElement>('.token-rename:not([hidden])')!
    form.querySelector('input')!.value = ' 新名称 '
    buttonNamed(form, '保存名称').click()
    await vi.waitFor(() => { expect(box.querySelector('.row-title')?.textContent).toBe('新名称') })
    expect(update).toHaveBeenCalledOnce()
    const request = update.mock.calls[0]?.[0]
    expect(request?.machineToken).toEqual({ name, label: '新名称' })
    expect(request?.updateMask).toEqual({ paths: ['label'] })
    expect(request?.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(regenerate).not.toHaveBeenCalled()
    expect(box.querySelector<HTMLInputElement>('.token-once input')?.value).toBe(secret)
  })

  it('renames an existing Worker-configured shared token without generating another credential', async () => {
    const { box, ctx } = setup()
    const token = create(MachineTokenSchema, { name: 'machineTokens/ingest', workerSecret: true })
    const update = vi.spyOn(api, 'updateMachineToken').mockResolvedValue(create(MachineTokenSchema, { ...token, label: '现有浏览器' }))
    const regenerate = vi.spyOn(api, 'regenerateMachineToken')
    paintTokens(ctx, box, [token])
    const row = box.querySelector(':scope > .token-list .shared-token')!
    expect(row?.querySelector('.row-title')?.textContent).toBe('共享插件口令')
    expect(row?.querySelector('.token-meta')?.textContent).toContain('Worker 配置')
    buttonNamed(row, '共享插件口令的更多操作').click()
    const actions = [...row.querySelectorAll('.menu-items button')].map((item) => item.textContent)
    expect(actions).toEqual(['改名', '生成可管理口令'])
    buttonNamed(row, '改名').click()
    const form = row.querySelector<HTMLFormElement>('.token-rename')!
    form.querySelector('input')!.value = '现有浏览器'
    buttonNamed(form, '保存名称').click()
    await vi.waitFor(() => { expect(box.querySelector('.shared-token .row-title')?.textContent).toBe('现有浏览器') })
    expect(update).toHaveBeenCalledOnce()
    expect(regenerate).not.toHaveBeenCalled()
    expect(box.querySelector('.shared-token .hint')?.textContent).toContain('Worker 密钥')
  })

  it('keeps the name and secret on cancel or an empty rename', () => {
    const { box, ctx } = setup()
    const update = vi.spyOn(api, 'updateMachineToken')
    paintTokens(ctx, box, [create(MachineTokenSchema, { name: named, label: '日常浏览', createTime: timestampFromMs(NOW) })], { name: named, token: secret })
    buttonNamed(box, '日常浏览的更多操作').click()
    buttonNamed(box, '改名').click()
    const form = box.querySelector<HTMLFormElement>('.token-rename')!
    const input = form.querySelector('input')!
    input.value = '不保存'
    buttonNamed(form, '取消').click()
    expect(form.hidden).toBe(true)
    expect(input.value).toBe('日常浏览')
    buttonNamed(box, '日常浏览的更多操作').click()
    buttonNamed(box, '改名').click()
    input.value = '  '
    buttonNamed(form, '保存名称').click()
    expect(update).not.toHaveBeenCalled()
    expect(form.hidden).toBe(false)
    expect(box.querySelector<HTMLInputElement>('.token-once input')?.value).toBe(secret)
  })

  it('keeps the edit and visible secret when the server rejects a name', async () => {
    const { box, ctx } = setup()
    vi.spyOn(api, 'updateMachineToken').mockRejectedValue(new ApiError(400, 'INVALID_ARGUMENT', '名称不对'))
    paintTokens(ctx, box, [create(MachineTokenSchema, { name: named, label: '日常浏览', createTime: timestampFromMs(NOW) })], { name: named, token: secret })
    buttonNamed(box, '日常浏览的更多操作').click()
    buttonNamed(box, '改名').click()
    const form = box.querySelector<HTMLFormElement>('.token-rename')!
    form.querySelector('input')!.value = '新名称'
    buttonNamed(form, '保存名称').click()
    await vi.waitFor(() => { expect(document.querySelector('#toast')?.textContent).toBe('名称不对') })
    expect(form.hidden).toBe(false)
    expect(buttonNamed(form, '保存名称').disabled).toBe(false)
    expect(box.querySelector<HTMLInputElement>('.token-once input')?.value).toBe(secret)
    expect(box.querySelector('.row-title')?.textContent).toBe('日常浏览')
  })
})
