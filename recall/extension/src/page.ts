/**
 * What recall records of a tab's URL and title (../../docs/design.md §3.5-§3.7), with the shared code the Worker runs
 * again on arrival: the URL normalized, its page ID computed from the whole normalized URL before scrubbing, then
 * scrubbed and cut; the denylist's level decided on the normalized URL (its path and a hash router's route). A page
 * recall never records (its own host, a URL that is not http(s) or whose host the archive cannot carry) has no
 * PageInfo, so it leaves no visit.
 */
import { denyLevel, routePaths, type DenyLevel, type OwnerPatterns } from '../../shared/denylist.ts';
import { scrubText, scrubUrl } from '../../shared/scrub.ts';
import { cutText, cutUrl, normalizeUrl, pageIdOf, rootUrl } from '../../shared/url.ts';

/** The levels a recorded page has: with its text, without it, or by its site alone. */
export type RecordLevel = Exclude<DenyLevel, 'never'>;

export interface PageInfo {
  /** The page ID: of the whole normalized URL before scrubbing, or of the site's root URL for a site-only page. */
  readonly pageId: string;
  /** The URL as uploaded: normalized, scrubbed and cut (a site-only page's root URL). */
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly level: RecordLevel;
}

/** The denylist a page is judged by: the owner's two lists (from recall's answers) and recall's own hosts. */
export interface Denylist {
  readonly patterns: OwnerPatterns;
  readonly ownHosts: readonly string[];
}

/** What recall records of a URL, or null when it records nothing (not http(s), or recall's own pages). */
export async function pageOf(rawUrl: string, denylist: Denylist): Promise<PageInfo | null> {
  const normalized = normalizeUrl(rawUrl);
  if (normalized === null) return null;
  const parsed = new URL(normalized.url);
  const level = denyLevel(normalized.host, routePaths(parsed.pathname, parsed.hash), denylist.patterns, denylist.ownHosts);
  if (level === 'never') return null;
  if (level === 'site_only') {
    const root = rootUrl(normalized.url) ?? normalized.url;
    return { pageId: await pageIdOf(root), url: root, urlTruncated: false, level };
  }
  const cut = cutUrl(scrubUrl(normalized.url));
  return { pageId: await pageIdOf(normalized.url), url: cut.url, urlTruncated: cut.truncated, level };
}

/** A title as recorded: scrubbed and cut, and none for a site-only page. */
export function titleOf(page: PageInfo, rawTitle: string): string {
  return page.level === 'site_only' ? '' : cutText(scrubText(rawTitle));
}
