/** Prompt editing through the generated owner API, with synthetic text only. */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationPromptSchema } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb'
import { mountApp } from './app.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

const confirm = vi.fn(() => true)

async function open(server: FakeServer): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', '/settings')
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, { now: () => NOW, confirm })
  await settle()
  return root
}

function editor(root: HTMLElement): HTMLElement {
  const found = root.querySelector<HTMLElement>('.prompt-card')
  if (found === null) throw new Error('missing prompt editor')
  return found
}

function field(root: HTMLElement, name: 'personal' | 'base'): HTMLTextAreaElement {
  const found = root.querySelector<HTMLTextAreaElement>(name === 'personal' ? '#classification-personal-rules' : '#classification-base-text')
  if (found === null) throw new Error(`missing ${name}`)
  return found
}

function button(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === name)
  if (found === undefined) throw new Error(`missing ${name}`)
  return found
}

function edit(target: HTMLTextAreaElement, value: string): void {
  target.value = value
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

function savedServer(): FakeServer {
  const server = new FakeServer()
  server.classificationPrompt = create(ClassificationPromptSchema, { ...server.classificationPrompt, etag: 'saved-1', updateTime: timestampFromMs(NOW) })
  return server
}

describe('classification prompt editor', () => {
  it('keeps personal rules expanded and allows an unchanged default to be explicitly saved', async () => {
    const server = new FakeServer()
    const root = await open(server)
    const card = editor(root)
    expect(field(card, 'personal').value).toBe(server.classificationPrompt.personalRules)
    expect(field(card, 'personal').closest('details')).toBeNull()
    expect(card.querySelector('details')?.open).toBe(false)
    expect(card.textContent).toContain('这两段文本会原样发送给 Claude')
    expect(card.textContent).toContain('不会自动重判已分类邮件')
    expect(button(card, '保存').disabled).toBe(false)
    button(card, '保存').click()
    await settle()
    const request = server.calls.find((call) => call.method === 'PATCH' && call.path.includes('/classificationPrompt'))
    expect(decodeURIComponent(request?.path ?? '')).toContain('update_mask=base_text,personal_rules,etag')
    expect(request?.body).toMatchObject({ etag: 'initial', base_text: server.classificationPrompt.baseText, personal_rules: server.classificationPrompt.personalRules })
    expect(new URL(request?.path ?? '/', 'https://synthetic.example').searchParams.get('request_id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(request?.headers['x-csrf-token']).toBe('csrf-token')
    expect(server.classificationPrompt.updateTime).toBeDefined()
    expect(card.textContent).toContain('已保存，从下一批开始使用')
    expect(button(card, '保存').disabled).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('preserves exact edits, DOM, expanded core and caret while saving, then reads the persisted values', async () => {
    const server = savedServer()
    const root = await open(server)
    const card = editor(root)
    const personal = field(card, 'personal')
    const base = field(card, 'base')
    const details = card.querySelector('details')
    if (details === null) throw new Error('missing core details')
    expect(button(card, '保存').disabled).toBe(true)
    details.open = true
    const personalText = '  合成规则 A\n规则 B  '
    const baseText = ' 合成基础\n保留原样。 '
    edit(personal, personalText)
    edit(base, baseText)
    personal.focus()
    personal.setSelectionRange(2, 4)
    expect(card.textContent).toContain('有未保存的修改')
    const fetcher = globalThis.fetch
    let finish: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (init.method === 'PATCH' && url.includes('/classificationPrompt')) await waiting
      return fetcher(url, init)
    })
    const save = button(card, '保存')
    save.click()
    save.click()
    expect(save.disabled).toBe(true)
    expect(personal.readOnly).toBe(true)
    expect(card.textContent).toContain('保存中…')
    finish?.()
    await settle()
    expect(editor(root)).toBe(card)
    expect(field(card, 'personal')).toBe(personal)
    expect(field(card, 'base')).toBe(base)
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(personal)
    expect([personal.selectionStart, personal.selectionEnd]).toEqual([2, 4])
    expect(server.classificationPrompt.personalRules).toBe(personalText)
    expect(server.classificationPrompt.baseText).toBe(baseText)
    expect(server.calls.filter((call) => call.method === 'PATCH' && call.path.includes('/classificationPrompt'))).toHaveLength(1)
    expect(button(card, '保存').disabled).toBe(true)
    root.remove()
    const reloaded = await open(server)
    expect(field(editor(reloaded), 'personal').value).toBe(personalText)
    expect(field(editor(reloaded), 'base').value).toBe(baseText)
  })

  it('isolates a prompt GET failure from mode and undo, and reloads the editor independently', async () => {
    const server = new FakeServer()
    server.promptReadFails = true
    const root = await open(server)
    const card = editor(root)
    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['模式', '分类提示词', '撤销', '历史效果检查'])
    expect(card.textContent).toContain('提示词读取失败')
    expect(button(card, '保存').disabled).toBe(true)
    expect(field(card, 'personal').readOnly).toBe(true)
    server.promptReadFails = false
    button(card, '重新加载').click()
    await settle()
    expect(editor(root)).toBe(card)
    expect(field(card, 'personal').value).toBe(server.classificationPrompt.personalRules)
    expect(button(card, '保存').disabled).toBe(false)
    expect(server.calls.filter((call) => call.path === '/api/v2/settings')).toHaveLength(1)
  })

  it('keeps a failed save draft intact and allows retry without a confirmation dialog', async () => {
    const server = savedServer()
    const root = await open(server)
    const card = editor(root)
    edit(field(card, 'personal'), '合成修改，等待保存。')
    server.promptSaveFails = true
    button(card, '保存').click()
    await settle()
    expect(card.textContent).toContain('提示词未保存')
    expect(field(card, 'personal').value).toBe('合成修改，等待保存。')
    expect(button(card, '保存').disabled).toBe(false)
    server.promptSaveFails = false
    button(card, '保存').click()
    await settle()
    expect(server.classificationPrompt.personalRules).toBe('合成修改，等待保存。')
    expect(card.textContent).toContain('已保存，从下一批开始使用')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('retains a conflicting draft and reloads the current server text only on request', async () => {
    const server = savedServer()
    const root = await open(server)
    const card = editor(root)
    edit(field(card, 'personal'), '本页草稿。')
    server.classificationPrompt = create(ClassificationPromptSchema, { ...server.classificationPrompt, personalRules: '另一页保存的内容。', etag: 'changed-2' })
    button(card, '保存').click()
    await settle()
    expect(card.textContent).toContain('已在别处修改')
    expect(field(card, 'personal').value).toBe('本页草稿。')
    expect(card.textContent).toContain('重新加载会替换当前未保存的内容')
    button(card, '重新加载').click()
    await settle()
    expect(field(card, 'personal').value).toBe('另一页保存的内容。')
    expect(button(card, '保存').disabled).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('validates the combined UTF-8 byte limit and required base, while allowing empty personal rules', async () => {
    const server = savedServer()
    const root = await open(server)
    const card = editor(root)
    edit(field(card, 'personal'), '中'.repeat(4096))
    expect(card.textContent).toContain('两段文本合计最多 12 KiB')
    expect(button(card, '保存').disabled).toBe(true)
    edit(field(card, 'personal'), '')
    edit(field(card, 'base'), ' \n ')
    expect(card.textContent).toContain('基础提示词不能为空')
    expect(button(card, '保存').disabled).toBe(true)
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false)
    edit(field(card, 'base'), '合成基础。')
    button(card, '保存').click()
    await settle()
    expect(server.classificationPrompt.personalRules).toBe('')
    expect(server.classificationPrompt.baseText).toBe('合成基础。')
  })

  it('preserves an unsaved editor instance when the existing mode card reloads settings', async () => {
    const server = savedServer()
    const root = await open(server)
    const card = editor(root)
    edit(field(card, 'personal'), '切换模式前的合成草稿。')
    button(root, '关闭').click()
    await settle()
    expect(editor(root)).toBe(card)
    expect(field(card, 'personal').value).toBe('切换模式前的合成草稿。')
    expect(card.textContent).toContain('有未保存的修改')
    expect(server.calls.filter((call) => call.method === 'GET' && call.path === '/api/v2/classificationPrompt')).toHaveLength(1)
  })
})
