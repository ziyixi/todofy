/**
 * The bigram segmenter of recall's search index (../docs/design.md §6.1). A Durable Object cannot load a custom FTS5
 * tokenizer, and `unicode61` reads a run of Chinese characters as one token, so every indexed string and every query
 * term is prepared the same way: NFKC, lower case, then each run of Han, Hiragana, Katakana or Hangul characters
 * becomes its overlapping pairs (`数据库` → `数据 据库`), separated by spaces from the Latin and digit runs around it
 * (`D1数据库` → `d1 数据 据库`); a lone CJK character stays as itself. FTS5 keeps positions, so the pairs of a term
 * form a phrase: `数据库` matches only where `数据` is followed by `据库`.
 *
 * Changing this function changes what the index holds: it must never change without rebuilding the index from R2.
 */

/** A character of a CJK run: Han (with the iteration mark 々), Hiragana, Katakana (with the long-vowel mark ー), Hangul. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々ー]+/gu;
/** A token character of unicode61 (its default categories L*, N* and Co). */
const TOKEN_CHAR = /[\p{L}\p{N}\p{Co}]/u;
const ONE_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々ー]$/u;

/** A CJK run as its overlapping pairs (one character alone stays as itself). */
function pairs(run: string): string {
  const chars = Array.from(run);
  if (chars.length < 2) return run;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`);
  return out.join(' ');
}

/** A string as the index stores it: NFKC, lower case, CJK runs as pairs set apart by spaces. */
export function segment(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(CJK, (run) => ` ${pairs(run)} `);
}

/** The tokens unicode61 reads from a segmented string (runs of token characters). */
export function tokensOf(segmented: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const char of segmented) {
    if (TOKEN_CHAR.test(char)) current += char;
    else if (current !== '') {
      out.push(current);
      current = '';
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** Whether a token is a single CJK character (a CJK run of one, which the index holds as itself). */
export function isLoneCjk(token: string): boolean {
  return ONE_CJK.test(token);
}

/**
 * Whether a query term can find anything: it has a token that is not a single CJK character (the index holds pairs
 * of them, so `数` alone matches only where it stood alone in the text).
 */
export function searchable(term: string): boolean {
  return tokensOf(segment(term)).some((token) => !isLoneCjk(token));
}
