/**
 * The owner's settings (Settings in proto/mailsort/ui/v1/status.proto), kept as one JSON row of MailsortState's meta
 * table, and the mode in force: the owner's mode lowered by the deployment's MAILSORT_MODE ceiling and by the breaker.
 */
import type { ModeName } from './env.ts';
import { newEtag } from './ids.ts';
import { DEFAULT_DAILY_NEURON_BUDGET, DEFAULT_DAILY_WRITE_LIMIT, DEFAULT_PRECISION_TARGET, DEFAULT_RUN_WRITE_LIMIT, DEFAULT_THRESHOLD } from './limits.ts';
import type { Store } from './store.ts';

export interface SettingsValue {
  readonly mode: ModeName;
  readonly runWriteLimit: number;
  readonly dailyWriteLimit: number;
  readonly dailyNeuronBudget: number;
  readonly defaultThreshold: number;
  readonly precisionTarget: number;
  /** Why the breaker tripped (`daily_limit`, `run_limit`, `label_share`), or '' when it did not. */
  readonly breaker: string;
  readonly etag: string;
}

/** A fresh install starts in shadow: nothing is written to Gmail until the owner chooses live. */
export const DEFAULTS: Omit<SettingsValue, 'etag'> = {
  mode: 'shadow',
  runWriteLimit: DEFAULT_RUN_WRITE_LIMIT,
  dailyWriteLimit: DEFAULT_DAILY_WRITE_LIMIT,
  dailyNeuronBudget: DEFAULT_DAILY_NEURON_BUDGET,
  defaultThreshold: DEFAULT_THRESHOLD,
  precisionTarget: DEFAULT_PRECISION_TARGET,
  breaker: '',
};

const RANK: Readonly<Record<ModeName, number>> = { off: 0, shadow: 1, live: 2 };

export function readSettings(store: Store): SettingsValue {
  let stored: Partial<SettingsValue> = {};
  try {
    stored = JSON.parse(store.getMeta('settings') ?? '{}') as Partial<SettingsValue>;
  } catch {
    // A row this code did not write: the defaults.
  }
  const mode = stored.mode === 'off' || stored.mode === 'live' || stored.mode === 'shadow' ? stored.mode : DEFAULTS.mode;
  const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    mode,
    runWriteLimit: number(stored.runWriteLimit, DEFAULTS.runWriteLimit),
    dailyWriteLimit: number(stored.dailyWriteLimit, DEFAULTS.dailyWriteLimit),
    dailyNeuronBudget: number(stored.dailyNeuronBudget, DEFAULTS.dailyNeuronBudget),
    defaultThreshold: number(stored.defaultThreshold, DEFAULTS.defaultThreshold),
    precisionTarget: number(stored.precisionTarget, DEFAULTS.precisionTarget),
    breaker: typeof stored.breaker === 'string' ? stored.breaker : '',
    etag: typeof stored.etag === 'string' ? stored.etag : 'initial',
  };
}

export function writeSettings(store: Store, value: Omit<SettingsValue, 'etag'>, now: number): SettingsValue {
  const next = { ...value, etag: newEtag(now) };
  store.setMeta('settings', JSON.stringify(next));
  return next;
}

/** The mode in force: the lower of the owner's and the deployment's, and shadow at most while the breaker is tripped. */
export function effectiveMode(settings: Pick<SettingsValue, 'mode' | 'breaker'>, ceiling: ModeName): ModeName {
  const mode = RANK[settings.mode] <= RANK[ceiling] ? settings.mode : ceiling;
  return mode === 'live' && settings.breaker !== '' ? 'shadow' : mode;
}

/** Trips the breaker (once: the first reason stays until the owner sets the mode again). */
export function tripBreaker(store: Store, reason: string, now: number): void {
  const settings = readSettings(store);
  if (settings.breaker !== '') return;
  writeSettings(store, { ...settings, breaker: reason }, now);
  store.pushError(`breaker_${reason}`);
}
