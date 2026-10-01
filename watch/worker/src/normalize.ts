/**
 * Stage 3 of the noise pipeline (../../docs/design.md §5): normalization and masks, deterministic and pure.
 *
 * Every line: NFKC, zero-width characters removed, runs of whitespace as one space, trimmed; empty lines dropped.
 * Then the default masks, unless NormalizeOptions.disable_default_masks, replace what changes on every load without
 * meaning anything with a fixed token:
 *
 * - relative times: `3 minutes ago`, `an hour ago`, `just now`, `in 5 min`, `5m ago`, `3小时前`, `5 分钟前`, `刚刚`,
 *   `半小时前`, `昨天 12:30`, `前天`;
 * - times of day with seconds (`12:34:56`), and the time part of an ISO date-time (`2026-10-01T12:34:56Z` keeps its
 *   date): the date stays, a time of day without seconds (`09:00`, an opening hour) stays;
 * - epoch milliseconds (13 digits from 2001 to 2286);
 * - UUIDs, hex strings of 16 or more characters, base64 runs of 24 or more characters with a digit and both cases;
 * - the values of nonce, token, signature, sig, csrf, _ and cache-busting `v`/`ver`/`ts` query parameters;
 * - copyright years: `© 2024`, `©2019-2026`, `Copyright 2025`, `(c) 2026`, `版权所有 2026`.
 *
 * Absolute dates and every other number are kept: a price, a version or a date is often what the owner watches.
 * NormalizeOptions.mask_numbers masks the remaining digits too, and ignored_lines drops exact lines (after masking).
 */

/** The tokens the masks write. */
export const MASK = {
  relativeTime: '⟨相对时间⟩',
  time: '⟨时刻⟩',
  token: '⟨随机串⟩',
  year: '⟨年份⟩',
  number: '⟨数字⟩',
} as const;

export interface NormalizeOptions {
  readonly ignoredLines: readonly string[];
  readonly defaultMasks: boolean;
  readonly maskNumbers: boolean;
}

export interface Normalized {
  readonly lines: string[];
  /** Masks applied, over every line. */
  readonly masked: number;
  /** Lines `ignoredLines` dropped. */
  readonly ignored: number;
}

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const SPACE = /\s+/gu;

/** One line without its noise in form (no masks): NFKC, no zero-width characters, single spaces, trimmed. */
export function cleanLine(line: string): string {
  return line.normalize('NFKC').replace(ZERO_WIDTH, '').replace(SPACE, ' ').trim();
}

const EN_UNITS = '(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?|mo|mos|months?|y|yr|yrs|years?)';
const ZH_UNITS = '(?:秒钟?|分钟|小时|个?钟头|天|日|周|星期|个月|月|年)';

/** The default masks, in order (earlier ones protect their text from later ones). */
const MASKS: readonly { readonly pattern: RegExp; readonly token: string }[] = [
  // Relative times, English: "3 minutes ago", "an hour ago", "in 5 min", "5m ago", "just now", "a few seconds ago".
  { pattern: new RegExp(`\\b(?:(?:\\d+|an?|a few|several)\\s*${EN_UNITS}\\.?\\s+ago|in\\s+(?:\\d+|an?)\\s*${EN_UNITS}\\b|just now|moments? ago)\\b`, 'gi'), token: MASK.relativeTime },
  // Relative times, Chinese: "3小时前", "5 分钟前", "半小时前", "刚刚", "昨天", "前天", "今天" with an optional time.
  { pattern: new RegExp(`(?:\\d+|[一二两三四五六七八九十几半]+)\\s*${ZH_UNITS}(?:以|之)?前|刚刚|刚才|(?:今天|昨天|前天)(?:\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?`, 'g'), token: MASK.relativeTime },
  // The time part of an ISO date-time: the date stays.
  { pattern: /(?<=\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, token: ` ${MASK.time}` },
  // A time of day with seconds.
  { pattern: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, token: MASK.time },
  // UUIDs.
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, token: MASK.token },
  // Nonce, token and cache-busting query values.
  { pattern: /([?&;](?:nonce|token|sig|signature|csrf|_|v|ver|ts|t|cb)=)[^&#\s>"']+/gi, token: `$1${MASK.token}` },
  // Epoch milliseconds (2001-09-09 to 2286).
  { pattern: /\b1\d{12}\b/g, token: MASK.token },
  // Long hex.
  { pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi, token: MASK.token },
  // Long base64 (both cases and a digit).
  { pattern: /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{24,}={0,2}/g, token: MASK.token },
  // Copyright years (a range included).
  { pattern: /((?:©|\(c\)|copyright|版权所有)\s*(?:\d{4}\s*[-–—~]\s*)?)\d{4}/gi, token: `$1${MASK.year}` },
];

/** One clean line with the default masks applied, and how many applied. */
export function maskLine(line: string, maskNumbers: boolean, defaultMasks = true): { readonly text: string; readonly masked: number } {
  let text = line;
  let masked = 0;
  if (defaultMasks) {
    for (const { pattern, token } of MASKS) {
      text = text.replace(pattern, (...args: unknown[]) => {
        masked += 1;
        const groups = args.slice(1, -2).filter((value): value is string => typeof value === 'string');
        return token.replace('$1', groups[0] ?? '');
      });
    }
  }
  if (maskNumbers) {
    text = text.replace(/\d+(?:[.,]\d+)*/g, () => {
      masked += 1;
      return MASK.number;
    });
  }
  return { text, masked };
}

/** Stage 3: the lines as compared. */
export function normalizeLines(lines: readonly string[], options: NormalizeOptions): Normalized {
  const ignored = new Set(options.ignoredLines);
  const out: string[] = [];
  let masked = 0;
  let dropped = 0;
  for (const line of lines) {
    const clean = cleanLine(line);
    if (clean === '') continue;
    const result = maskLine(clean, options.maskNumbers, options.defaultMasks);
    masked += result.masked;
    if (ignored.has(result.text)) {
      dropped += 1;
      continue;
    }
    out.push(result.text);
  }
  return { lines: out, masked, ignored: dropped };
}
