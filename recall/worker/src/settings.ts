/**
 * The owner's settings (Settings in proto/recall/ui/v1/status.proto): the owner's two lists of denylist patterns, the
 * no-text ones and the site-only ones, kept in RecallState's meta table with one etag that changes on every write.
 * Every upload's answer carries both lists and the etag, so the extension follows a change within minutes, and the
 * Worker applies them to every item it receives.
 */
import { compilePatterns, type OwnerPatterns } from '../../shared/denylist.ts';
import { newEtag } from './ids.ts';
import type { Store } from './store.ts';

export interface Denylist {
  /** The no-text patterns' texts, in the owner's order. */
  readonly patterns: readonly string[];
  /** The site-only patterns' texts, in the owner's order. */
  readonly siteOnly: readonly string[];
  readonly etag: string;
}

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

/** Writes the lists given (a list left out keeps its value) with a new etag. */
export function writeDenylist(store: Store, lists: { readonly patterns?: readonly string[]; readonly siteOnly?: readonly string[] }, now: number): Denylist {
  if (lists.patterns !== undefined) store.setMeta('denylist', JSON.stringify(lists.patterns));
  if (lists.siteOnly !== undefined) store.setMeta('denylist_site_only', JSON.stringify(lists.siteOnly));
  store.setMeta('denylist_etag', newEtag(now));
  return readDenylist(store);
}

/** The owner's patterns, parsed (a stored text that no longer parses is skipped). */
export function ownerPatterns(denylist: Denylist): OwnerPatterns {
  return { siteOnly: compilePatterns(denylist.siteOnly), noText: compilePatterns(denylist.patterns) };
}
