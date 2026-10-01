import { create } from '@ziyixi/proto/protobuf'
import { timestampDate, timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Link_PathMode, Link_Visibility, LinkSchema } from '@ziyixi/proto/links/ui/v1/link_pb'
import { IMPORT_CHARS_MAX, IMPORT_LINES_MAX } from '../../worker/src/limits.ts'
import { dateInput, expireOf, exportName, formValues, importChunks, isExpired, isNewKey, keyOf, linkFields, parseQuery, parseTags, rank, shortPath } from './launcher.ts'

const link = (key: string, extra: Record<string, unknown> = {}) => create(LinkSchema, { name: `links/${key}`, target: `https://${key}.example/`, ...extra })

describe('the search box', () => {
  it('reads the key first and the rest of the line as a path', () => {
    expect(parseQuery('  GH ziyixi/todofy ')).toEqual({ key: 'gh', rest: 'ziyixi/todofy' })
    expect(parseQuery('gh/ziyixi')).toEqual({ key: 'gh', rest: 'ziyixi' })
    expect(parseQuery('gh')).toEqual({ key: 'gh', rest: '' })
    expect(parseQuery('')).toEqual({ key: '', rest: '' })
  })

  it('ranks the exact key, then prefixes, then substrings, then other fields', () => {
    const links = [link('docs-gh'), link('gh'), link('ghost'), link('mail', { description: 'GH notifications' }), link('x', { tags: ['gh'] }), link('other')]
    expect(rank(links, 'gh').map(keyOf)).toEqual(['gh', 'ghost', 'docs-gh', 'mail', 'x'])
    expect(rank(links, '').map(keyOf)).toEqual(['docs-gh', 'gh', 'ghost', 'mail', 'other', 'x'])
    expect(rank(links, 'gh some/path').map(keyOf)[0]).toBe('gh')
  })

  it('builds the short path with each segment encoded', () => {
    expect(shortPath('gh')).toBe('/gh')
    expect(shortPath('gh', 'a b/c?d')).toBe('/gh/a%20b/c%3Fd')
  })

  it('knows which keys can be created', () => {
    expect(isNewKey('Hello-1')).toBe(true)
    for (const key of ['', '-a', 'a_b', 'api', 'S', 'x'.repeat(64)]) expect(isNewKey(key), key).toBe(false)
  })
})

describe('the form', () => {
  it('maps a link to the inputs and back', () => {
    const original = link('gh', { pathMode: Link_PathMode.APPEND, visibility: Link_Visibility.PUBLIC, description: 'Code', tags: ['dev', 'git'], expireTime: expireOf('2026-12-31') })
    const values = formValues(original)
    expect(values).toEqual({ key: 'gh', target: 'https://gh.example/', mode: 'append', visibility: 'public', description: 'Code', tags: 'dev, git', expire: '2026-12-31' })
    expect(linkFields(values)).toMatchObject({ target: 'https://gh.example/', pathMode: Link_PathMode.APPEND, visibility: Link_Visibility.PUBLIC, tags: ['dev', 'git'] })
    expect(formValues(null, 'new')).toMatchObject({ key: 'new', mode: 'exact', visibility: 'private', expire: '' })
  })

  it('reads the last valid day in the browser zone: the link stops at the next local midnight', () => {
    const expire = expireOf('2026-10-01')
    expect(expire).toBeDefined()
    // Asia/Shanghai is UTC+8: midnight of 2 October there is 16:00 UTC on 1 October.
    expect(timestampDate(expire ?? timestampFromMs(0)).toISOString()).toBe('2026-10-01T16:00:00.000Z')
    expect(dateInput(expire ?? timestampFromMs(0))).toBe('2026-10-01')
    expect(expireOf('')).toBeUndefined()
    expect(isExpired(link('a', { expireTime: timestampFromMs(1000) }), 1000)).toBe(true)
    expect(isExpired(link('a', { expireTime: timestampFromMs(1001) }), 1000)).toBe(false)
  })

  it('takes tags separated by commas or spaces and refuses bad ones', () => {
    expect(parseTags('Dev, git  home，work')).toEqual(['dev', 'git', 'home', 'work'])
    expect(parseTags('')).toEqual([])
    expect(parseTags('a a')).toBeNull()
    expect(parseTags('bad_tag')).toBeNull()
    expect(parseTags('a b c d e f g h i')).toBeNull()
  })
})

describe('import and export', () => {
  it('cuts a file into requests the API accepts and maps line numbers back', () => {
    const lines = Array.from({ length: 250 }, (_, n) => `{"n":${String(n)}}`)
    const text = ['', ...lines.slice(0, 120), '', '   ', ...lines.slice(120)].join('\r\n')
    const chunks = importChunks(text)
    expect(chunks.map((chunk) => chunk.lines.length)).toEqual([IMPORT_LINES_MAX, IMPORT_LINES_MAX, 50])
    expect(chunks[0]?.lines[0]).toBe(2)
    expect(chunks[1]?.lines.slice(19, 21)).toEqual([121, 124])
    expect(chunks.every((chunk) => !chunk.content.includes('\r') && chunk.content.split('\n').every((line) => line.trim() !== ''))).toBe(true)
    const long = Array.from({ length: 3 }, () => 'x'.repeat(IMPORT_CHARS_MAX / 2)).join('\n')
    expect(importChunks(long).map((chunk) => chunk.lines)).toEqual([[1], [2], [3]])
    expect(importChunks('\n \n')).toEqual([])
  })

  it('names an export by the local date', () => {
    expect(exportName(new Date('2026-09-30T20:00:00Z'))).toBe('links-2026-10-01.jsonl')
  })
})
