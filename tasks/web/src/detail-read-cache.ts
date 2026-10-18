/** Confirmed detail reads in this page only. List projections never populate these keys. */
export type DetailReadKey = `task:${string}` | `planning:${string}:${string}`;

interface Entry {
  promise: Promise<unknown>;
  value?: unknown;
  expiresAt: number;
  pending: boolean;
}
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 30_000;
const entries = new Map<DetailReadKey, Entry>();

function current(key: DetailReadKey): Entry | undefined {
  const entry = entries.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

export function peekDetailRead<T>(key: DetailReadKey): T | undefined {
  const entry = current(key);
  if (!entry || entry.pending) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry.value as T;
}

export function readDetail<T>(
  key: DetailReadKey,
  load: () => Promise<T>,
): Promise<T> {
  const previous = current(key);
  if (previous) {
    entries.delete(key);
    entries.set(key, previous);
    return previous.promise as Promise<T>;
  }
  const entry: Entry = {
    promise: Promise.resolve().then(load),
    expiresAt: Date.now() + MAX_AGE_MS,
    pending: true,
  };
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  void entry.promise.then(
    (value: unknown) => {
      if (entries.get(key) !== entry) return;
      if (value === undefined) {
        entries.delete(key);
        return;
      }
      entry.value = value;
      entry.pending = false;
      entry.expiresAt = Date.now() + MAX_AGE_MS;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return entry.promise as Promise<T>;
}

export function clearDetailReadCache(): void {
  entries.clear();
}
