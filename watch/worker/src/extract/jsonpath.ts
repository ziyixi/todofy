/**
 * The JSONPath subset of JsonSource.path and EmbeddedSource.path: `$`, then at most JSON_PATH_STEPS_MAX steps of
 * `.name`, `['name']` (or `["name"]`), `[n]` (a non-negative index) or `[*]` / `.*` (every element or value). No
 * filters, slices, recursion or scripts: anything else is refused at save time (INVALID_SOURCE), never guessed.
 */
import { ITEMS_MAX, JSON_PATH_STEPS_MAX, LINE_MAX } from '../limits.ts';

export type PathStep = { readonly kind: 'name'; readonly name: string } | { readonly kind: 'index'; readonly index: number } | { readonly kind: 'all' };

/** The steps of a path, or null when it is outside the subset. An empty path is the whole document. */
export function parsePath(path: string): PathStep[] | null {
  const text = path.trim();
  if (text === '' || text === '$') return [];
  if (!text.startsWith('$')) return null;
  const steps: PathStep[] = [];
  let i = 1;
  while (i < text.length) {
    if (steps.length >= JSON_PATH_STEPS_MAX) return null;
    const rest = text.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^\.\*/.exec(rest)) !== null || (match = /^\[\*\]/.exec(rest)) !== null) {
      steps.push({ kind: 'all' });
    } else if ((match = /^\.([A-Za-z_$][A-Za-z0-9_$-]{0,99})/.exec(rest)) !== null) {
      steps.push({ kind: 'name', name: match[1] ?? '' });
    } else if ((match = /^\[(0|[1-9][0-9]{0,6})\]/.exec(rest)) !== null) {
      steps.push({ kind: 'index', index: Number(match[1]) });
    } else if ((match = /^\[(['"])((?:(?!\1)[^\\]|\\.){1,100})\1\]/.exec(rest)) !== null) {
      steps.push({ kind: 'name', name: (match[2] ?? '').replace(/\\(.)/g, '$1') });
    } else {
      return null;
    }
    i += match[0].length;
  }
  return steps;
}

/** The values at `steps` in `document`, in document order, at most ITEMS_MAX. */
export function evaluatePath(document: unknown, steps: readonly PathStep[]): unknown[] {
  let current: unknown[] = [document];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of current) {
      if (step.kind === 'name') {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, step.name)) next.push((value as Record<string, unknown>)[step.name]);
      } else if (step.kind === 'index') {
        if (Array.isArray(value) && step.index < value.length) next.push(value[step.index]);
      } else if (Array.isArray(value)) {
        next.push(...(value as unknown[]));
      } else if (typeof value === 'object' && value !== null) {
        next.push(...(Object.values(value) as unknown[]));
      }
      if (next.length > ITEMS_MAX) break;
    }
    current = next.slice(0, ITEMS_MAX);
  }
  return current;
}

/** Compact JSON with object keys sorted, so the same value always reads the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** A value as one line: a string as itself, any other value as canonical JSON. */
export function valueLine(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return text.length > LINE_MAX ? text.slice(0, LINE_MAX) : text;
}

/** A value's item key: an object's `id`, `url`, `key` or `slug` when it has one, else its line. */
export function valueKey(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of ['id', 'url', 'key', 'slug']) {
      const key = record[name];
      if (typeof key === 'string' || typeof key === 'number') return `${name}:${String(key)}`.slice(0, LINE_MAX);
    }
  }
  return valueLine(value);
}
