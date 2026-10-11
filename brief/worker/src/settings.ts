/**
 * The owner's settings (proto/brief/ui/v1 Settings, ../../docs/design.md §11, §13), kept in meta: whether the brief is
 * paused (every model call and every send; fetching and the archive go on) and the month's budget for the Claude API.
 */
import { newEtag } from './ids.ts';
import { DEFAULT_MONTHLY_BUDGET_USD } from './limits.ts';
import type { Store } from './store.ts';

export interface SettingsState {
  readonly paused: boolean;
  readonly monthlyBudgetUsd: number;
  readonly etag: string;
}

/** Whether the owner paused the brief (read at the moment of every model call and every send). */
export function isPaused(store: Store): boolean {
  return store.getMeta('paused') === '1';
}

export function readSettings(store: Store): SettingsState {
  const budget = Number(store.getMeta('monthly_budget_usd') ?? '');
  return {
    paused: isPaused(store),
    monthlyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_MONTHLY_BUDGET_USD,
    etag: store.getMeta('settings_etag') ?? 'initial',
  };
}

export function writeSettings(store: Store, changes: { readonly paused?: boolean; readonly monthlyBudgetUsd?: number }, now: number): SettingsState {
  if (changes.paused !== undefined) store.setMeta('paused', changes.paused ? '1' : '0');
  if (changes.monthlyBudgetUsd !== undefined) store.setMeta('monthly_budget_usd', String(changes.monthlyBudgetUsd));
  store.setMeta('settings_etag', newEtag(now));
  return readSettings(store);
}
