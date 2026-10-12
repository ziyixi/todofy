/** Named upload tokens and the existing shared/export credentials. Tokens stay only in this view's memory. */
import { create } from '@ziyixi/proto/protobuf'
import { MachineTokenSchema, type MachineToken } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { disclosure, menu } from '../components.ts'
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

/** The 插件口令 card's body: the extension's token, and the optional export token folded under it. */
export function paintTokens(ctx: ViewContext, box: HTMLElement, tokens: readonly MachineToken[], shown: { readonly name: string; readonly token: string } | null = null): void {
  const of = (route: Route) => tokens.find((item) => item.name === `machineTokens/${route}`) ?? create(MachineTokenSchema, { name: `machineTokens/${route}` })
  const repaint = (next: MachineToken, token: string | null) => {
    paintTokens(ctx, box, [...tokens.filter((item) => item.name !== next.name), next], token === null || token === '' ? null : { name: next.name, token })
  }
  const controls = (route: Route): HTMLElement[] => {
    const token = of(route)
    const words = TOKEN_WORDS[route]
    const made = ms(token.createTime)
    const regenerate = async (revokePrevious: boolean) => {
      await act(
        (requestId) => api.regenerateMachineToken({ name: token.name, revokePrevious, requestId }),
        `已生成新的${words.name}`,
        (answer) => {
          // A repeated request answers without the token (it is shown once): the owner makes another.
          if (answer.token === '') toast(`没有收到新${words.name}：请再生成一次`)
          repaint(answer, answer.token)
        },
      )
    }
    const remove = async () => {
      if (!ctx.host.confirm(words.remove)) return
      await act((requestId) => api.deleteMachineToken({ name: token.name, requestId }), `已停用${words.name}`, () => {
        repaint(create(MachineTokenSchema, { name: token.name, workerSecret: token.workerSecret }), null)
      })
    }
    const until = ms(token.previousExpireTime)
    const parts: HTMLElement[] = []
    if (made === null) {
      parts.push(el('p', { class: 'hint' }, words.none), el('div', { class: 'actions' }, button('生成', () => void regenerate(false))))
    } else {
      parts.push(
        el(
          'div',
          { class: 'row-head' },
          el('span', { class: 'row-title' }, words.name),
          el('span', { class: 'meta' }, `${ago(made, ctx.host.now())}生成`),
          menu(`${words.name}的更多操作`, [
            [
              '旧口令泄露：立即作废并重新生成',
              () => {
                if (ctx.host.confirm(words.revoke)) void regenerate(true)
              },
              'danger',
            ],
            ['停用', () => void remove(), 'danger'],
          ]),
        ),
      )
      if (until !== null) parts.push(el('p', { class: 'hint' }, `旧口令 ${span(until - ctx.host.now())}内仍可用`))
      parts.push(
        el(
          'div',
          { class: 'actions' },
          button('重新生成', () => {
            if (ctx.host.confirm(words.regenerate)) void regenerate(false)
          }),
        ),
      )
    }
    if (token.workerSecret) parts.push(el('p', { class: 'hint' }, words.secret))
    if (shown !== null && shown.name === token.name) parts.push(onceBox(shown.token, words.name))
    return parts
  }
  const named = namedTokens(ctx, tokens, shown, (next, token) => paintTokens(ctx, box, next, token))
  fill(box, named, el('section', { class: 'shared-token' }, el('h3', {}, '共享插件口令'), ...controls('ingest')), disclosure('导出口令（可选）', ...controls('export')))
  if (shown?.name === 'machineTokens/export') box.querySelector('details')?.setAttribute('open', '')
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

/** Independent upload credentials let the owner stop one device without changing the others. */
function namedTokens(
  ctx: ViewContext,
  tokens: readonly MachineToken[],
  shown: { readonly name: string; readonly token: string } | null,
  repaint: (tokens: readonly MachineToken[], shown: { readonly name: string; readonly token: string } | null) => void,
): HTMLElement {
  const own = tokens.filter((token) => !['machineTokens/ingest', 'machineTokens/export'].includes(token.name))
  const field = el('input', { type: 'text', placeholder: '例如 iPhone', 'aria-label': '口令名称', maxlength: '80', autocomplete: 'off' })
  const make = button('添加设备口令', () => {
    const label = field.value.trim()
    if (label === '') {
      toast('先填写口令名称，例如 iPhone')
      field.focus()
      return
    }
    make.disabled = true
    void act(
      (requestId) => api.createMachineToken({ machineToken: { label }, requestId }),
      '已添加设备口令',
      (answer) => {
        if (answer.token === '') toast('没有收到新口令：请停用这条口令后重新添加')
        repaint([...tokens, answer], answer.token === '' ? null : { name: answer.name, token: answer.token })
      },
    ).finally(() => { make.disabled = false })
  })
  const rows = own.map((token) => {
    const made = ms(token.createTime)
    return el('li', {},
      el('div', { class: 'row-head' },
        el('span', { class: 'row-title' }, token.label),
        el('span', { class: 'meta' }, made === null ? '生成时间未知' : `${ago(made, ctx.host.now())}生成`),
        button('停用', () => {
          if (!ctx.host.confirm(`停用“${token.label}”的上传口令？使用这个口令的设备会停止上传，已记录内容保留。`)) return
          void act((requestId) => api.deleteMachineToken({ name: token.name, requestId }), '已停用设备口令', () => repaint(tokens.filter((item) => item.name !== token.name), null))
        }, { class: 'quiet small danger', 'aria-label': `停用 ${token.label}` }),
      ),
      shown?.name === token.name ? onceBox(shown.token, `${token.label} 的口令`) : null,
    )
  })
  return el('section', { class: 'named-tokens stack' },
    el('h3', {}, '设备口令'),
    el('p', { class: 'hint' }, '每台设备可用独立口令。停用一条口令不会影响其他设备，电脑现有口令继续有效。'),
    rows.length === 0 ? null : el('ul', { class: 'rows' }, ...rows),
    el('div', { class: 'actions' }, field, make),
  )
}
