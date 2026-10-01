/**
 * The launcher page (../../docs/design.md §10): one screen, mobile first. A search box that filters as you type and
 * opens the best match on Enter (with a typed path passed through), the list with copy, edit, delete and restore, an
 * edit form, a toast with 撤销 after every change, and import and export as JSON Lines. /_/k/<key> (where a short
 * link sends the owner for a key that does not resolve) opens the form for that key.
 *
 * Plain DOM, no framework: text is only ever set as text (never HTML), and the page talks only to its own API
 * (api.ts). Undo is the API's own: a create is undone by DeleteLink, an edit by RollbackLink to the revision before,
 * a delete by UndeleteLink.
 */
import { Link_Visibility, type Link } from '@ziyixi/proto/links/ui/v1/link_pb'
import { api, ApiError, errorMessage, listAll, newRequestId, withRetry } from './api.ts'
import {
  asciiLower,
  exportName,
  formValues,
  importChunks,
  isDeleted,
  isExpired,
  isNewKey,
  keyOf,
  linkFields,
  parseQuery,
  rank,
  shortPath,
  type FormValues,
  type LinkFields,
} from './launcher.ts'

/** The most rows the list renders at once; the search box narrows the rest. */
export const ROWS_SHOWN = 200
/** How long a toast stays. */
export const TOAST_MS = 8000

/** What the page needs from the browser, replaceable in tests. */
export interface Host {
  readonly now: () => number
  readonly navigate: (path: string) => void
  readonly copy: (text: string) => Promise<void>
  readonly download: (name: string, text: string) => void
}

const browserHost: Host = {
  now: () => Date.now(),
  navigate: (path) => window.location.assign(path),
  copy: (text) => navigator.clipboard.writeText(text),
  download: (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
    const anchor = el('a', { href: url, download: name })
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  },
}

/** A file's text (UTF-8), through FileReader: every browser has it, and so does the test DOM. */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : ''))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')))
    reader.readAsText(file)
  })
}

type Attributes = Readonly<Record<string, string | boolean>>

/** An element with attributes and children; strings become text nodes. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue
    node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) if (child !== null) node.append(child)
  return node
}

interface FormState {
  readonly mode: 'create' | 'edit'
  readonly link: Link | null
  readonly values: FormValues
  readonly note: string
}

/** Mounts the launcher into `root`; resolves once the first list has loaded (or failed). */
export function mountLauncher(root: HTMLElement, host: Host = browserHost): Promise<void> {
  let links: Link[] = []
  let showDeleted = false
  let selected = 0
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const search = el('input', {
    type: 'search',
    id: 'q',
    placeholder: '搜索，或输入短链接名后回车',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    enterkeyhint: 'go',
    'aria-label': '搜索短链接',
  })
  const createButton = el('button', { type: 'button', class: 'primary' }, '新建')
  const status = el('p', { class: 'status', role: 'status' })
  const formBox = el('section', { class: 'form', hidden: true, 'aria-label': '编辑短链接' })
  const list = el('ul', { class: 'list', 'aria-label': '短链接' })
  const more = el('p', { class: 'more' })
  const deletedToggle = el('input', { type: 'checkbox' })
  const exportButton = el('button', { type: 'button' }, '导出')
  const importInput = el('input', { type: 'file', accept: '.jsonl,.json,.txt,application/json', class: 'visually-hidden' })
  const toast = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })

  root.replaceChildren(
    el('header', { class: 'bar' }, el('span', { class: 'brand', 'aria-hidden': 'true' }, 's/'), search, createButton),
    el('main', {}, status, formBox, list, more),
    el(
      'footer',
      { class: 'footer' },
      el('label', {}, deletedToggle, ' 显示已删除'),
      exportButton,
      el('label', { class: 'button' }, '导入', importInput),
    ),
    toast,
  )

  // ---- state helpers ---------------------------------------------------------------------------------------------

  function upsert(link: Link): void {
    const key = keyOf(link)
    const others = links.filter((item) => keyOf(item) !== key)
    links = isDeleted(link) && !showDeleted ? others : [...others, link]
  }

  function showToast(message: string, undo?: () => Promise<void>): void {
    clearTimeout(toastTimer)
    const children: (Node | string)[] = [el('span', {}, message)]
    if (undo !== undefined) {
      const button = el('button', { type: 'button' }, '撤销')
      button.addEventListener('click', () => {
        hideToast()
        undo().catch((error: unknown) => showToast(errorMessage(error)))
      })
      children.push(button)
    }
    toast.replaceChildren(...children)
    toast.hidden = false
    toastTimer = setTimeout(hideToast, TOAST_MS)
  }

  function hideToast(): void {
    clearTimeout(toastTimer)
    toast.hidden = true
    toast.replaceChildren()
  }

  const url = (key: string) => `${window.location.origin}/${key}`

  // ---- the list ------------------------------------------------------------------------------------------------------

  function results(): Link[] {
    return rank(links, search.value)
  }

  function render(): void {
    const found = results()
    selected = Math.min(selected, Math.max(0, found.length - 1))
    const query = parseQuery(search.value)
    const rows: HTMLElement[] = []
    if (query.key !== '' && isNewKey(query.key) && !links.some((link) => keyOf(link) === query.key)) {
      const offer = el('button', { type: 'button', class: 'offer' }, `新建 s/${query.key}`)
      offer.addEventListener('click', () => openForm('create', null, query.key))
      rows.push(el('li', { class: 'row create' }, offer))
    }
    found.slice(0, ROWS_SHOWN).forEach((link, index) => rows.push(row(link, index === selected, query)))
    list.replaceChildren(...rows)
    more.textContent = found.length > ROWS_SHOWN ? `还有 ${found.length - ROWS_SHOWN} 个，输入以筛选` : ''
    if (found.length === 0 && rows.length === 0) more.textContent = links.length === 0 ? '还没有短链接' : '没有匹配的短链接'
  }

  function row(link: Link, isSelected: boolean, query: { key: string; rest: string }): HTMLElement {
    const key = keyOf(link)
    const now = host.now()
    const isPublic = link.visibility === Link_Visibility.PUBLIC
    const badges = el('span', { class: 'badges' }, el('span', { class: isPublic ? 'badge public' : 'badge' }, isPublic ? '公开' : '私有'))
    if (isExpired(link, now)) badges.append(el('span', { class: 'badge warn' }, '已过期'))
    if (isDeleted(link)) badges.append(el('span', { class: 'badge warn' }, '已删除'))
    const href = shortPath(key, key === query.key ? query.rest : '')
    const open = el(
      'a',
      { class: 'open', href },
      el('span', { class: 'line' }, el('span', { class: 'key' }, key), badges),
      link.description === '' ? null : el('span', { class: 'desc' }, link.description),
      el('span', { class: 'target' }, link.target),
    )
    const actions = el('div', { class: 'actions' })
    const action = (label: string, run: () => Promise<void> | void) => {
      const button = el('button', { type: 'button' }, label)
      button.addEventListener('click', () => {
        Promise.resolve(run()).catch((error: unknown) => showToast(errorMessage(error)))
      })
      actions.append(button)
    }
    if (isDeleted(link)) {
      action('恢复', () => restore(link))
    } else {
      action('复制', () => copy(key))
      action('编辑', () => openForm('edit', link))
      action('删除', () => remove(link))
    }
    return el('li', { class: isSelected ? 'row selected' : 'row', 'data-key': key }, open, actions)
  }

  async function load(): Promise<void> {
    status.textContent = '载入中…'
    try {
      links = await listAll(showDeleted)
      status.textContent = ''
    } catch (error) {
      status.textContent = errorMessage(error)
    }
    render()
  }

  // ---- actions --------------------------------------------------------------------------------------------------------

  async function copy(key: string): Promise<void> {
    try {
      await host.copy(url(key))
      showToast(`已复制 ${url(key)}`)
    } catch {
      showToast(url(key))
    }
  }

  async function remove(link: Link): Promise<void> {
    const requestId = newRequestId()
    const deleted = await withRetry(() => api.deleteLink({ name: link.name, etag: link.etag, requestId }))
    upsert(deleted)
    render()
    showToast(`已删除 s/${keyOf(link)}（30 天内可恢复）`, () => restore(deleted, true))
  }

  async function restore(link: Link, quiet = false): Promise<void> {
    const requestId = newRequestId()
    const restored = await withRetry(() => api.undeleteLink({ name: link.name, etag: link.etag, requestId }))
    upsert(restored)
    render()
    if (!quiet) showToast(`已恢复 s/${keyOf(link)}`)
  }

  // ---- the form ------------------------------------------------------------------------------------------------------

  let form: FormState | null = null

  function openForm(mode: 'create' | 'edit', link: Link | null, key = '', note = ''): void {
    form = { mode, link, values: formValues(link, key), note }
    renderForm()
    const first = formBox.querySelector<HTMLInputElement>(mode === 'create' && key === '' ? 'input[name="key"]' : 'input[name="target"]')
    first?.focus()
  }

  function closeForm(): void {
    form = null
    formBox.hidden = true
    formBox.replaceChildren()
  }

  function field(label: string, input: HTMLElement, hint = ''): HTMLElement {
    return el('label', { class: 'field' }, el('span', {}, label), input, hint === '' ? null : el('small', {}, hint))
  }

  function select(name: string, value: string, options: readonly [string, string][]): HTMLSelectElement {
    const node = el('select', { name })
    for (const [optionValue, label] of options) node.append(el('option', { value: optionValue, selected: optionValue === value }, label))
    return node
  }

  function renderForm(): void {
    if (form === null) return closeForm()
    const { mode, values, link, note } = form
    const keyInput = el('input', { name: 'key', value: values.key, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', readonly: mode === 'edit' })
    const error = el('p', { class: 'error', role: 'alert' }, note)
    const save = el('button', { type: 'submit', class: 'primary' }, '保存')
    const cancel = el('button', { type: 'button' }, '取消')
    cancel.addEventListener('click', closeForm)
    const node = el(
      'form',
      { novalidate: true },
      el('h2', {}, mode === 'create' ? '新建短链接' : `编辑 s/${keyOf(link as Link)}`),
      field('短链接名', keyInput, '小写字母、数字和连字符'),
      field('目标网址', el('input', { name: 'target', value: values.target, inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'https://' })),
      field('路径', select('mode', values.mode, [['exact', '精确：不带路径'], ['append', '追加：s/名字/路径 接在目标后'], ['template', '模板：替换目标中的 {path}']])),
      field('可见性', select('visibility', values.visibility, [['private', '私有：仅自己可用'], ['public', '公开：任何人可用']])),
      field('描述', el('input', { name: 'description', value: values.description, maxlength: '500' })),
      field('标签', el('input', { name: 'tags', value: values.tags, autocapitalize: 'none', spellcheck: 'false' }), '用逗号或空格分隔'),
      field('最后有效日期', el('input', { name: 'expire', type: 'date', value: values.expire }), '留空则永不过期'),
      error,
      el('div', { class: 'buttons' }, save, cancel),
    )
    node.addEventListener('submit', (event) => {
      event.preventDefault()
      void submit(node, error, save)
    })
    formBox.replaceChildren(node)
    formBox.hidden = false
  }

  function readForm(node: HTMLFormElement): FormValues {
    const value = (name: string) => (node.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? ''
    return {
      key: asciiLower(value('key').trim()),
      target: value('target'),
      mode: value('mode') as FormValues['mode'],
      visibility: value('visibility') as FormValues['visibility'],
      description: value('description'),
      tags: value('tags'),
      expire: value('expire'),
    }
  }

  async function submit(node: HTMLFormElement, error: HTMLElement, save: HTMLButtonElement): Promise<void> {
    if (form === null) return
    const values = readForm(node)
    const fields = linkFields(values)
    error.replaceChildren()
    if (fields === null) return void error.append('标签只能用小写字母、数字和连字符，最多 8 个')
    if (form.mode === 'create' && !isNewKey(values.key)) return void error.append('短链接名只能用小写字母、数字和连字符（不能以连字符开头），且不能是保留名')
    save.disabled = true
    try {
      if (form.mode === 'create') await create(values.key, fields)
      else await update(form.link as Link, fields)
    } catch (thrown) {
      handleFormError(thrown, values, error)
    } finally {
      save.disabled = false
    }
  }

  async function create(key: string, fields: LinkFields): Promise<void> {
    const requestId = newRequestId()
    const created = await withRetry(() => api.createLink({ link: fields, linkId: key, requestId }))
    upsert(created)
    closeForm()
    search.value = ''
    render()
    showToast(`已创建 s/${key}`, async () => {
      const undoId = newRequestId()
      upsert(await withRetry(() => api.deleteLink({ name: created.name, etag: created.etag, requestId: undoId })))
      render()
    })
  }

  async function update(link: Link, fields: LinkFields): Promise<void> {
    const requestId = newRequestId()
    const updated = await withRetry(() => api.updateLink({ link: { ...fields, name: link.name, etag: link.etag }, requestId }))
    upsert(updated)
    closeForm()
    render()
    if (updated.revisionId === link.revisionId) return showToast('没有改动')
    showToast(`已保存 s/${keyOf(link)}`, async () => {
      const undoId = newRequestId()
      try {
        // With the etag of this edit: a change made since (another tab, the phone) is never reverted silently.
        upsert(await withRetry(() => api.rollbackLink({ name: link.name, revisionId: link.revisionId, etag: updated.etag, requestId: undoId })))
      } catch (error) {
        if (error instanceof ApiError && error.reason === 'ETAG_MISMATCH' && error.link !== null) upsert(error.link)
        throw error
      } finally {
        render()
      }
    })
  }

  function handleFormError(thrown: unknown, values: FormValues, error: HTMLElement): void {
    if (!(thrown instanceof ApiError)) return void error.append(errorMessage(thrown))
    const current = thrown.link
    if (thrown.reason === 'LINK_EXISTS' && current !== null && isDeleted(current)) {
      const restoreButton = el('button', { type: 'button' }, '恢复它')
      restoreButton.addEventListener('click', () => {
        restore(current, true)
          .then(() => openForm('edit', links.find((item) => keyOf(item) === keyOf(current)) ?? current, '', '已恢复，可以修改后保存'))
          .catch((failure: unknown) => error.replaceChildren(errorMessage(failure)))
      })
      return void error.append(`s/${values.key} 已删除，30 天内可以恢复。`, restoreButton)
    }
    if (thrown.reason === 'ETAG_MISMATCH' && current !== null) {
      upsert(current)
      render()
      openForm('edit', current, '', thrown.message)
      return
    }
    error.append(thrown.message)
  }

  // ---- import and export -------------------------------------------------------------------------------------------------

  async function exportAll(): Promise<void> {
    const lines: string[] = []
    let pageToken = ''
    do {
      const page = await api.exportLinks({ pageToken })
      lines.push(...page.lines)
      pageToken = page.nextPageToken
    } while (pageToken !== '')
    host.download(exportName(new Date(host.now())), lines.map((line) => `${line}\n`).join(''))
    showToast(`已导出 ${lines.length} 个短链接`)
  }

  async function importFile(file: File): Promise<void> {
    const chunks = importChunks(await readText(file))
    let created = 0
    let replaced = 0
    const skipped: number[] = []
    for (const chunk of chunks) {
      const requestId = newRequestId()
      const answer = await withRetry(() => api.importLinks({ content: chunk.content, overwrite: false, requestId }))
      created += answer.createdCount
      replaced += answer.replacedCount
      for (const problem of answer.problems) skipped.push(chunk.lines[problem.lineNumber - 1] ?? 0)
    }
    await load()
    const lines = skipped.length === 0 ? '' : `，跳过 ${skipped.length} 行（第 ${skipped.slice(0, 10).join('、')}${skipped.length > 10 ? ' 等' : ''} 行）`
    showToast(`已导入 ${created} 个${replaced > 0 ? `，替换 ${replaced} 个` : ''}${lines}`)
  }

  // ---- events --------------------------------------------------------------------------------------------------------------

  function openSelected(): void {
    const query = parseQuery(search.value)
    const found = results()
    const target = found[selected]
    if (target !== undefined && !isDeleted(target)) {
      const key = keyOf(target)
      host.navigate(shortPath(key, key === query.key ? query.rest : ''))
    } else if (query.key !== '' && isNewKey(query.key)) {
      openForm('create', null, query.key)
    }
  }

  search.addEventListener('input', () => {
    selected = 0
    render()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      openSelected()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selected = Math.max(0, selected + (event.key === 'ArrowDown' ? 1 : -1))
      render()
    } else if (event.key === 'Escape') {
      search.value = ''
      render()
    }
  })
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement
    if (event.key === '/' && !typing) {
      event.preventDefault()
      search.focus()
    } else if (event.key === 'Escape' && form !== null) {
      closeForm()
    }
  })
  createButton.addEventListener('click', () => {
    const query = parseQuery(search.value)
    openForm('create', null, isNewKey(query.key) ? query.key : '')
  })
  deletedToggle.addEventListener('change', () => {
    showDeleted = deletedToggle.checked
    void load()
  })
  exportButton.addEventListener('click', () => {
    exportAll().catch((error: unknown) => showToast(errorMessage(error)))
  })
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0]
    importInput.value = ''
    if (file !== undefined) importFile(file).catch((error: unknown) => showToast(errorMessage(error)))
  })

  /** /_/k/<key>: the key a short link did not resolve; offer to create it, restore it or edit it. */
  async function continuation(): Promise<void> {
    const match = /^\/_\/k\/([^/+]+)/.exec(window.location.pathname)
    if (match === null) return
    window.history.replaceState(null, '', '/_/')
    const key = asciiLower(decodeURIComponent(match[1] ?? ''))
    if (!isNewKey(key)) {
      status.textContent = `s/${key} 不是有效的短链接名`
      return
    }
    try {
      const link = await api.getLink({ name: `links/${key}` })
      if (isDeleted(link)) {
        openForm('create', null, key)
        handleFormError(new ApiError(409, 'LINK_EXISTS', '', link), formValues(null, key), formBox.querySelector<HTMLElement>('.error') ?? status)
      } else {
        openForm('edit', link, '', isExpired(link, host.now()) ? `s/${key} 已过期：修改或清空最后有效日期后保存` : '')
      }
    } catch (error) {
      if (error instanceof ApiError && error.reason === 'NOT_FOUND') openForm('create', null, key, `s/${key} 还不存在，可以现在创建`)
      else status.textContent = errorMessage(error)
    }
  }

  search.focus()
  return load().then(continuation)
}
