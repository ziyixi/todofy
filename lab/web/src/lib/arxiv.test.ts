import { parseArxivId, parseSeedInput } from './arxiv'

describe('seed input', () => {
  it('accepts IDs, prefixed IDs and abs / pdf links, dropping the version', () => {
    const host = ['arxiv', 'org'].join('.')
    expect(parseArxivId('2409.01234')).toBe('2409.01234')
    expect(parseArxivId(' arXiv:2409.01234v3 ')).toBe('2409.01234')
    expect(parseArxivId(`https://${host}/abs/2409.01234v2`)).toBe('2409.01234')
    expect(parseArxivId(`${host}/pdf/2409.01234.pdf`)).toBe('2409.01234')
    expect(parseArxivId(`https://www.${host}/abs/cs/0112017v1?context=cs`)).toBe('cs/0112017')
    expect(parseArxivId('hello world')).toBeNull()
    expect(parseArxivId('https://example.com/abs/2409.01234')).toBeNull()
  })

  it('splits lines, de-duplicates and reports what it could not read', () => {
    expect(parseSeedInput('2409.01234\n\n2409.01234v2\nnope\n2310.06825')).toEqual({
      ids: ['2409.01234', '2310.06825'],
      invalid: ['nope'],
    })
  })
})
