/** A page's capture history. Lists carry metadata; only the selected capture loads content. */
import type { Document, Page } from '@ziyixi/proto/recall/ui/v1/page_pb'
import { api, errorMessage } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { card, errorLine, keys, skeleton } from '../components.ts'
import { button, el, fill, typing } from '../dom.ts'
import { clock, dateText, ms } from '../format.ts'
import { marked } from '../marks.ts'

export const DOCUMENTS_PAGE = 20

const CONTENT_ERRORS: Readonly<Record<string, string>> = {
  archive_not_connected: '内容已归档，请在设置中连接 Dropbox 后重试。',
  archive_other_target: '这份内容在原来的 Dropbox 应用或账户中，请连接原归档后重试。',
  archive_missing: 'Dropbox 归档中找不到这份内容，请检查归档文件是否被移动或删除。',
  archive_corrupt: 'Dropbox 归档文件校验失败，暂时无法显示。',
  dropbox_permission: 'Dropbox 未允许读取归档，请在设置中重新连接并授权。',
  dropbox_refused: 'Dropbox 拒绝读取归档，请在设置中重新连接。',
  dropbox_token: 'Dropbox 授权已失效，请在设置中重新连接。',
  dropbox_rate_limited: 'Dropbox 请求暂时过多，请稍后重试。',
  dropbox_unavailable: 'Dropbox 暂时不可用，请稍后重试。',
  blob_missing: '云端找不到这份内容，请稍后重试。',
  blob_corrupt: '云端文件校验失败，暂时无法显示。',
  r2_unavailable: '云端存储暂时不可用，请稍后重试。',
}

function captureLabel(document: Document, now: number): string {
  const time = ms(document.captureTime)
  return [time === null ? '采集时间未知' : `${dateText(time, now)} ${clock(time)}`, document.deviceLabel].filter(Boolean).join(' · ')
}

export async function snapshotsCard(ctx: ViewContext, page: Page, first: readonly Document[], firstToken: string, words: readonly string[], now: number): Promise<HTMLElement> {
  if (first.length === 0) return card('历史快照', '', el('p', { class: 'hint' }, '还没有保存这个页面的正文或截图。'))
  const list = el('ul', { class: 'snapshots', 'aria-label': '历史快照' })
  const more = el('div', { class: 'actions' })
  const content = el('div', { class: 'snapshot-content', 'aria-live': 'polite' })
  const box = el('div', { class: 'stack' }, card('历史快照', `${String(page.documentCount)} 次`, list, more), content)
  let selected = ''
  let selection = 0
  let left = false
  let cleanupReader = () => undefined as void
  ctx.onLeave(() => {
    left = true
    cleanupReader()
  })

  const choose = async (name: string) => {
    selected = name
    const mine = ++selection
    cleanupReader()
    for (const item of list.querySelectorAll<HTMLButtonElement>('button')) item.setAttribute('aria-pressed', String(item.dataset.name === name))
    fill(content, skeleton(3))
    content.setAttribute('aria-busy', 'true')
    try {
      const document = await api.getDocument({ name })
      if (left || mine !== selection) return
      const rendered = documentCard(document, words, now, () => void choose(name))
      cleanupReader = rendered.cleanup
      fill(content, rendered.element)
    } catch (error) {
      if (!left && mine === selection) fill(content, errorLine(errorMessage(error), () => void choose(name)))
    } finally {
      if (mine === selection) content.removeAttribute('aria-busy')
    }
  }

  const add = (documents: readonly Document[], next: string) => {
    list.append(...documents.map((document) => el('li', {}, button(captureLabel(document, now), () => void choose(document.name), { 'data-name': document.name, 'aria-pressed': String(document.name === selected) }))))
    if (next === '') {
      fill(more)
      return
    }
    const load = button('更多快照', () => {
      load.disabled = true
      void api.listDocuments({ parent: page.name, pageSize: DOCUMENTS_PAGE, pageToken: next }).then(
        (answer) => { if (!left) add(answer.documents, answer.nextPageToken) },
        (error: unknown) => { if (!left) fill(more, errorLine(errorMessage(error), () => add([], next))) },
      )
    })
    fill(more, load)
  }
  add(first, firstToken)
  await choose(first[0]!.name)
  return box
}

function documentCard(document: Document, words: readonly string[], now: number, retry: () => void): { element: HTMLElement; cleanup: () => void } {
  const reader = el('div', { class: 'reader' }, ...document.text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean).map((paragraph) => el('p', {}, ...marked(paragraph, words))))
  const marks = [...reader.querySelectorAll('mark')]
  let find: HTMLElement | null = null
  let cleanup = () => undefined as void
  if (marks.length > 0) {
    let current = 0
    const where = el('span', { class: 'meta', 'aria-live': 'polite' })
    const show = (index: number, scroll: boolean) => {
      current = (index + marks.length) % marks.length
      marks.forEach((mark, i) => mark.classList.toggle('current', i === current))
      where.textContent = `第 ${String(current + 1)}/${String(marks.length)} 处`
      if (scroll) marks[current]?.scrollIntoView?.({ block: 'center' })
    }
    show(0, false)
    find = el('div', { class: 'find' }, where,
      button('↑', () => show(current - 1, true), { class: 'quiet icon', 'aria-label': '上一处' }),
      button('↓', () => show(current + 1, true), { class: 'quiet icon', 'aria-label': '下一处' }),
      keys([['n'], '下一处'], [['N'], '上一处']))
    const onKey = (event: KeyboardEvent) => {
      if (!reader.isConnected || event.altKey || event.ctrlKey || event.metaKey || typing(event) || (event.key !== 'n' && event.key !== 'N')) return
      event.preventDefault()
      show(current + (event.key === 'n' ? 1 : -1), true)
    }
    window.document.addEventListener('keydown', onKey)
    cleanup = () => window.document.removeEventListener('keydown', onKey)
  }
  const picture = document.screenshotWebpBase64 === '' ? null : el('img', {
    class: 'snapshot-image', src: `data:image/webp;base64,${document.screenshotWebpBase64}`, alt: '采集时的可见页面截图',
    width: String(document.screenshotWidth), height: String(document.screenshotHeight),
  })
  return {
    element: card('正文与截图', captureLabel(document, now),
      document.contentError === '' ? null : errorLine(CONTENT_ERRORS[document.contentError] ?? '这份快照的部分内容暂时无法读取，请稍后重试。', retry),
      document.textArchived ? el('p', { class: 'hint' }, '内容来源：Dropbox 归档') : null,
      find,
      document.textTruncated ? el('p', { class: 'hint' }, '正文超过 64 KB，只保存了开头') : null,
      document.searchTruncated ? el('p', { class: 'hint' }, '搜索只看正文前 32 KB') : null,
      document.text === '' ? el('p', { class: 'hint' }, document.textBytes > 0 ? '正文暂时无法读取。' : '这次快照没有保存正文。') : reader,
      picture === null ? el('p', { class: 'hint' }, document.screenshotWidth > 0 ? '截图暂时无法读取。' : '这次快照没有保存截图。') : picture,
    ),
    cleanup,
  }
}
