/** Owner-only evidence readers. Page text and source structure are always literal text. */
import type { Change } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { api, ApiError, errorMessage } from './api.ts'
import { button, el } from './dom.ts'
import { when } from './format.ts'

type Snapshot = Awaited<ReturnType<typeof api.getSnapshot>>

/** Read only after expansion, once on success; a failed request offers an explicit retry. */
function evidenceDrawer(label: string, read: () => Promise<HTMLElement[]>): HTMLDetailsElement {
  const body = el('div', { class: 'evidence-body' })
  const drawer = el('details', { class: 'evidence' }, el('summary', {}, label), body)
  let started = false
  const load = async () => {
    if (started) return
    started = true
    body.replaceChildren(el('p', { class: 'status', role: 'status' }, '读取中…'))
    try {
      body.replaceChildren(...await read())
    } catch (error) {
      started = false
      body.replaceChildren(el('p', { class: 'status' }, errorMessage(error)), button('重试', () => void load(), { class: 'small' }))
    }
  }
  drawer.addEventListener('toggle', () => {
    if (drawer.open) void load()
  })
  return drawer
}

function unavailable(kind: string, reason: string): HTMLElement {
  const reasons: Readonly<Record<string, string>> = {
    not_recorded: `此记录未保存${kind}。`,
    expired: `${kind}已过期，无法读取。`,
    unavailable: `${kind}暂时无法读取。`,
    screenshot_failed: '截图抓取失败，未保存截图。',
    too_large: `${kind}超过保存上限，未保存。`,
  }
  return el('p', { class: 'hint' }, reasons[reason] ?? `${kind}不可用${reason === '' ? '。' : `（${reason}）。`}`)
}

function imageEvidence(snapshot: Snapshot): HTMLElement {
  if (!snapshot.imageAvailable) return unavailable('截图', snapshot.imageError)
  return evidenceDrawer('查看截图', async () => {
    const image = await api.getSnapshotImage({ name: `${snapshot.name}/image` }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    })
    if (image === null) return [unavailable('截图', 'expired')]
    if (!image.available || image.jpegBase64 === '') return [unavailable('截图', image.error)]
    const figure = el('figure', { class: 'evidence-image' })
    const captured = el('img', { src: `data:image/jpeg;base64,${image.jpegBase64}`, alt: '抓取时保存的页面截图', loading: 'lazy', decoding: 'async' })
    if (image.width > 0) captured.width = image.width
    if (image.height > 0) captured.height = image.height
    captured.addEventListener('error', () => figure.replaceChildren(el('p', { class: 'hint' }, '截图无法显示。')))
    figure.append(captured, el('figcaption', { class: 'hint' }, `${String(image.width)} × ${String(image.height)}`))
    return [figure]
  })
}

async function readSnapshot(name: string, label: string): Promise<HTMLElement> {
  const section = el('section', { class: 'snapshot', 'aria-label': label }, el('h3', {}, label))
  if (name === '') {
    section.append(el('p', { class: 'hint' }, '此记录未保存页面证据。'))
    return section
  }
  const snapshot = await api.getSnapshot({ name }).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  })
  if (snapshot === null) {
    section.append(unavailable('页面证据', 'expired'))
    return section
  }
  section.append(el('p', { class: 'hint' }, `抓取于 ${when(snapshot.createTime)}`))
  if (snapshot.title !== '') section.append(el('p', { class: 'summary' }, snapshot.title))
  if (snapshot.uri !== '') section.append(el('p', { class: 'hint evidence-uri' }, snapshot.uri))
  if (snapshot.contentTruncated) section.append(el('p', { class: 'warn' }, '页面证据已截断，只能查看保存下来的部分。'))
  if (snapshot.contentAvailable) {
    if (snapshot.contentError !== '') section.append(el('p', { class: 'warn' }, `页面提取有异常（${snapshot.contentError}），已保存的内容可能不完整。`))
    if (snapshot.markdown !== '' || snapshot.contentError === '') section.append(el('pre', { class: 'evidence-text', tabindex: '0' }, snapshot.markdown === '' ? '已保存的页面正文为空。' : snapshot.markdown))
    const source = el('details', { class: 'evidence-source' }, el('summary', {}, '页面结构、链接和元数据'))
    if (snapshot.structureJson !== '') source.append(el('pre', { class: 'evidence-text', tabindex: '0' }, snapshot.structureJson))
    if (snapshot.links.length > 0) source.append(el('h4', {}, '链接'), el('pre', { class: 'evidence-text', tabindex: '0' }, snapshot.links.map((link) => `${link.text}\n${link.url}`).join('\n\n')))
    if (snapshot.metadata.length > 0) source.append(el('h4', {}, '元数据'), el('pre', { class: 'evidence-text', tabindex: '0' }, snapshot.metadata.map((item) => `${item.name}: ${item.content}`).join('\n')))
    if (source.childElementCount > 1) section.append(source)
  } else section.append(unavailable('页面正文', snapshot.contentError))
  section.append(imageEvidence(snapshot))
  return section
}

/** The current capture of one watch, read without refetching the watched page. */
export function currentEvidence(name: string): HTMLDetailsElement {
  return evidenceDrawer('最近抓取的页面', async () => [await readSnapshot(name, '页面证据')])
}

/** A change's full before/after source, requested only when its card is expanded. */
export function changeEvidence(change: Change): HTMLDetailsElement {
  return evidenceDrawer('查看变化前后的页面', async () => {
    const detail = await api.getChange({ name: change.name })
    const sides = await Promise.all([readSnapshot(detail.beforeSnapshot, '变化前'), readSnapshot(detail.afterSnapshot, '变化后')])
    if (detail.beforeSnapshot === '' && detail.afterSnapshot === '' && detail.contextAvailable) {
      sides.push(el(
        'section',
        { class: 'snapshot' },
        el('h3', {}, '保存的变化上下文'),
        detail.contextTruncated ? el('p', { class: 'warn' }, '上下文已截断。') : null,
        el('h4', {}, '变化前'),
        el('pre', { class: 'evidence-text', tabindex: '0' }, detail.beforeContext.join('\n')),
        el('h4', {}, '变化后'),
        el('pre', { class: 'evidence-text', tabindex: '0' }, detail.afterContext.join('\n')),
      ))
    }
    return sides
  })
}
