/**
 * The query's words marked in a title or a text (../../docs/design.md §6.3, §8.5, §8.6), by the rule the Worker's
 * snippets follow (worker/src/search.ts: splitTerms, highlightWords, folded): spaces separate terms and double quotes
 * make a phrase one term; a term that leaves nothing searchable (punctuation only, a lone CJK character: the shared
 * segmenter's `searchable`) is dropped; each kept term's words are found ignoring case and width (NFKC character by
 * character), longest first. Marks are <mark> elements around text nodes, never HTML.
 */
import { isLoneCjk, searchable, segment, tokensOf } from '../../shared/segment.ts'
import { el } from './dom.ts'

/** The terms of a query: spaces separate them, double quotes make a phrase one term (an unclosed one runs to the end). */
export function splitTerms(query: string): string[] {
  const terms: string[] = []
  let current = ''
  let quoted = false
  for (const char of query) {
    if (char === '"') {
      if (current.trim() !== '') terms.push(current.trim())
      current = ''
      quoted = !quoted
    } else if (!quoted && /\s/u.test(char)) {
      if (current !== '') terms.push(current)
      current = ''
    } else current += char
  }
  if (current.trim() !== '') terms.push(current.trim())
  return terms
}

/** The words a query marks: each searchable term's words (a phrase's too), folded, longest first. */
export function highlightWords(query: string): string[] {
  const words = new Set<string>()
  for (const term of splitTerms(query).filter(searchable)) {
    for (const word of term.normalize('NFKC').toLowerCase().split(/\s+/u)) if (word !== '') words.add(word)
  }
  return [...words].sort((a, b) => b.length - a.length)
}

/**
 * The line that says which terms of a query were left out because each is a single Chinese, Japanese or Korean
 * character (the index holds pairs), with a way to write it (`苹果 派` → 「苹果派」); '' when none was, or when no term is
 * left (the server then says QUERY_NOT_SEARCHABLE).
 */
export function loneCharactersHint(query: string): string {
  const terms = splitTerms(query)
  if (!terms.some(searchable)) return ''
  const lone = terms.flatMap((term, index) => {
    const tokens = tokensOf(segment(term))
    return tokens.length === 1 && isLoneCjk(tokens[0] ?? '') ? [[term, index] as const] : []
  })
  const first = lone[0]
  if (first === undefined) return ''
  const [term, index] = first
  const joined = index > 0 ? `${terms[index - 1] ?? ''}${term}` : `${term}${terms[1] ?? ''}`
  const names = lone.map(([word]) => `「${word}」`).join('')
  return `${names}是单个汉字，没有参与搜索，可以连着前后的字写，如「${joined}」`
}

/** One character as the search compares it: NFKC (for non-ASCII), lower case. */
function fold(char: string): string {
  return char.charCodeAt(0) < 0x80 ? char.toLowerCase() : char.normalize('NFKC').toLowerCase()
}

/** The occurrences of `words` in `text` as [from, to) offsets of the text, in order and without overlaps. */
export function markRanges(text: string, words: readonly string[]): [number, number][] {
  if (words.length === 0 || text === '') return []
  let folded = ''
  const origin: number[] = []
  let at = 0
  for (const char of text) {
    const f = fold(char)
    for (let i = 0; i < f.length; i++) origin.push(at)
    folded += f
    at += char.length
  }
  origin.push(at)
  const found: [number, number][] = []
  for (const word of words) {
    for (let index = folded.indexOf(word); index !== -1; index = folded.indexOf(word, index + 1)) {
      found.push([origin[index] ?? 0, origin[index + word.length] ?? text.length])
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: [number, number][] = []
  for (const range of found) {
    const last = out[out.length - 1]
    if (last !== undefined && range[0] < last[1]) continue
    out.push(range)
  }
  return out
}

/** `text` as text nodes with its occurrences of `words` in <mark>. */
export function marked(text: string, words: readonly string[]): Node[] {
  const nodes: Node[] = []
  let at = 0
  for (const [from, to] of markRanges(text, words)) {
    if (from > at) nodes.push(document.createTextNode(text.slice(at, from)))
    nodes.push(el('mark', {}, text.slice(from, to)))
    at = to
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)))
  return nodes
}
