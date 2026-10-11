/**
 * The grounding check (../../docs/design.md §8): the writer's answer against the packets it was given, the exact text
 * the Worker fetched, never a new fetch. Pure functions.
 *
 * Normalization N, applied to quote and text alike, keeps a map from each normalized character back to the original:
 * citation marks removed (bracketed numbers `[12]`, `[3, 7]`, `[4–6]`; author-year citations `(Smith et al., 2020)`,
 * `(Li and Wang 2019; Chen 2021)`; footnote marks, superscript digits and `* † ‡ §` after a word), each with the space
 * before it; soft hyphens and zero-width characters removed; a word hyphenated across a line break joined; NFKC; lower
 * case; curly quotes straight, the dashes `‐ – — −` made `-`, `…` made `...`; whitespace collapsed; spaces between CJK
 * characters removed. MathML is already its alt text (fetch/page.ts).
 *
 * 1. Claims: each names a citable document of its item's packet; its quote is 20-300 characters after N (8 or more
 *    when mostly CJK) and holds no `...` (no splicing). It is found when N(quote) occurs in N(text), or else when an
 *    alignment finds at least 90% of its tokens (words; CJK characters one by one) in order within a window of the
 *    text at most 1.2 times its length, and the words it left out or added hold no negation (`not`, `never`, 不, 未:
 *    a quote that drops a `not` says the opposite). The claim then keeps the source's exact span (the original
 *    characters, mapped back through N): a displayed quote is verbatim whatever the model typed.
 * 2. Markers: every paragraph cites a claim; every `[n]` names a claim of the item; every claim is cited.
 * 3. Numbers: every token with a digit or a Chinese numeral is classified: identifiers (`GPT-5`, `H100`, `Qwen3-235B`)
 *    occur verbatim in the item's documents; dates and times are exempt; quantities (a magnitude `M7.1` among them)
 *    match a number in one of the paragraph's quotes at the precision written and within 10% (`约 15 亿` matches
 *    1.47 billion, `15.0 亿` does not, nor does `10 倍` match 5.2x); a Chinese numeral in a quantity (`两倍`, `三成`,
 *    `翻一番`, `数十亿`, `近万`, `一半`) is `number_style`, for the repair to write in digits. A title's, a why's and a
 *    heading's numbers match any of the item's quotes.
 * 4. Links: no text holds a URL, an address or a domain name (`link_in_text`): the writer writes none, so one can only
 *    come from a fetched page's planted text, and mail clients make a bare domain a link.
 * 5. Items: a research item cites its primary document; each meets its format's claim minimum.
 */
import { ALIGN_MIN_SHARE, ALIGN_WINDOW, ITEM_CUT_MAX, QUANTITY_MAX_ERROR, QUOTE_MAX, QUOTE_MIN, QUOTE_MIN_CJK } from './limits.ts';
import type { FormatName } from './registry.ts';

// ---- normalization ------------------------------------------------------------------------------------------------------

export interface Normalized {
  readonly text: string;
  /** Per normalized character: the original start index and end index (exclusive). */
  readonly starts: Int32Array;
  readonly ends: Int32Array;
}

const NAME = String.raw`\p{Lu}[\p{L}'’\-]+`;
const CITE_UNIT = String.raw`${NAME}(?:\s+et\s+al\.?|\s+(?:and|&)\s+${NAME})?,?\s+(?:1[89]|20)\d{2}[a-z]?`;
const AUTHOR_YEAR = new RegExp(String.raw`\s*\(\s*${CITE_UNIT}(?:\s*[;,]\s*${CITE_UNIT})*\s*\)`, 'gu');
const BRACKETED = /\s*\[\s*\d{1,4}(?:\s*[-–—,;]\s*\d{1,4})*\s*\]/g;
const FOOTNOTE = /(?<=[\p{L}\p{N}.,;:)\]'"’”])[\u00b9\u00b2\u00b3\u2070-\u2079*\u2020\u2021\u00a7]+/gu;
const LINE_HYPHEN = /(?<=\p{L})-[ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const QUOTES: Readonly<Record<string, string>> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-' };

/** Whether a code point is CJK (ideographs, kana, hangul, CJK punctuation and full-width forms). */
export function isCjk(code: number): boolean {
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2fa1f);
}

const LOWER_ASCII: readonly string[] = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code).toLowerCase());

function isSpaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** N of `source`, with the map back to it. */
export function normalize(source: string): Normalized {
  const drop = new Uint8Array(source.length);
  const mark = (pattern: RegExp): void => {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      for (let i = start; i < start + match[0].length; i++) drop[i] = 1;
    }
  };
  if (source.includes('[')) mark(BRACKETED);
  if (source.includes('(')) mark(AUTHOR_YEAR);
  mark(FOOTNOTE);
  if (source.includes('-')) mark(LINE_HYPHEN);
  mark(INVISIBLE);
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lastSpace = true;
  let lastCjk = false;
  let beforeSpaceCjk = false;
  const push = (char: string, code: number, start: number, end: number): void => {
    if (isSpaceCode(code)) {
      if (lastSpace) return;
      out.push(' ');
      starts.push(start);
      ends.push(end);
      beforeSpaceCjk = lastCjk;
      lastSpace = true;
      lastCjk = false;
      return;
    }
    const cjk = code >= 0x2e80 && isCjk(code);
    if (cjk && out.length > 0 && lastSpace && beforeSpaceCjk) {
      out.pop();
      starts.pop();
      ends.pop();
    }
    out.push(char);
    starts.push(start);
    ends.push(end);
    lastSpace = false;
    lastCjk = cjk;
  };
  for (let i = 0; i < source.length; ) {
    const code = source.codePointAt(i) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const end = i + width;
    if (drop[i] === 1) {
      i = end;
      continue;
    }
    if (code < 128) {
      push(LOWER_ASCII[code] ?? '', code, i, end);
      i = end;
      continue;
    }
    const raw = String.fromCodePoint(code);
    const mapped = QUOTES[raw] ?? raw.normalize('NFKC').toLowerCase();
    for (const char of mapped) push(char, char.codePointAt(0) ?? 0, i, end);
    i = end;
  }
  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    starts.pop();
    ends.pop();
  }
  return { text: out.join(''), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

/** The original span of normalized characters [from, to). */
export function originalSpan(source: string, n: Normalized, from: number, to: number): string {
  if (to <= from) return '';
  return source.slice(n.starts[from] ?? 0, n.ends[to - 1] ?? source.length);
}

// ---- tokens and the alignment ---------------------------------------------------------------------------------------------

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function isWordCode(code: number): boolean {
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  return /[\p{L}\p{N}]/u.test(String.fromCodePoint(code));
}

/** Words (letters and digits) and CJK characters one by one, with their normalized positions. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    if (!isWordCode(code)) {
      i += width;
      continue;
    }
    if (code >= 0x2e80 && isCjk(code)) {
      out.push({ text: String.fromCodePoint(code), start: i, end: i + width });
      i += width;
      continue;
    }
    let j = i + width;
    while (j < text.length) {
      const next = text.codePointAt(j) ?? 0;
      if ((next >= 0x2e80 && isCjk(next)) || !isWordCode(next)) break;
      j += next > 0xffff ? 2 : 1;
    }
    out.push({ text: text.slice(i, j), start: i, end: j });
    i = j;
  }
  return out;
}

/** Whether a text is mostly CJK (the quote minimum is then 8 characters). */
export function mostlyCjk(text: string): boolean {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (char === ' ') continue;
    if (isCjk(char.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return cjk > other;
}

export interface Found {
  /** The normalized span in the text. */
  readonly from: number;
  readonly to: number;
  readonly exact: boolean;
}

const LOOKAHEAD = 8;

/** Negations: an aligned quote may not leave one out or add one (`did not improve` is not `did improve`). */
const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'nor', 'neither', 'none', 'nothing', 'cannot', 't', 'unable', 'fail', 'fails', 'failed', 'failing', 'lack', 'lacks', 'lacking', '不', '没', '未', '无', '非', '否']);

/** Whether the words a span and a quote do not share (as multisets) hold no negation. */
function negationsKept(quote: readonly string[], span: readonly Token[]): boolean {
  const counts = new Map<string, number>();
  for (const token of span) counts.set(token.text, (counts.get(token.text) ?? 0) + 1);
  for (const word of quote) counts.set(word, (counts.get(word) ?? 0) - 1);
  for (const [word, count] of counts) if (count !== 0 && NEGATIONS.has(word)) return false;
  return true;
}

/** The longest common subsequence of two token lists (their texts), and the positions in `b` of one such match. */
function lcs(a: readonly string[], b: readonly Token[]): { length: number; first: number; last: number } {
  const m = a.length;
  const n = b.length;
  const table = new Uint16Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const index = i * (n + 1) + j;
      table[index] = a[i - 1] === b[j - 1]?.text ? (table[(i - 1) * (n + 1) + j - 1] ?? 0) + 1 : Math.max(table[(i - 1) * (n + 1) + j] ?? 0, table[i * (n + 1) + j - 1] ?? 0);
    }
  }
  // Walk back for the first and last matched positions in b.
  let i = m;
  let j = n;
  let first = -1;
  let last = -1;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]?.text) {
      if (last < 0) last = j - 1;
      first = j - 1;
      i--;
      j--;
    } else if ((table[(i - 1) * (n + 1) + j] ?? 0) >= (table[i * (n + 1) + j - 1] ?? 0)) i--;
    else j--;
  }
  return { length: table[m * (n + 1) + n] ?? 0, first, last };
}

/**
 * Where a quote's normalized text is in a document's: exact, or aligned (at least ALIGN_MIN_SHARE of its tokens in order
 * within a window of at most ALIGN_WINDOW times its length, no negation left out or added). The alignment runs only
 * when the exact match fails.
 */
export function findQuote(quote: string, text: string, textTokens: readonly Token[] | null = null): Found | null {
  if (quote === '') return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { from: exact, to: exact + quote.length, exact: true };
  const q = tokens(quote).map((token) => token.text);
  if (q.length < 3) return null;
  const t = textTokens ?? tokens(text);
  const need = Math.ceil(ALIGN_MIN_SHARE * q.length);
  const maxSpan = Math.floor(ALIGN_WINDOW * quote.length);
  const positions = new Map<string, number[]>();
  t.forEach((token, index) => {
    const list = positions.get(token.text);
    if (list === undefined) positions.set(token.text, [index]);
    else list.push(index);
  });
  // The window starts at the first matched token, one of the quote's first (len - need + 1) tokens.
  const starts = new Set<number>();
  for (let k = 0; k <= q.length - need && starts.size < 400; k++) for (const p of positions.get(q[k] ?? '') ?? []) starts.add(p);
  let best: Found | null = null;
  let bestMatched = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    const startToken = t[start];
    if (startToken === undefined) continue;
    let end = start;
    while (end + 1 < t.length && (t[end + 1]?.end ?? 0) - startToken.start <= maxSpan) end++;
    // A greedy match with a small lookahead first (a corrected spelling, a dropped mark), the exact LCS when it is close.
    let matched = 0;
    let j = start;
    let lastMatched = -1;
    for (const word of q) {
      for (let look = j; look <= end && look < j + LOOKAHEAD; look++) {
        if (t[look]?.text === word) {
          matched++;
          lastMatched = look;
          j = look + 1;
          break;
        }
      }
    }
    let first = start;
    let last = lastMatched;
    if (matched < need && matched >= need - Math.ceil(0.1 * q.length)) {
      const window = t.slice(start, end + 1);
      const exactLcs = lcs(q, window);
      matched = exactLcs.length;
      first = start + exactLcs.first;
      last = start + exactLcs.last;
    }
    if (matched >= need && last >= first) {
      const from = t[first]?.start ?? 0;
      const to = t[last]?.end ?? 0;
      // The tightest window wins (an earlier start can reach the same words through a skipped stretch).
      if (to - from <= maxSpan && (best === null || matched > bestMatched || (matched === bestMatched && to - from < best.to - best.from))) {
        best = { from, to, exact: false };
        bestMatched = matched;
      }
    }
  }
  if (best !== null && !negationsKept(q, tokens(text.slice(best.from, best.to)))) return null;
  return best;
}

// ---- the answer's shape -----------------------------------------------------------------------------------------------------

export interface Claim {
  readonly n: number;
  readonly doc: string;
  readonly quote: string;
}

export interface Paragraph {
  readonly heading: string;
  readonly text: string;
}

export interface WrittenItem {
  readonly packet: string;
  readonly section: string;
  readonly title: string;
  readonly paragraphs: readonly Paragraph[];
  readonly why: string;
  readonly claims: readonly Claim[];
}

export interface PacketDocument {
  readonly doc: string;
  /** The exact text the writer was given. */
  readonly text: string;
  /** A candidate's document (citable); signals are never documents. */
  readonly citable: boolean;
}

export interface Packet {
  readonly id: string;
  readonly section: 'research' | 'world' | 'deep_read';
  readonly format: FormatName;
  /** The documents, the primary one first. */
  readonly documents: readonly PacketDocument[];
}

export type FailureCode =
  | 'quote_not_found'
  | 'doc_not_citable'
  | 'identifier_not_found'
  | 'number_unsupported'
  | 'number_style'
  | 'uncited_paragraph'
  | 'unknown_marker'
  | 'unused_claim'
  | 'primary_not_cited'
  | 'too_few_claims'
  | 'link_in_text'
  | 'length';

export interface Failure {
  readonly code: FailureCode;
  /** The paragraph (-1: the title or why), sentence and claim the failure is in, when it has one. */
  readonly paragraph?: number;
  readonly sentence?: number;
  readonly claim?: number;
  /** The offending quote, number or sentence (for the repair's prompt; never logged). */
  readonly detail: string;
  /** For the title, the why, or the heading of `paragraph`. */
  readonly field?: 'title' | 'why' | 'heading';
}

export interface CheckedClaim extends Claim {
  /** The source's own characters for the quote. */
  readonly span: string;
  readonly exact: boolean;
}

export interface CheckResult {
  readonly failures: readonly Failure[];
  /** The claims found, with their verbatim spans (by claim number). */
  readonly found: ReadonlyMap<number, CheckedClaim>;
}

export const CLAIM_MINIMUM: Readonly<Record<FormatName, number>> = { professional: 1, familiar: 2, plain: 2, world_short: 1 };

// ---- markers and sentences --------------------------------------------------------------------------------------------------

const MARKER = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\]/g;

/** The claim numbers a text's markers name, in order. */
export function markersOf(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(MARKER)) for (const part of (match[1] ?? '').split(/[,，、]/)) out.push(Number(part.trim()));
  return out;
}

/** A text without its markers. */
export function withoutMarkers(text: string): string {
  return text.replace(MARKER, '');
}

/** The sentences of a paragraph (each with its end mark: 。！？；!?); a marker right after an end mark stays with it. */
export function sentences(text: string): string[] {
  const pieces = text.match(/[^。！？；!?]*[。！？；!?]+[」』）)"”’]*|[^。！？；!?]+$/gu) ?? [];
  const out: string[] = [];
  for (const piece of pieces) {
    const lead = /^(\s*\[\d{1,3}(?:\s*[,，、]\s*\d{1,3})*\])+/.exec(piece)?.[0];
    if (lead !== undefined && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}${lead}`;
      const rest = piece.slice(lead.length);
      if (rest !== '') out.push(rest);
    } else out.push(piece);
  }
  return out;
}

// ---- numbers ------------------------------------------------------------------------------------------------------------------

const SCALES: Readonly<Record<string, number>> = {
  千: 1e3, 万: 1e4, 十万: 1e5, 百万: 1e6, 千万: 1e7, 亿: 1e8, 十亿: 1e9, 百亿: 1e10, 千亿: 1e11, 万亿: 1e12,
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9, t: 1e12,
};
const SCALE_WORDS = '万亿|千亿|百亿|十亿|千万|百万|十万|千|万|亿|thousand|million|billion|trillion';
const SCALE_LETTERS = 'bn|mn|k|m|b|t';
const CN_DIGIT = '[〇零一二三四五六七八九十百千两几数半]';
// 番 only after 翻 (经过一番比较 is no quantity), 成 not in 一成不变 or 半成品; 近万, 上亿, 逾千 and the like are quantities.
const CN_STYLE = new RegExp(
  String.raw`(?<![\d.]\s?)(?:翻[一两三四五]番|${CN_DIGIT}+(?:倍|成(?!不变|品))|${CN_DIGIT}*[十百千两几数]${CN_DIGIT}*(?:万|亿)|[一二三四五六七八九两几数]+(?:万|亿)|[近上过破逾超](?:[十百千]?[万亿]|[百千])|百分之${CN_DIGIT}+|一半)`,
  'gu',
);
/** 千万 before these is the adverb (千万不要, 千万别), not ten million. */
const ADVERB_QIANWAN = /^[不别要记得务]/;
/** An earthquake's magnitude written joined (M7.1, Mw6.8): a quantity, matched against Magnitude 7.1 or M 7.1. */
const MAGNITUDE = /^M[wsbdcl]?(\d\.\d{1,2})$/i;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

export interface Quantity {
  readonly value: number;
  /** Significant figures written (an integer's trailing zeros not counted). */
  readonly figures: number;
  readonly percent: boolean;
  readonly text: string;
}

export interface NumberToken {
  readonly kind: 'identifier' | 'date' | 'quantity' | 'style';
  readonly text: string;
  readonly quantity?: Quantity;
}

function significantFigures(digits: string): number {
  const [whole = '', fraction = ''] = digits.replace(/,/g, '').split('.');
  const trimmedWhole = whole.replace(/^0+/, '');
  if (fraction !== '') {
    if (trimmedWhole === '') return Math.max(1, fraction.replace(/^0+/, '').length);
    return trimmedWhole.length + fraction.length;
  }
  const figures = trimmedWhole.replace(/0+$/, '').length;
  return Math.max(1, figures);
}

/**
 * The number tokens of a written (Chinese) text, classified. Markers are removed first; full-width digits read as
 * ASCII (NFKC).
 */
export function classifyNumbers(text: string): NumberToken[] {
  const plain = withoutMarkers(text).normalize('NFKC');
  const out: NumberToken[] = [];
  // Chinese numerals in a quantity: number_style.
  for (const match of plain.matchAll(CN_STYLE)) {
    if (match[0] === '千万' && ADVERB_QIANWAN.test(plain.slice(match.index + match[0].length))) continue;
    out.push({ kind: 'style', text: match[0] });
  }
  const pattern = /(?<![A-Za-z0-9])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|[A-Za-z0-9](?:[A-Za-z0-9]|[-_.+/](?=[A-Za-z0-9]))*)/g;
  for (const match of plain.matchAll(pattern)) {
    const token = match[1] ?? '';
    const start = match.index;
    const end = start + match[0].length;
    const after = plain.slice(end, end + 8);
    const before = plain.slice(Math.max(0, start - 12), start);
    if (!/\d/.test(token)) continue;
    // Pure numbers, possibly a range (2020-2023) or a date (2026-10-12): each part on its own.
    if (/^[\d,.\-/]+$/.test(token)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(token) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(token)) {
        out.push({ kind: 'date', text: token });
        continue;
      }
      const parts = token.split(/(?<=\d)-(?=\d)/);
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        out.push(classifyPlainNumber(part, isLast ? after : '', index === 0 ? before : '', isLast ? plain.slice(end) : ''));
      });
      continue;
    }
    // A number with a scale suffix only (7B, 128K, 1.5T, 70M, 3bn): a quantity.
    const scaled = /^(\d+(?:\.\d+)?)(k|K|M|B|T|bn|mn)$/.exec(token);
    if (scaled !== null) {
      const digits = scaled[1] ?? '0';
      const scale = SCALES[(scaled[2] ?? '').toLowerCase()] ?? 1;
      out.push({ kind: 'quantity', text: token, quantity: { value: Number(digits) * scale, figures: significantFigures(digits), percent: false, text: token } });
      continue;
    }
    const magnitude = MAGNITUDE.exec(token);
    if (magnitude !== null) {
      const digits = magnitude[1] ?? '0';
      out.push({ kind: 'quantity', text: token, quantity: { value: Number(digits), figures: significantFigures(digits), percent: false, text: token } });
      continue;
    }
    // Quarters (Q3), decades (1990s), clock suffixes (3pm): dates.
    if (/^Q[1-4]$/i.test(token) || /^(?:1[89]|20)\d0s$/.test(token) || /^\d{1,2}(?:am|pm)$/i.test(token) || /^\d{1,2}(?:st|nd|rd|th)$/i.test(token)) {
      out.push({ kind: 'date', text: token });
      continue;
    }
    out.push({ kind: 'identifier', text: token });
  }
  return out;
}

function classifyPlainNumber(part: string, after: string, before: string, rest: string): NumberToken {
  const digits = part.replace(/\/.*$/, '');
  const value = Number(digits.replace(/,/g, ''));
  // Dates and times: a clock's 点 (3 点), and 分 or 秒 only after one (3 点 20 分): `提升 3 分` is a quantity.
  if (/^\s*(?:年代|世纪|月|日|号|时|点钟|:\d{2})/.test(after) || (/^\s*年(?!代)/.test(after) && value >= 1000)) return { kind: 'date', text: part };
  if (/^\s*点(?!数)/.test(after) && /^\d{1,2}$/.test(digits) && value <= 24) return { kind: 'date', text: part };
  if (/^\s*(?:分|秒)/.test(after) && /[点时分]\s*$/.test(before)) return { kind: 'date', text: part };
  if (/^\s*年/.test(after) && value < 1000) {
    // `3 年` is a duration: a quantity.
  } else if (/^\d{4}$/.test(digits) && value >= 1900 && value <= 2100) return { kind: 'date', text: part };
  if (/^:\d{2}/.test(rest) || /\d:\s*$/.test(before)) return { kind: 'date', text: part };
  if (new RegExp(String.raw`(?:${MONTHS})\.?\s*$`, 'i').test(before) || new RegExp(String.raw`^\s*(?:${MONTHS})\b`, 'i').test(after)) return { kind: 'date', text: part };
  if (/(?:第|周|星期)\s*$/.test(before) && /^\s*(?:季度|季|周|天|日)/.test(after)) return { kind: 'date', text: part };
  // A quantity: its scale and percent.
  let scale = 1;
  const scaleMatch = new RegExp(String.raw`^\s*(${SCALE_WORDS}|${SCALE_LETTERS})(?![A-Za-z])`, 'i').exec(after);
  if (scaleMatch?.[1] !== undefined) scale = SCALES[scaleMatch[1].toLowerCase()] ?? 1;
  const percent = /^\s*(?:%|％|个百分点|percent|per cent)/.test(after) || /百分之\s*$/.test(before);
  return { kind: 'quantity', text: part, quantity: { value: value * scale, figures: significantFigures(digits), percent, text: part } };
}

const WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  twice: 2, double: 2, doubled: 2, triple: 3, tripled: 3, half: 0.5, quadruple: 4,
};

export interface SourceNumber {
  readonly value: number;
  readonly percent: boolean;
}

/**
 * The numbers of a source text (a quote's verbatim span, normalized): digits with their scales (both readings of an
 * ambiguous single letter: `70 m` is 70 metres or 70 million), English number words, and percents.
 */
export function sourceNumbers(text: string): SourceNumber[] {
  const n = text.normalize('NFKC').toLowerCase();
  const out: SourceNumber[] = [];
  const pattern = new RegExp(String.raw`(?<![\p{L}\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(${SCALE_WORDS}|${SCALE_LETTERS})?(?![a-z])\s*(%|percent|per cent|个百分点)?`, 'gu');
  for (const match of n.matchAll(pattern)) {
    const base = Number(`${(match[1] ?? '0').replace(/,/g, '')}${match[2] === undefined ? '' : `.${match[2]}`}`);
    const scaleText = match[3];
    const percent = match[4] !== undefined || /百分之\s*$/.test(n.slice(Math.max(0, match.index - 4), match.index));
    out.push({ value: base, percent });
    if (scaleText !== undefined) out.push({ value: base * (SCALES[scaleText] ?? 1), percent });
  }
  for (const match of n.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twice|double|doubled|triple|tripled|quadruple|half)\b(?:\s+(thousand|million|billion|trillion))?(\s+percent)?/g)) {
    const base = WORDS[match[1] ?? ''] ?? 0;
    const scale = match[2] === undefined ? 1 : (SCALES[match[2]] ?? 1);
    out.push({ value: base * scale, percent: match[3] !== undefined });
  }
  for (const match of n.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|-fold|fold|倍)/g)) out.push({ value: Number(match[1]), percent: false });
  // A magnitude written joined (m7.1, mw6.8; `magnitude 7.1` and `m 7.1` are read above).
  for (const match of n.matchAll(/(?<![\p{L}\d])m[wsbdcl]?(\d\.\d{1,2})(?![\d.])/gu)) out.push({ value: Number(match[1]), percent: false });
  return out;
}

/**
 * Whether `source` rounds to the written quantity at the precision written (absolute values; scales applied), and lies
 * within QUANTITY_MAX_ERROR of it: one significant figure alone would let `10 倍` stand for 5.2x.
 */
export function roundsTo(source: number, written: Quantity): boolean {
  const a = Math.abs(source);
  const w = Math.abs(written.value);
  if (w === 0) return a === 0;
  if (a === 0) return false;
  const magnitude = Math.floor(Math.log10(w));
  const step = 10 ** (magnitude - written.figures + 1);
  const rounded = Math.round(a / step) * step;
  return Math.abs(rounded - w) <= step * 1e-6 + Number.EPSILON * w && Math.abs(a - w) <= QUANTITY_MAX_ERROR * w * (1 + 1e-9);
}

/** Whether a written quantity is supported by one of the source numbers. */
export function quantitySupported(written: Quantity, numbers: readonly SourceNumber[]): boolean {
  return numbers.some((number) => (!written.percent || number.percent) && roundsTo(number.value, written));
}

// ---- the check ------------------------------------------------------------------------------------------------------------------

function docText(packet: Packet, doc: string): PacketDocument | undefined {
  return packet.documents.find((document) => document.doc === doc);
}

/** Per document: its normalization and tokens, computed once per check. */
export class DocumentIndex {
  private readonly cache = new Map<string, { n: Normalized; tokens: Token[] | null }>();
  private readonly packet: Packet;

  constructor(packet: Packet) {
    this.packet = packet;
  }

  get(doc: string): { source: string; n: Normalized; tokens: () => Token[] } | null {
    const document = docText(this.packet, doc);
    if (document === undefined) return null;
    let entry = this.cache.get(doc);
    if (entry === undefined) {
      entry = { n: normalize(document.text), tokens: null };
      this.cache.set(doc, entry);
    }
    const cached = entry;
    return {
      source: document.text,
      n: cached.n,
      tokens: () => {
        cached.tokens ??= tokens(cached.n.text);
        return cached.tokens;
      },
    };
  }

  /** Whether a normalized identifier occurs in any of the packet's documents. */
  hasIdentifier(identifier: string): boolean {
    const needle = normalize(identifier).text;
    return this.packet.documents.some((document) => (this.get(document.doc)?.n.text ?? '').includes(needle));
  }
}

/** Checks one claim's document and quote; the found span or the failure. */
export function checkClaim(claim: Claim, packet: Packet, index: DocumentIndex): CheckedClaim | Failure {
  const document = docText(packet, claim.doc);
  if (document === undefined || !document.citable) return { code: 'doc_not_citable', claim: claim.n, detail: claim.doc };
  const q = normalize(claim.quote).text;
  const min = mostlyCjk(q) ? QUOTE_MIN_CJK : QUOTE_MIN;
  if (q.length < min || q.length > QUOTE_MAX || q.includes('...')) return { code: 'quote_not_found', claim: claim.n, detail: claim.quote };
  const entry = index.get(claim.doc);
  if (entry === null) return { code: 'doc_not_citable', claim: claim.n, detail: claim.doc };
  const found = findQuote(q, entry.n.text, entry.tokens());
  if (found === null) return { code: 'quote_not_found', claim: claim.n, detail: claim.quote };
  return { ...claim, span: originalSpan(entry.source, entry.n, found.from, found.to), exact: found.exact };
}

/** The number failures of a text against the numbers of `quotes` (the verbatim spans it may rest on). */
function numberFailures(text: string, quotes: readonly string[], index: DocumentIndex): { code: FailureCode; detail: string }[] {
  const failures: { code: FailureCode; detail: string }[] = [];
  let numbers: SourceNumber[] | null = null;
  for (const token of classifyNumbers(text)) {
    if (token.kind === 'date') continue;
    if (token.kind === 'style') {
      failures.push({ code: 'number_style', detail: token.text });
      continue;
    }
    if (token.kind === 'identifier') {
      if (!index.hasIdentifier(token.text)) failures.push({ code: 'identifier_not_found', detail: token.text });
      continue;
    }
    numbers ??= quotes.flatMap((quote) => sourceNumbers(normalize(quote).text));
    if (token.quantity !== undefined && !quantitySupported(token.quantity, numbers)) failures.push({ code: 'number_unsupported', detail: token.text });
  }
  return failures;
}

// Common top-level domains: what a mail client would make a link of. A name like Node.js is none of them.
const TLDS = 'com|org|net|edu|gov|mil|int|io|ai|app|dev|co|info|biz|xyz|site|online|top|tech|cloud|link|page|science|news|blog|shop|store|live|pro|tv|cc|ly|gl|gg|sh|fm|eu|us|uk|de|fr|jp|cn|ru|ca|au|nl|ch|se|es|br|kr|tw|hk|sg|nz|za';
const LINK = new RegExp(String.raw`https?://|\bwww\.|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w.@/-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:${TLDS})(?![\w-])`, 'iu');

/** The first URL, address or domain name in a text, or null. */
export function linkIn(text: string): string | null {
  return LINK.exec(withoutMarkers(text).normalize('NFKC'))?.[0] ?? null;
}

/** The whole check of one written item against its packet. */
export function checkItem(item: WrittenItem, packet: Packet): CheckResult {
  const index = new DocumentIndex(packet);
  const failures: Failure[] = [];
  const found = new Map<number, CheckedClaim>();
  const numbers = new Set<number>();
  for (const claim of item.claims) {
    if (numbers.has(claim.n)) {
      failures.push({ code: 'unknown_marker', claim: claim.n, detail: `[${String(claim.n)}]` });
      continue;
    }
    numbers.add(claim.n);
    const result = checkClaim(claim, packet, index);
    if ('code' in result) failures.push(result);
    else found.set(claim.n, result);
  }
  const cited = new Set<number>();
  item.paragraphs.forEach((paragraph, p) => {
    const markers = markersOf(paragraph.text);
    if (markers.length === 0) failures.push({ code: 'uncited_paragraph', paragraph: p, detail: paragraph.text.slice(0, 120) });
    for (const n of markers) {
      if (!numbers.has(n)) failures.push({ code: 'unknown_marker', paragraph: p, claim: n, detail: `[${String(n)}]` });
      cited.add(n);
    }
    sentences(paragraph.text).forEach((sentence, s) => {
      const quotes = markersOf(paragraph.text)
        .map((n) => found.get(n)?.span)
        .filter((span): span is string => span !== undefined);
      for (const failure of numberFailures(sentence, quotes, index)) failures.push({ ...failure, paragraph: p, sentence: s });
      const link = linkIn(sentence);
      if (link !== null) failures.push({ code: 'link_in_text', paragraph: p, sentence: s, detail: link });
    });
  });
  for (const claim of item.claims) if (!cited.has(claim.n)) failures.push({ code: 'unused_claim', claim: claim.n, detail: `[${String(claim.n)}]` });
  // The title, the why and the headings rest on any of the item's quotes; none may hold a link.
  const allQuotes = [...found.values()].map((claim) => claim.span);
  const field = (text: string, at: Pick<Failure, 'paragraph' | 'field'>): void => {
    for (const failure of numberFailures(text, allQuotes, index)) failures.push({ ...failure, ...at });
    const link = linkIn(text);
    if (link !== null) failures.push({ code: 'link_in_text', detail: link, ...at });
  };
  field(item.title, { paragraph: -1, field: 'title' });
  field(item.why, { paragraph: -1, field: 'why' });
  item.paragraphs.forEach((paragraph, p) => {
    if (paragraph.heading !== '') field(paragraph.heading, { paragraph: p, field: 'heading' });
  });
  const primary = packet.documents.find((document) => document.citable)?.doc;
  if (packet.section === 'research' && primary !== undefined && ![...found.values()].some((claim) => claim.doc === primary)) failures.push({ code: 'primary_not_cited', detail: primary });
  if (found.size < CLAIM_MINIMUM[packet.format]) failures.push({ code: 'too_few_claims', detail: String(found.size) });
  return { failures, found };
}

// ---- cuts after the repair ---------------------------------------------------------------------------------------------------

export interface CutResult {
  readonly item: WrittenItem | null;
  /** Why it was dropped, when it was. */
  readonly dropped: string | null;
  readonly removedChars: number;
}

function totalChars(item: WrittenItem): number {
  return item.paragraphs.reduce((sum, paragraph) => sum + withoutMarkers(paragraph.text).length, 0);
}

/**
 * What still fails after the repair is cut at the smallest unit (design §8): a sentence with a failing number,
 * identifier, style or link is removed; a failing claim is removed with the sentences that cite only it; a failing why
 * or heading is emptied; markers are renumbered. The item is dropped when its title fails, or it lost more than a third
 * of its characters, its primary document's claims or a whole paragraph, or no longer meets its format's claim minimum.
 */
export function cutItem(item: WrittenItem, packet: Packet, maxCut: number = ITEM_CUT_MAX): CutResult {
  const result = checkItem(item, packet);
  if (result.failures.length === 0) return { item, dropped: null, removedChars: 0 };
  if (result.failures.some((failure) => failure.code === 'uncited_paragraph')) return { item: null, dropped: 'uncited_paragraph', removedChars: totalChars(item) };
  const badClaims = new Set(result.failures.filter((f) => f.claim !== undefined && (f.code === 'quote_not_found' || f.code === 'doc_not_citable' || f.code === 'unused_claim')).map((f) => f.claim as number));
  const knownClaims = new Set(item.claims.map((claim) => claim.n));
  const badSentences = new Set(result.failures.filter((f) => f.paragraph !== undefined && f.paragraph >= 0 && f.sentence !== undefined).map((f) => `${String(f.paragraph)}:${String(f.sentence)}`));
  const badHeadings = new Set(result.failures.filter((f) => f.field === 'heading').map((f) => f.paragraph));
  const before = totalChars(item);
  const paragraphs: Paragraph[] = [];
  for (const [p, paragraph] of item.paragraphs.entries()) {
    const kept: string[] = [];
    for (const [s, sentence] of sentences(paragraph.text).entries()) {
      if (badSentences.has(`${String(p)}:${String(s)}`)) continue;
      const markers = markersOf(sentence);
      const good = markers.filter((n) => knownClaims.has(n) && !badClaims.has(n));
      if (markers.length > 0 && good.length === 0) continue;
      kept.push(
        sentence.replace(MARKER, (_whole: string, list: string) => {
          const keep = list.split(/[,，、]/).map((part) => Number(part.trim())).filter((n) => knownClaims.has(n) && !badClaims.has(n));
          return keep.length === 0 ? '' : `[${keep.join(', ')}]`;
        }),
      );
    }
    const text = kept.join('').trim();
    if (text === '' || markersOf(text).length === 0) return { item: null, dropped: 'paragraph_lost', removedChars: before };
    paragraphs.push({ heading: badHeadings.has(p) ? '' : paragraph.heading, text });
  }
  // Renumber the claims that are still cited, in order of their first citation.
  const order: number[] = [];
  for (const paragraph of paragraphs) for (const n of markersOf(paragraph.text)) if (!order.includes(n)) order.push(n);
  const renumber = new Map(order.map((n, i) => [n, i + 1]));
  const claims = order.map((n) => {
    const claim = item.claims.find((c) => c.n === n) as Claim;
    return { ...claim, n: renumber.get(n) ?? n };
  });
  const renumbered = paragraphs.map((paragraph) => ({
    heading: paragraph.heading,
    text: paragraph.text.replace(MARKER, (_whole: string, list: string) => `[${list.split(/[,，、]/).map((part) => String(renumber.get(Number(part.trim())) ?? part.trim())).join(', ')}]`),
  }));
  const titleBad = result.failures.some((f) => f.field === 'title');
  const whyBad = result.failures.some((f) => f.field === 'why');
  const cut: WrittenItem = { ...item, paragraphs: renumbered, claims, why: whyBad ? '' : item.why };
  const after = totalChars(cut);
  const removed = before - after;
  if (titleBad) return { item: null, dropped: 'title_unsupported', removedChars: before };
  if (before > 0 && removed / before > maxCut) return { item: null, dropped: 'cut_too_much', removedChars: removed };
  const check = checkItem(cut, packet);
  if (check.failures.length > 0) return { item: null, dropped: check.failures[0]?.code ?? 'still_failing', removedChars: removed };
  return { item: cut, dropped: null, removedChars: removed };
}

/** The repair's view of a failure: its code and the offending text (the prompt's lines). */
export function describeFailures(failures: readonly Failure[]): string[] {
  return failures.map((failure) => {
    const paragraph = failure.paragraph !== undefined && failure.paragraph >= 0 ? `paragraph ${String(failure.paragraph + 1)}` : null;
    const where =
      failure.field === 'heading' ? `heading of ${paragraph ?? 'a paragraph'}` : failure.field !== undefined ? failure.field : paragraph !== null ? paragraph : failure.claim !== undefined ? `claim ${String(failure.claim)}` : 'item';
    return `${failure.code} (${where}): ${failure.detail}`;
  });
}
