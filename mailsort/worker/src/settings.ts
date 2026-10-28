/**
 * The owner's settings (Settings in proto/mailsort/ui/v2/status.proto), kept as one JSON row of MailsortState's meta
 * table, and the mode in force: the owner's mode lowered by the deployment's MAILSORT_MODE ceiling.
 * An older row may still hold a retired threshold, precision target, Workers AI neuron budget or breaker: they are
 * ignored and dropped by the next save.
 */
import type { ModeName } from './env.ts';
import { newEtag } from './ids.ts';
import { DEFAULT_DAILY_WRITE_LIMIT, DEFAULT_RUN_WRITE_LIMIT, MINUTE } from './limits.ts';
import { CLAUDE_MONTHLY_LIMIT_MICROS, utcDay, type Store } from './store.ts';

export type ClassificationProviderName = 'claude' | 'codex';
export const CLASSIFICATION_INTERVAL_MINUTES: readonly number[] = [5, 15, 30, 60];

export interface SettingsValue {
  readonly mode: ModeName;
  readonly classificationProvider: ClassificationProviderName;
  readonly classificationIntervalMinutes: number;
  readonly runWriteLimit: number;
  readonly dailyWriteLimit: number;
  readonly etag: string;
}

/** A fresh install starts in shadow: nothing is written to Gmail until the owner chooses live. Codex is in use. */
export const DEFAULTS: Omit<SettingsValue, 'etag'> = {
  mode: 'shadow',
  classificationProvider: 'codex',
  classificationIntervalMinutes: 15,
  runWriteLimit: DEFAULT_RUN_WRITE_LIMIT,
  dailyWriteLimit: DEFAULT_DAILY_WRITE_LIMIT,
};

const RANK: Readonly<Record<ModeName, number>> = { off: 0, shadow: 1, live: 2 };

function storedSettings(store: Store): Partial<SettingsValue> {
  let stored: Partial<SettingsValue> = {};
  try {
    stored = JSON.parse(store.getMeta('settings') ?? '{}') as Partial<SettingsValue>;
  } catch {
    // A row this code did not write: the defaults.
  }
  return stored;
}

export function readSettings(store: Store): SettingsValue {
  const stored = storedSettings(store);
  const mode = stored.mode === 'off' || stored.mode === 'live' || stored.mode === 'shadow' ? stored.mode : DEFAULTS.mode;
  const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    mode,
    classificationProvider: stored.classificationProvider === 'claude' ? 'claude' : 'codex',
    classificationIntervalMinutes: CLASSIFICATION_INTERVAL_MINUTES.includes(stored.classificationIntervalMinutes ?? 0)
      ? stored.classificationIntervalMinutes ?? DEFAULTS.classificationIntervalMinutes : DEFAULTS.classificationIntervalMinutes,
    runWriteLimit: number(stored.runWriteLimit, DEFAULTS.runWriteLimit),
    dailyWriteLimit: number(stored.dailyWriteLimit, DEFAULTS.dailyWriteLimit),
    etag: typeof stored.etag === 'string' ? stored.etag : 'initial',
  };
}

export function writeSettings(store: Store, value: Omit<SettingsValue, 'etag'>, now: number): SettingsValue {
  const previous = storedSettings(store).classificationIntervalMinutes ?? 60;
  if (previous !== value.classificationIntervalMinutes) {
    const nextAt = Number(store.getMeta('next_model_at') ?? 0);
    // Only an ordinary cadence wait can move. Pending retry/deferred times and provider quota holds stay intact.
    const waiting = store.count('SELECT count(*) AS n FROM pending WHERE attempts > 0 OR deferred > 0 OR not_before > ?', now);
    const month = utcDay(now).slice(0, 7);
    const held = value.classificationProvider === 'claude'
      ? store.getMeta('claude_limited_month') === month || store.claudeUsage(month).cost_micros >= CLAUDE_MONTHLY_LIMIT_MICROS
      : store.getMeta('codex_error') === 'codex_quota';
    if (Number.isFinite(nextAt) && nextAt > now && waiting === 0 && !held) {
      store.setMeta('next_model_at', String(Math.max(now, nextAt + (value.classificationIntervalMinutes - previous) * MINUTE)));
    }
  }
  const next = { ...value, etag: newEtag(now) };
  store.setMeta('settings', JSON.stringify(next));
  return next;
}

/** Adopt the new default once, including an older idle hour, without resetting later Alarm passes. */
export function adoptClassificationInterval(store: Store, now: number): SettingsValue {
  const value = readSettings(store);
  return CLASSIFICATION_INTERVAL_MINUTES.includes(storedSettings(store).classificationIntervalMinutes ?? 0)
    ? value : writeSettings(store, value, now);
}

/** The mode in force: the lower of the owner's and the deployment's. */
export function effectiveMode(settings: Pick<SettingsValue, 'mode'>, ceiling: ModeName): ModeName {
  return RANK[settings.mode] <= RANK[ceiling] ? settings.mode : ceiling;
}
