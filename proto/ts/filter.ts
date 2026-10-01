/**
 * The AIP-160 filter subset the HTTP APIs accept today: a conjunction of global literals.
 *
 *   filter   = [ literal { ( WS | WS "AND" WS ) literal } ]   (whitespace around the whole is ignored)
 *   literal  = bare | quoted
 *   bare     = a letter, digit or "_", then letters, digits, "_" or "-"   (e.g. `graph`, `self-supervised`)
 *   quoted   = '"' { char | '\"' | '\\' } '"'  or the same with "'"      (e.g. `"graph neural"`)
 *
 * Each literal is a global restriction (AIP-160: it matches a resource when the API's documented text field
 * contains it), and the literals are ANDed. Everything else AIP-160 defines is refused rather than read
 * with another meaning: OR, NOT and `-` (negation), fields and member traversal (`title:x`, `a.b`),
 * comparisons, functions, parentheses, wildcards, any other escape. An API that needs more grows this
 * parser; until then a client can rely on every accepted filter meaning what AIP-160 says it means.
 *
 * A client that offers a search box quotes what the owner typed (`quoteLiteral`), so the box searches for the
 * text as one phrase whatever characters it holds. The cases are in testdata/filter-cases.json.
 */

export class FilterError extends Error {}

const BARE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
const KEYWORDS = new Set(['AND', 'OR', 'NOT']);
const SPACE = /\s/u;

/** One token: a literal's text, or the keyword AND (only as a separator). */
type Token = { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'and' };

function tokens(filter: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < filter.length) {
    const char = filter[i] ?? '';
    if (SPACE.test(char)) {
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let text = '';
      let j = i + 1;
      for (;;) {
        if (j >= filter.length) throw new FilterError('an unterminated string');
        const next = filter[j] ?? '';
        if (next === char) break;
        if (next === '\\') {
          const escaped = filter[j + 1] ?? '';
          if (escaped !== '"' && escaped !== "'" && escaped !== '\\') throw new FilterError('an unsupported escape');
          text += escaped;
          j += 2;
        } else {
          text += next;
          j += 1;
        }
      }
      if (text.trim() === '') throw new FilterError('an empty string');
      out.push({ kind: 'literal', text });
      i = j + 1;
      // A quoted literal ends a token: `"a"b` is not two literals.
      if (i < filter.length && !SPACE.test(filter[i] ?? '')) throw new FilterError('a string runs into other text');
      continue;
    }
    let j = i;
    while (j < filter.length && !SPACE.test(filter[j] ?? '')) j += 1;
    const word = filter.slice(i, j);
    if (word === 'AND') out.push({ kind: 'and' });
    else if (KEYWORDS.has(word)) throw new FilterError('only AND is supported');
    else if (BARE.test(word)) out.push({ kind: 'literal', text: word });
    else throw new FilterError('only literals are supported');
    i = j;
  }
  return out;
}

/**
 * The literals of a filter in this subset, in order (an empty filter has none). Throws FilterError (answer
 * INVALID_ARGUMENT) for anything outside the subset, and for more than `maxLiterals` literals.
 */
export function parseLiteralFilter(filter: string, maxLiterals: number): string[] {
  const literals: string[] = [];
  let expectLiteral = true;
  for (const token of tokens(filter)) {
    if (token.kind === 'and') {
      if (expectLiteral) throw new FilterError('AND needs a literal on both sides');
      expectLiteral = true;
      continue;
    }
    literals.push(token.text);
    expectLiteral = false;
  }
  if (expectLiteral && literals.length > 0) throw new FilterError('AND needs a literal on both sides');
  if (literals.length > maxLiterals) throw new FilterError('too many literals');
  return literals;
}

/** The filter that searches for `text` as one phrase: a quoted literal, or '' when `text` is blank. */
export function quoteLiteral(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `"${trimmed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
