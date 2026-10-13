/** Named upload tokens and the existing shared/export credentials. Tokens stay only in this view's memory. */
import { create } from '@ziyixi/proto/protobuf'
import { MachineTokenSchema, type MachineToken } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { disclosure, menu, type MenuAction } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { ago, ms, span } from '../format.ts'
import { act } from './common.ts'

/** The two machine tokens' words. */
const TOKEN_WORDS = {
  ingest: {
    name: '共享插件口令',
    none: '还没有口令：生成后粘贴到扩展的选项里，扩展才能上传。',
    regenerate: '重新生成共享插件口令？旧口令 24 小时内仍可用，在这之前把新口令粘贴到扩展的选项里。',
    revoke: '旧口令会立即失效，扩展换上新口令前无法上传。继续？',
    remove: '停用共享插件口令？使用这个口令的设备会停止上传，独立口令不受影响。',
    secret: '另有一个在 Worker 密钥里设置的口令同样有效，只有删除那个密钥才能停用它。',
  },
  export: {
    name: '导出口令',
    none: '只给通过变更 feed 读取全部记录的程序用；Dropbox 备份不需要它。',
    regenerate: '重新生成导出口令？旧口令 24 小时内仍可用。',
    revoke: '旧导出口令会立即失效。继续？',
    remove: '停用导出口令？读取变更 feed 的程序会立即失去访问。',
    secret: '另有一个在 Worker 密钥里设置的导出口令同样有效，只有删除那个密钥才能停用它。',
  },
} as const

type Route = keyof typeof TOKEN_WORDS

type ShownToken = { readonly name: string; readonly token: string } | null

/** One list for upload credentials; export access remains optional and folded. */
export function paintTokens(ctx: ViewContext, box: HTMLElement, tokens: readonly MachineToken[], shown: ShownToken = null): void {
  const of = (route: Route) => tokens.find((item) => item.name === `machineTokens/${route}`) ?? create(MachineTokenSchema, { name: `machineTokens/${route}` })
  const repaint = (next: MachineToken | null, name: string, secret: ShownToken = shown) => {
    let updated: readonly MachineToken[]
    if (next === null) updated = tokens.filter((item) => item.name !== name)
    else if (tokens.some((item) => item.name === name)) updated = tokens.map((item) => item.name === name ? next : item)
    else updated = [...tokens, next]
    paintTokens(ctx, box, updated, secret)
  }
  const row = (token: MachineToken) => tokenRow(ctx, token, shown, (next, secret = shown) => repaint(next, token.name, secret))
  const shared = of('ingest')
  const exported = of('export')
  const sharedExists = ms(shared.createTime) !== null || shared.workerSecret
  const active = tokens.filter((item) => !['machineTokens/ingest', 'machineTokens/export'].includes(item.name))
  if (sharedExists) active.push(shared)
  const exportBox = disclosure('导出口令（可选）', el('ul', { class: 'rows token-list' }, row(exported)))
  if (shown?.name === exported.name) exportBox.open = true
  fill(box,
    el('p', { class: 'hint' }, '为口令命名，方便辨认和单独停用。一个口令可用于多台设备。'),
    active.length === 0 ? null : el('ul', { class: 'rows token-list' }, ...active.map(row)),
    addToken(tokens, (next, secret) => paintTokens(ctx, box, next, secret)),
    sharedExists ? null : disclosure('共享插件口令（兼容现有设备）', el('ul', { class: 'rows token-list' }, row(shared))),
    exportBox,
  )
}

/** One credential, with naming and dangerous actions in the same menu. */
function tokenRow(ctx: ViewContext, token: MachineToken, shown: ShownToken, repaint: (next: MachineToken | null, secret?: ShownToken) => void): HTMLElement {
  const route: Route | null = token.name === 'machineTokens/ingest' ? 'ingest' : token.name === 'machineTokens/export' ? 'export' : null
  const words = route === null ? null : TOKEN_WORDS[route]
  const label = token.label || words?.name || '插件口令'
  const made = ms(token.createTime)
  const configuredOnly = words !== null && token.workerSecret && made === null
  const regenerate = async (revokePrevious: boolean) => {
    if (words === null) return
    await act((requestId) => api.regenerateMachineToken({ name: token.name, revokePrevious, requestId }), `已生成新的${words.name}`, (answer) => {
      if (answer.token === '') toast(`没有收到新${words.name}：请再生成一次`)
      repaint(answer, answer.token === '' ? null : { name: answer.name, token: answer.token })
    })
  }
  const remove = () => {
    if (!ctx.host.confirm(words?.remove ?? `停用“${label}”的上传口令？使用这个口令的设备会停止上传，已记录内容保留。`)) return
    void act((requestId) => api.deleteMachineToken({ name: token.name, requestId }), '已停用口令', () => {
      const next = route === null ? null : create(MachineTokenSchema, { name: token.name, label: token.label, workerSecret: token.workerSecret })
      repaint(next, shown?.name === token.name ? null : shown)
    })
  }
  const field = el('input', { type: 'text', value: label, 'aria-label': `修改 ${label} 的名称`, maxlength: '80', autocomplete: 'off' })
  const cancel = button('取消', () => { rename.hidden = true; field.value = label }, { class: 'quiet small' })
  const save = el('button', { type: 'submit', class: 'small' }, '保存名称')
  const rename = el('form', { class: 'actions token-rename', hidden: true, 'aria-label': `修改 ${label} 的名称` }, field, save, cancel)
  rename.addEventListener('submit', (event) => {
    event.preventDefault()
    const nextLabel = field.value.trim()
    if (nextLabel === '') { toast('先填写口令名称'); field.focus(); return }
    if (save.disabled) return
    save.disabled = cancel.disabled = true
    void act((requestId) => api.updateMachineToken({ machineToken: { name: token.name, label: nextLabel }, updateMask: { paths: ['label'] }, requestId }), '已修改口令名称', (answer) => repaint(answer))
      .finally(() => { save.disabled = cancel.disabled = false })
  })
  const actions: MenuAction[] = [
    ['改名', () => { rename.hidden = false; field.focus(); field.select() }],
  ]
  if (configuredOnly) {
    actions.push(['生成可管理口令', () => {
      if (ctx.host.confirm('生成一个可在此管理的新口令？当前 Worker 配置的口令继续有效。')) void regenerate(false)
    }])
  } else {
    if (words !== null) actions.push(
      ['重新生成', () => { if (ctx.host.confirm(words.regenerate)) void regenerate(false) }],
      ['旧口令泄露：立即作废并重新生成', () => { if (ctx.host.confirm(words.revoke)) void regenerate(true) }, 'danger'],
    )
    actions.push(['停用', remove, 'danger'])
  }
  const until = ms(token.previousExpireTime)
  let generated = '生成时间未知'
  if (configuredOnly) generated = 'Worker 配置 · 生成时间未知'
  else if (made !== null) generated = `${ago(made, ctx.host.now())}生成`
  return el('li', { class: `token-row${route === null ? '' : route === 'ingest' ? ' shared-token' : ' export-token'}` },
    made === null && words !== null && !configuredOnly
      ? el('div', {}, el('p', { class: 'hint' }, words.none), button('生成', () => void regenerate(false), { class: 'small' }))
      : el('div', {},
        el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, label), menu(`${label}的更多操作`, actions)),
        el('p', { class: 'meta token-meta' }, `${route === 'export' ? '导出口令' : route === 'ingest' ? '共享上传口令' : '上传口令'} · ${generated}`),
        rename,
      ),
    until === null ? null : el('p', { class: 'hint' }, `旧口令 ${span(until - ctx.host.now())}内仍可用`),
    token.workerSecret && words !== null ? el('p', { class: 'hint' }, configuredOnly ? '这个口令在 Worker 密钥里配置；改名不会更换它，停用需要删除对应密钥。' : words.secret) : null,
    shown?.name === token.name ? onceBox(shown.token, route === null ? `${label} 的口令` : label) : null,
  )
}

/** A new token, shown this once: read-only, selected, with 复制 and what to do with it. */
function onceBox(token: string, name: string): HTMLElement {
  const field = el('input', { type: 'text', readonly: true, value: token, class: 'mono', 'aria-label': `新的${name}`, spellcheck: 'false', autocomplete: 'off' })
  const copy = async () => {
    field.select()
    try {
      await navigator.clipboard.writeText(token)
      toast(`已复制${name}`)
    } catch {
      toast('没能复制：已选中口令，请手动复制')
    }
  }
  return el(
    'div',
    { class: 'token-once', role: 'note' },
    el('p', { class: 'hint warn' }, `新的${name}只显示这一次：现在复制，粘贴到扩展的选项里。离开或刷新这一页后不会再显示。`),
    el('div', { class: 'actions' }, field, button('复制', () => void copy())),
    el('p', { class: 'hint' }, `扩展里的服务器地址：${window.location.origin}`),
  )
}

/** Add an upload credential; its name does not bind it to a single device. */
function addToken(tokens: readonly MachineToken[], repaint: (tokens: readonly MachineToken[], shown: ShownToken) => void): HTMLElement {
  const field = el('input', { type: 'text', placeholder: '例如 日常浏览', 'aria-label': '口令名称', maxlength: '80', autocomplete: 'off' })
  const make = el('button', { type: 'submit', class: 'small' }, '添加口令')
  const form = el('form', { class: 'actions token-add', 'aria-label': '添加插件口令' }, field, make)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const label = field.value.trim()
    if (label === '') { toast('先填写口令名称'); field.focus(); return }
    if (make.disabled) return
    make.disabled = true
    void act((requestId) => api.createMachineToken({ machineToken: { label }, requestId }), '已添加上传口令', (answer) => {
      if (answer.token === '') toast('没有收到新口令：请停用这条口令后重新添加')
      repaint([...tokens, answer], answer.token === '' ? null : { name: answer.name, token: answer.token })
    }).finally(() => { make.disabled = false })
  })
  return form
}
