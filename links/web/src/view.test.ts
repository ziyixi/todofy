import { Link_Visibility } from '@ziyixi/proto/links/ui/v1/link_pb'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { vi } from 'vitest'
import { FakeServer, link, NOW } from './test/fakeServer.ts'
import { mountLauncher, type Host } from './view.ts'

interface Page {
  readonly root: HTMLElement
  readonly host: Host & { readonly visited: string[]; readonly copied: string[]; readonly downloads: { name: string; text: string }[] }
}

async function mount(server: FakeServer, path = '/_/'): Promise<Page> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  const visited: string[] = []
  const copied: string[] = []
  const downloads: { name: string; text: string }[] = []
  const host = {
    now: () => NOW,
    navigate: (target: string) => visited.push(target),
    copy: (text: string) => {
      copied.push(text)
      return Promise.resolve()
    },
    download: (name: string, text: string) => downloads.push({ name, text }),
    visited,
    copied,
    downloads,
  }
  await mountLauncher(root, host)
  return { root, host }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await settle()
  expect(check(), document.body.textContent).toBe(true)
}

function search(root: HTMLElement): HTMLInputElement {
  return root.querySelector<HTMLInputElement>('#q') as HTMLInputElement
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('input'))
}

function press(input: HTMLElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

const keys = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.row[data-key]')].map((row) => row.dataset['key'])

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label)
  if (found === undefined) throw new Error(`no button ${label}`)
  return found
}

function row(root: HTMLElement, key: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.row[data-key="${key}"]`) as HTMLElement
}

function fill(root: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)
    if (input === null) throw new Error(`no input ${name}`)
    input.value = value
  }
}

function submit(root: HTMLElement): void {
  root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
}

const toast = (root: HTMLElement) => root.parentElement?.querySelector('.toast')?.textContent ?? root.querySelector('.toast')?.textContent ?? ''

describe('the launcher', () => {
  it('lists every link, filters as you type, and opens the best match with the typed path', async () => {
    const server = new FakeServer([link('gh', { description: 'Code' }), link('mail'), link('ghost', { visibility: Link_Visibility.PUBLIC })])
    server.pageSize = 2
    const { root, host } = await mount(server)
    expect(keys(root)).toEqual(['gh', 'ghost', 'mail'])
    expect(server.calls.filter((call) => call.path.startsWith('/_/api/v1/links?'))).toHaveLength(2)
    expect(row(root, 'ghost').textContent).toContain('公开')
    expect(row(root, 'gh').textContent).toContain('私有')
    type(search(root), 'gh ziyixi/todofy')
    expect(keys(root)).toEqual(['gh', 'ghost'])
    expect(row(root, 'gh').querySelector('a')?.getAttribute('href')).toBe('/gh/ziyixi/todofy')
    press(search(root), 'Enter')
    expect(host.visited).toEqual(['/gh/ziyixi/todofy'])
    press(search(root), 'ArrowDown')
    press(search(root), 'Enter')
    expect(host.visited.at(-1)).toBe('/ghost')
  })

  it('copies a link and shows what it copied', async () => {
    const { root, host } = await mount(new FakeServer([link('gh')]))
    button(row(root, 'gh'), '复制').click()
    await until(() => host.copied.length === 1)
    expect(host.copied).toEqual([`${window.location.origin}/gh`])
  })

  it('creates a link from the search box, with CSRF and a request ID, and undoes it', async () => {
    const server = new FakeServer([link('gh')])
    const { root } = await mount(server)
    type(search(root), 'New')
    button(root, '新建 s/new').click()
    expect(root.querySelector<HTMLInputElement>('[name="key"]')?.value).toBe('new')
    fill(root, { target: 'https://new.example.com/', visibility: 'public', tags: 'a, b' })
    submit(root)
    await until(() => keys(root).includes('new'))
    const [call] = server.mutations('/_/api/v1/links')
    expect(call?.headers['x-csrf-token']).toBe('synthetic-token')
    expect(call?.path).toMatch(/link_id=new&request_id=[0-9a-f-]{36}$/)
    expect(call?.body).toEqual({ target: 'https://new.example.com/', path_mode: 'exact', visibility: 'public', tags: ['a', 'b'] })
    expect(document.querySelector('.toast')?.textContent).toContain('已创建 s/new')
    button(document, '撤销').click()
    await until(() => !keys(root).includes('new'))
    expect(server.links.get('new')?.deleteTime).toBeDefined()
  })

  it('edits with the etag, undoes the edit with a rollback, and shows a conflict', async () => {
    const server = new FakeServer([link('gh', { description: 'old' })])
    const { root } = await mount(server)
    button(row(root, 'gh'), '编辑').click()
    fill(root, { description: 'new' })
    submit(root)
    await until(() => row(root, 'gh').textContent.includes('new'))
    const [update] = server.mutations('/_/api/v1/links/gh')
    expect(update?.method).toBe('PATCH')
    expect(update?.body).toMatchObject({ etag: 'etag-gh-1', description: 'new' })
    button(document, '撤销').click()
    await until(() => row(root, 'gh').textContent.includes('old'))
    expect(server.mutations(':rollback')[0]?.body).toMatchObject({ revision_id: '1' })
    // Someone else changed it: the form reloads the current link and says so.
    button(row(root, 'gh'), '编辑').click()
    server.links.set('gh', link('gh', { description: 'elsewhere', etag: 'etag-other', revisionId: '9' }))
    fill(root, { description: 'mine' })
    submit(root)
    await until(() => root.querySelector('.error')?.textContent.includes('已在别处修改') === true)
    expect(root.querySelector<HTMLInputElement>('[name="description"]')?.value).toBe('elsewhere')
  })

  it('deletes and restores through the toast, and lists deleted links on request', async () => {
    const server = new FakeServer([link('gh'), link('mail')])
    const { root } = await mount(server)
    button(row(root, 'gh'), '删除').click()
    await until(() => !keys(root).includes('gh'))
    button(document, '撤销').click()
    await until(() => keys(root).includes('gh'))
    expect(server.mutations(':undelete')).toHaveLength(1)
    button(row(root, 'gh'), '删除').click()
    await until(() => !keys(root).includes('gh'))
    const toggle = root.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await until(() => keys(root).includes('gh'))
    expect(row(root, 'gh').textContent).toContain('已删除')
    button(row(root, 'gh'), '恢复').click()
    await until(() => !row(root, 'gh').textContent.includes('已删除'))
  })

  it('offers to restore a deleted key instead of creating it', async () => {
    const server = new FakeServer([link('gh', { deleteTime: timestampFromMs(NOW) })])
    const { root } = await mount(server)
    button(root, '新建').click()
    fill(root, { key: 'gh', target: 'https://other.example.com/' })
    submit(root)
    await until(() => root.querySelector('.error')?.textContent.includes('已删除') === true)
    button(root.querySelector('.error') as HTMLElement, '恢复它').click()
    await until(() => root.querySelector('h2')?.textContent === '编辑 s/gh')
    expect(server.links.get('gh')?.deleteTime).toBeUndefined()
  })

  it('refuses tags and keys the Worker would refuse, before sending', async () => {
    const server = new FakeServer()
    const { root } = await mount(server)
    button(root, '新建').click()
    fill(root, { key: 'api', target: 'https://a.example.com/' })
    submit(root)
    expect(root.querySelector('.error')?.textContent).toContain('保留名')
    fill(root, { key: 'ok', tags: 'bad_tag' })
    submit(root)
    expect(root.querySelector('.error')?.textContent).toContain('标签')
    expect(server.mutations()).toEqual([])
  })
})

describe('/_/k/<key>', () => {
  it('opens the form to create a key that does not exist', async () => {
    const { root } = await mount(new FakeServer(), '/_/k/Fresh/some/path')
    await until(() => root.querySelector('form') !== null)
    expect(root.querySelector<HTMLInputElement>('[name="key"]')?.value).toBe('fresh')
    expect(root.querySelector('.error')?.textContent).toContain('还不存在')
    expect(window.location.pathname).toBe('/_/')
  })

  it('opens an expired link for editing', async () => {
    const { root } = await mount(new FakeServer([link('old', { expireTime: timestampFromMs(NOW - 1) })]), '/_/k/old')
    await until(() => root.querySelector('h2')?.textContent === '编辑 s/old')
    expect(root.querySelector('.error')?.textContent).toContain('已过期')
  })

  it('offers to restore a deleted link', async () => {
    const { root } = await mount(new FakeServer([link('gone', { deleteTime: timestampFromMs(NOW) })]), '/_/k/gone+')
    await until(() => root.querySelector('.error')?.textContent.includes('已删除') === true)
  })
})

describe('import and export', () => {
  it('exports every page as one JSON Lines file', async () => {
    const server = new FakeServer([link('a'), link('b'), link('c', { deleteTime: timestampFromMs(NOW) })])
    server.exportPageSize = 1
    const { root, host } = await mount(server)
    button(root, '导出').click()
    await until(() => host.downloads.length === 1)
    expect(host.downloads[0]?.name).toBe('links-2026-10-01.jsonl')
    expect(host.downloads[0]?.text.trimEnd().split('\n').map((line) => (JSON.parse(line) as { name: string }).name)).toEqual(['links/a', 'links/b'])
  })

  it('imports a large file in parts and names the skipped lines of the file', async () => {
    const server = new FakeServer([link('k5')])
    const { root } = await mount(server)
    const lines = Array.from({ length: 150 }, (_, n) => JSON.stringify({ name: `links/k${String(n)}`, target: `https://k${String(n)}.example.com/` }))
    lines.splice(120, 0, 'not json')
    const input = root.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File([lines.join('\n')], 'links.jsonl')], configurable: true })
    input.dispatchEvent(new Event('change'))
    await until(() => (document.querySelector('.toast')?.textContent ?? '').includes('已导入'))
    expect(server.mutations(':import')).toHaveLength(2)
    expect(document.querySelector('.toast')?.textContent).toBe('已导入 149 个，跳过 2 行（第 6、121 行）')
    expect(keys(root)).toHaveLength(150)
  })
})

describe('failures', () => {
  it('shows a load failure instead of an empty list', async () => {
    const server = new FakeServer()
    server.install()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    const root = document.createElement('div')
    document.body.append(root)
    await mountLauncher(root, { now: () => NOW, navigate: () => undefined, copy: () => Promise.resolve(), download: () => undefined })
    expect(root.querySelector('.status')?.textContent).toContain('网络异常')
    expect(toast(root)).toBe('')
  })
})
