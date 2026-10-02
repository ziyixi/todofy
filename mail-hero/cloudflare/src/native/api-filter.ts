// The AIP-160 filters of Mail Hero's list methods (mailhero.ui.v2 ListMessages and ListDeliveries): a conjunction of
// global literals and field restrictions.
//
//   filter      = [ term { ( WS | WS "AND" WS ) term } ]   (whitespace around the whole is ignored)
//   term        = restriction | literal
//   restriction = field [WS] comparator [WS] value
//   field       = a lower-case letter, then lower-case letters, digits or "_"      (`delivery_state`)
//   comparator  = "=" | "<" | "<=" | ">" | ">="
//   value       = bare | quoted
//   literal     = bare | quoted
//   bare        = a letter, digit or "_", then letters, digits, "_" or "-"         (`FAILED`, `true`)
//   quoted      = '"' { char | '\"' | '\\' } '"'  or the same with "'"         (`"2026-10-01T00:00:00Z"`)
//
// The shared subset (proto/ts/filter.ts) has literals only; each list here also restricts fields, which that parser
// refuses on purpose. Everything else AIP-160 defines is refused rather than read with another meaning: OR, NOT and
// `-` (negation), `!=` and `:` (has), member traversal (`a.b`), functions, parentheses and wildcards. Which fields,
// comparators and values a list takes is the list's own check (api-v2.ts); this module only parses. The quoting, escapes
// and bare words are the shared parser's: test/api-filter.test.mjs runs its corpus (proto/testdata/filter-cases.json)
// here, so the two read every literal alike and differ only where this one reads a comparison as a restriction.

export class FilterError extends Error {}

/** A field restriction: `field comparator value`. */
export interface Restriction {
  readonly field: string
  readonly comparator: '=' | '<' | '<=' | '>' | '>='
  readonly value: string
  /** The value was a quoted string (a time, a resource name), not a bare word (an enum name, true or false). */
  readonly quoted: boolean
}
export interface Filter {
  readonly literals: readonly string[]
  readonly restrictions: readonly Restriction[]
}

const BARE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u
const FIELD = /^[a-z][a-z0-9_]*$/
const SPACE = /\s/u
const KEYWORDS = new Set(['AND', 'OR', 'NOT'])
const COMPARATOR_START = new Set(['=', '<', '>', '!', ':'])

type Token =
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'comparator'; readonly text: Restriction['comparator'] }

function tokens(filter: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < filter.length) {
    const char = filter[i] ?? ''
    if (SPACE.test(char)) { i += 1; continue }
    if (char === '"' || char === "'") {
      let text = ''
      let j = i + 1
      for (;;) {
        if (j >= filter.length) throw new FilterError('an unterminated string')
        const next = filter[j] ?? ''
        if (next === char) break
        if (next === '\\') {
          const escaped = filter[j + 1] ?? ''
          if (escaped !== '"' && escaped !== "'" && escaped !== '\\') throw new FilterError('an unsupported escape')
          text += escaped
          j += 2
        } else {
          text += next
          j += 1
        }
      }
      out.push({ kind: 'string', text })
      i = j + 1
      // A quoted string ends a token: `"a"b` is not two terms.
      if (i < filter.length && !SPACE.test(filter[i] ?? '') && !COMPARATOR_START.has(filter[i] ?? '')) throw new FilterError('a string runs into other text')
      continue
    }
    if (COMPARATOR_START.has(char)) {
      const two = filter.slice(i, i + 2)
      if (two === '<=' || two === '>=') { out.push({ kind: 'comparator', text: two }); i += 2; continue }
      if (char === '=' || char === '<' || char === '>') { out.push({ kind: 'comparator', text: char }); i += 1; continue }
      throw new FilterError('only =, <, <=, > and >= compare')
    }
    let j = i
    while (j < filter.length && !SPACE.test(filter[j] ?? '') && !COMPARATOR_START.has(filter[j] ?? '') && filter[j] !== '"' && filter[j] !== "'") j += 1
    out.push({ kind: 'word', text: filter.slice(i, j) })
    i = j
  }
  return out
}

/**
 * The literals and restrictions of `filter`, in order; throws FilterError (answer INVALID_ARGUMENT) for anything
 * outside the grammar above, or for a filter longer than `maxLength` characters.
 */
export function parseFilter(filter: string, maxLength: number): Filter {
  if (filter.length > maxLength) throw new FilterError('the filter is too long')
  const list = tokens(filter)
  const literals: string[] = []
  const restrictions: Restriction[] = []
  let expectTerm = true
  for (let i = 0; i < list.length; i++) {
    const token = list[i]!
    if (token.kind === 'word' && token.text === 'AND') {
      if (expectTerm) throw new FilterError('AND needs a term on both sides')
      expectTerm = true
      continue
    }
    if (!expectTerm && token.kind === 'comparator') throw new FilterError('a comparison needs a field')
    const next = list[i + 1]
    if (next?.kind === 'comparator') {
      if (token.kind !== 'word' || !FIELD.test(token.text)) throw new FilterError('a comparison needs a field name')
      const value = list[i + 2]
      if (value === undefined || value.kind === 'comparator') throw new FilterError('a comparison needs a value')
      if (value.kind === 'word' && (!BARE.test(value.text) || KEYWORDS.has(value.text))) throw new FilterError('a value is a bare word or a quoted string')
      restrictions.push({ field: token.text, comparator: next.text, value: value.text, quoted: value.kind === 'string' })
      i += 2
    } else if (token.kind === 'string') {
      if (token.text.trim() === '') throw new FilterError('an empty string')
      literals.push(token.text)
    } else if (token.kind === 'word') {
      if (KEYWORDS.has(token.text)) throw new FilterError('only AND is supported')
      if (!BARE.test(token.text)) throw new FilterError('only literals and comparisons are supported')
      literals.push(token.text)
    } else {
      throw new FilterError('a comparison needs a field')
    }
    expectTerm = false
  }
  if (expectTerm && (literals.length > 0 || restrictions.length > 0)) throw new FilterError('AND needs a term on both sides')
  return { literals, restrictions }
}
