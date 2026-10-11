/**
 * The owner's settings (Settings in proto/recall/ui/v1/status.proto), kept in RecallState's meta table with one etag
 * that changes on every write: the owner's two lists of denylist patterns, the no-text ones and the site-only ones,
 * and the retention window of the captured texts (retention.ts). Every upload's answer carries both lists and the
 * etag, so the extension follows a change within minutes, and the Worker applies them to every item it receives.
 */
import { compilePatterns, type OwnerPatterns } from '../../shared/denylist.ts';
import { newEtag } from './ids.ts';
import { TEXT_RETENTION_DEFAULT_DAYS, TEXT_RETENTION_MAX_DAYS, TEXT_RETENTION_MIN_DAYS } from './limits.ts';
import type { Store } from './store.ts';

export interface Denylist {
  /** The no-text patterns' texts, in the owner's order. */
  readonly patterns: readonly string[];
  /** The site-only patterns' texts, in the owner's order. */
  readonly siteOnly: readonly string[];
  readonly etag: string;
}

/** The meta key of the retention window: days, or `off` when every text stays in Cloudflare. */
const RETENTION_KEY = 'text_retention_days';

/** A stored list of pattern texts (a row this code did not write reads as none). */
function readList(store: Store, key: string): string[] {
  try {
    const value: unknown = JSON.parse(store.getMeta(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function readDenylist(store: Store): Denylist {
  return { patterns: readList(store, 'denylist'), siteOnly: readList(store, 'denylist_site_only'), etag: store.getMeta('denylist_etag') ?? 'initial' };
}

/** Whether a number of days is a retention window the owner may choose. */
export function validRetention(days: number): boolean {
  return Number.isInteger(days) && days >= TEXT_RETENTION_MIN_DAYS && days <= TEXT_RETENTION_MAX_DAYS;
}

/**
 * The retention window in days, or null when every text stays in Cloudflare. TEXT_RETENTION_DEFAULT_DAYS until the
 * owner changes it (a value this code did not write reads as the default).
 */
export function readRetention(store: Store): number | null {
  const value = store.getMeta(RETENTION_KEY);
  if (value === 'off') return null;
  const days = Number(value ?? TEXT_RETENTION_DEFAULT_DAYS);
  return validRetention(days) ? days : TEXT_RETENTION_DEFAULT_DAYS;
}

/** What an update changes: a field left out keeps its value; `retentionDays: null` keeps every text. */
export interface SettingsChange {
  readonly patterns?: readonly string[];
  readonly siteOnly?: readonly string[];
  readonly retentionDays?: number | null;
}

/** Writes the fields given with a new etag. */
export function writeSettings(store: Store, change: SettingsChange, now: number): Denylist {
  if (change.patterns !== undefined) store.setMeta('denylist', JSON.stringify(change.patterns));
  if (change.siteOnly !== undefined) store.setMeta('denylist_site_only', JSON.stringify(change.siteOnly));
  if (change.retentionDays !== undefined) store.setMeta(RETENTION_KEY, change.retentionDays === null ? 'off' : String(change.retentionDays));
  store.setMeta('denylist_etag', newEtag(now));
  return readDenylist(store);
}

/** The owner's patterns, parsed (a stored text that no longer parses is skipped). */
export function ownerPatterns(denylist: Denylist): OwnerPatterns {
  return { siteOnly: compilePatterns(denylist.siteOnly), noText: compilePatterns(denylist.patterns) };
}
