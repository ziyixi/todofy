/**
 * Adding a watch (`/new`), phone first. The URL comes from the box or from the page's fragment (`/new#u=<encoded url>`,
 * the phone's share sheet or a bookmarklet: a fragment never reaches a server). A URL from the fragment only fills the
 * box, with its host shown, and the fragment leaves the address bar and history: nothing is fetched until the owner
 * taps "预览" (a link anyone can send must not make the Worker request a URL by being opened). "预览" asks PreviewWatch
 * for every stage of the pipeline: the fetch, the health gate, and the page's blocks. Tapping a block adds its
 * selector to the include list ("只看这些") or the exclude list ("排除这些"), and the preview runs again from the Worker's
 * stored fetch, so the owner sees the normalized lines that will be compared before saving. A landmark block (a nav,
 * the page's header or footer) says that it does not count unless picked. "保存" creates the watch once the owner has
 * typed its name: the name goes into the owner's Todoist tasks, so it is never derived from the URL (a shared link's
 * host is text the owner did not write, and a name copied from the URL would put the watched site into Todoist).
 *
 * The preview area is not a live region (it is rebuilt on every tap); a short status line says what changed.
 */
import { FailureReason } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import type { PreviewBlock, PreviewWatchResponse } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { failureText, hostOf, sharedUrl, watchIdOf, when } from '../format.ts'
import { emptyDraft, settingsForm, watchOf, type Draft } from '../settings.ts'
import type { ViewContext } from '../app.ts'

/** Lines the preview shows. */
const PREVIEW_LINES = 60
/** The name a preview sends while the owner has typed none (Watch requires one; a preview saves nothing). */
const PREVIEW_NAME = '新监视'

type PreviewResult = Awaited<ReturnType<typeof api.previewWatch>>

/** The preview's summary line of the fetch. */
function fetchLine(preview: PreviewWatchResponse): string {
  const fetch = preview.fetch
  if (fetch === undefined) return ''
  const parts = [fetch.httpStatus === 0 ? '无应答' : `HTTP ${String(fetch.httpStatus)}`]
  if (fetch.mimeType !== '') parts.push(fetch.mimeType)
  if (fetch.charset !== '') parts.push(fetch.metaCharset ? `${fetch.charset}（来自 meta）` : fetch.charset)
  if (fetch.redirectCount > 0) parts.push(`跳转 ${String(fetch.redirectCount)} 次`)
  if (fetch.markdown) parts.push('网站返回了 Markdown（无法按区块选择）')
  if (fetch.cached) parts.push(`使用 ${when(fetch.fetchTime)} 的抓取，${when(fetch.nextFetchTime)} 后可重新抓取`)
  if (!fetch.robotsAllowed) parts.push('robots.txt 不允许')
  return parts.join(' · ')
}

export function renderAdd(ctx: ViewContext): Promise<void> {
  const shared = sharedUrl(window.location.hash)
  // The URL is in the form now: it leaves the address bar and the history entry.
  if (window.location.hash !== '') window.history.replaceState(null, '', '/new')
  const draft: Draft = emptyDraft(shared)
  let pickMode: 'include' | 'exclude' = 'include'
  let last: PreviewResult | null = null

  const uri = el('input', { type: 'url', inputmode: 'url', placeholder: 'https://…', 'aria-label': '网址', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off' })
  uri.value = draft.uri
  const warning = el('p', { class: 'warn', hidden: true }, 'http 网址不加密：在设置里勾选“允许 http”后才能保存。')
  const previewButton = button('预览', () => void runPreview(false), { class: 'primary' })
  const refreshButton = button('重新抓取', () => void runPreview(true), { class: 'small', hidden: true })
  const result = el('section', { class: 'preview', 'aria-label': '预览' })
  const status = el('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' })
  const sharedNote = shared === '' ? null : el('p', { class: 'hint shared' }, '分享来的网址，来自 ', el('strong', {}, hostOf(shared)), '。点“预览”才会抓取。')
  const save = button('保存', () => void doSave(), { class: 'primary', disabled: true })
  const form = settingsForm(draft, () => {
    // A change of what is read shows in the next preview; a change of the rest needs none.
    save.disabled = last === null
  })
  const pickInclude = button('只看这些', () => setMode('include'), { class: 'small', 'aria-pressed': 'true' })
  const pickExclude = button('排除这些', () => setMode('exclude'), { class: 'small', 'aria-pressed': 'false' })
  const setMode = (mode: 'include' | 'exclude') => {
    pickMode = mode
    pickInclude.setAttribute('aria-pressed', String(mode === 'include'))
    pickExclude.setAttribute('aria-pressed', String(mode === 'exclude'))
  }

  uri.addEventListener('input', () => {
    draft.uri = uri.value.trim()
    warning.hidden = !draft.uri.startsWith('http:')
  })
  warning.hidden = !draft.uri.startsWith('http:')

  const toggleBlock = (block: PreviewBlock) => {
    const list = pickMode === 'include' ? draft.include : draft.exclude
    const other = pickMode === 'include' ? draft.exclude : draft.include
    const at = list.indexOf(block.selector)
    if (at >= 0) list.splice(at, 1)
    else {
      list.push(block.selector)
      const elsewhere = other.indexOf(block.selector)
      if (elsewhere >= 0) other.splice(elsewhere, 1)
    }
    void runPreview(false)
  }

  const renderResult = (preview: PreviewResult) => {
    const failed = preview.failure !== FailureReason.UNSPECIFIED
    const blocks = preview.blocks.map((block) => {
      const included = draft.include.includes(block.selector)
      const excluded = draft.exclude.includes(block.selector)
      const classes = ['block', block.counted ? 'counted' : 'dropped', block.landmark ? 'landmark' : '', included ? 'included' : '', excluded ? 'excluded' : ''].filter((name) => name !== '')
      const node = button('', () => toggleBlock(block), { class: classes.join(' '), title: block.selector, 'aria-pressed': String(included || excluded) })
      fill(
        node,
        el('span', { class: 'tag' }, `<${block.tag}>`),
        block.landmark ? el('span', { class: 'note' }, block.counted ? '导航/页眉区，已选入' : '导航/页眉区，默认不计入') : null,
        el('span', { class: 'text' }, block.text),
      )
      return node
    })
    const selected = [...draft.include.map((selector) => `只看 ${selector}`), ...draft.exclude.map((selector) => `排除 ${selector}`)]
    fill(
      result,
      el('p', { class: 'muted' }, fetchLine(preview)),
      failed ? el('p', { class: 'warn' }, `健康检查未通过：${failureText(preview.failure, preview.fetch?.httpStatus ?? 0)}`) : null,
      preview.numberValue !== '' ? el('p', {}, `读到的数值：${preview.numberValue}`) : null,
      preview.availability !== '' ? el('p', {}, `供货状态：${preview.availability}`) : null,
      blocks.length > 0 ? el('h2', {}, '页面区块（点按选择）') : null,
      blocks.length > 0 ? el('div', { class: 'row' }, pickInclude, pickExclude) : null,
      selected.length > 0 ? el('ul', { class: 'selected' }, ...selected.map((text) => el('li', {}, text))) : null,
      blocks.length > 0 ? el('div', { class: 'blocks' }, ...blocks) : null,
      preview.items.length > 0 ? el('h2', {}, `条目（${String(preview.items.length)}）`) : null,
      preview.items.length > 0 ? el('ul', { class: 'lines' }, ...preview.items.slice(0, PREVIEW_LINES).map((item) => el('li', {}, item.text))) : null,
      el('h2', {}, `将比较的内容（${String(preview.normalizedLines.length)} 行${preview.linesTruncated ? '，已截断' : ''}）`),
      el('ul', { class: 'lines normalized' }, ...preview.normalizedLines.slice(0, PREVIEW_LINES).map((line) => el('li', {}, line))),
      preview.maskedTokenCount > 0 ? el('p', { class: 'hint' }, `已遮盖 ${String(preview.maskedTokenCount)} 处相对时间、时间戳或随机串`) : null,
    )
    status.textContent = failed
      ? `健康检查未通过：${failureText(preview.failure, preview.fetch?.httpStatus ?? 0)}`
      : `将比较 ${String(preview.normalizedLines.length)} 行，已选 ${String(draft.include.length + draft.exclude.length)} 个区块`
  }

  const runPreview = async (refresh: boolean) => {
    if (draft.uri === '') {
      toast('先输入网址')
      return
    }
    previewButton.disabled = true
    result.replaceChildren(el('p', { class: 'status' }, refresh ? '重新抓取中…（同一网址 15 分钟内只抓一次，同一网站两次抓取至少间隔 30 秒）' : '抓取中…'))
    try {
      // The preview needs a display name (a required field of Watch): a neutral one until the owner types theirs; the
      // form keeps it empty, so saving still asks for it.
      last = await api.previewWatch({ watch: watchOf({ ...draft, displayName: draft.displayName.trim() === '' ? PREVIEW_NAME : draft.displayName }), refresh })
      renderResult(last)
      refreshButton.hidden = false
      save.disabled = false
      form.sync()
    } catch (error) {
      result.replaceChildren(el('p', { class: 'warn' }, errorMessage(error)))
    } finally {
      previewButton.disabled = false
    }
  }

  const requestId = newRequestId()
  const doSave = async () => {
    if (draft.displayName.trim() === '') {
      toast('先填写名称（会出现在 Todoist 任务里，不要填网址）')
      form.element.querySelector<HTMLInputElement>('input[name="displayName"]')?.focus()
      return
    }
    save.disabled = true
    try {
      const created = await withRetry(() => api.createWatch({ watch: watchOf(draft), requestId }))
      toast('已添加（同一网址 15 分钟内不会重复抓取）')
      ctx.go(`/watches/${watchIdOf(created.name)}`)
    } catch (error) {
      toast(errorMessage(error))
      save.disabled = false
    }
  }

  ctx.main.replaceChildren(
    el('h1', {}, '添加监视'),
    el('div', { class: 'row' }, uri, previewButton),
    ...(sharedNote === null ? [] : [sharedNote]),
    warning,
    refreshButton,
    status,
    result,
    el('details', { class: 'more-settings', open: true }, el('summary', {}, '设置'), form.element),
    el('div', { class: 'actions sticky' }, save),
  )
  return Promise.resolve()
}
