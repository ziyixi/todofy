/**
 * Keys and the paths that carry them (../../docs/design.md §2). A short link's path is `/<key>`, `/<key>/<rest>`
 * (passthrough) or `/<key>+` (preview, also with a rest); the key is case-insensitive.
 */
import { KEY_PATTERN, RESERVED_KEYS } from './limits.ts';

export type KeyProblem = 'INVALID_KEY' | 'RESERVED_KEY';

/** ASCII letters only, as in the key pattern: never Unicode case folding (the Kelvin sign is not a `k`). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/** The stored form of a key (lower case), or why it cannot be one. Reserved keys are named before the pattern. */
export function normalizeKey(input: string): { readonly key: string } | { readonly problem: KeyProblem } {
  const key = asciiLower(input);
  if (RESERVED_KEYS.has(key)) return { problem: 'RESERVED_KEY' };
  return KEY_PATTERN.test(key) ? { key } : { problem: 'INVALID_KEY' };
}

/** A short link's request path, split. `rest` is the raw (still percent-encoded) path after `/<key>/`. */
export interface ShortPath {
  readonly key: string;
  readonly preview: boolean;
  readonly rest: string;
}

/** An encoded space: what a browser's site search (`s.ziyixi.science/%s`) makes of the space after a key. */
const SPACE = '%20';

/**
 * The parts of a request path (a URL's pathname: dot segments already resolved by the URL parser), or null when its
 * first segment is not a usable key. The key ends at the first `/` or encoded space, so `/gh/a/b` and `/gh%20a/b`
 * (Chrome's site search with `s gh a/b`) both are the key `gh` with the rest `a/b`. The key is taken as written,
 * without percent-decoding (a key has no character that needs it), so `/%67h` is no key; a trailing `+` asks for the
 * preview. A trailing `/` after the key alone (`/gh/`) is no rest.
 */
export function parseShortPath(pathname: string): ShortPath | null {
  if (!pathname.startsWith('/')) return null;
  const slash = pathname.indexOf('/', 1);
  const space = pathname.indexOf(SPACE, 1);
  const bySpace = space !== -1 && (slash === -1 || space < slash);
  const end = bySpace ? space : slash;
  const segment = end === -1 ? pathname.slice(1) : pathname.slice(1, end);
  const rest = end === -1 ? '' : pathname.slice(end + (bySpace ? SPACE.length : 1));
  const preview = segment.endsWith('+');
  const normalized = normalizeKey(preview ? segment.slice(0, -1) : segment);
  if (!('key' in normalized)) return null;
  return { key: normalized.key, preview, rest };
}

/** The path that names the same request under the owner's continuation, /_/k/... (key in lower case). */
export function continuationPath(path: ShortPath): string {
  return `/_/k/${path.key}${path.preview ? '+' : ''}${path.rest === '' ? '' : `/${path.rest}`}`;
}
