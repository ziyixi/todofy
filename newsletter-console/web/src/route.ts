import { useEffect, useState } from 'react';

/** Which editions of a month the 期刊 page shows. */
export type IssueFilter = 'all' | 'delivered' | 'unsent' | 'test';
/** How an edition is read: rendered from its structured body, as the frozen email, or as the email's plain text. */
export type ReaderView = 'read' | 'mail' | 'text';
/** The ranges the 模型 page sums, in issue dates (the API's `day_count`). */
export type UsageRange = 7 | 30 | 90;

/** A page of the console, from the location hash: no Worker route per page, and a reload keeps the page. */
export type Route =
  | { readonly page: 'overview' }
  | { readonly page: 'issues'; readonly month: string; readonly filter: IssueFilter }
  | { readonly page: 'issue'; readonly id: string; readonly view: ReaderView }
  | { readonly page: 'runs'; readonly month: string }
  | { readonly page: 'run'; readonly id: string }
  | { readonly page: 'sources' }
  | { readonly page: 'models'; readonly days: UsageRange }
  | { readonly page: 'backup' };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MONTH = /^\d{4}-\d{2}$/;
const FILTERS: readonly IssueFilter[] = ['all', 'delivered', 'unsent', 'test'];
const VIEWS: readonly ReaderView[] = ['read', 'mail', 'text'];
const RANGES: readonly UsageRange[] = [7, 30, 90];

/** A value of `allowed`, else the first: an unknown query value is never passed on. */
function oneOf<T>(allowed: readonly T[], value: unknown): T {
  return allowed.find((item) => String(item) === value) ?? allowed[0]!;
}

export function routeOf(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?', 2);
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const month = params.get('month') ?? '';
  switch (parts[0]) {
    case 'runs':
      if (parts.length === 2 && ID.test(parts[1] ?? '')) return { page: 'run', id: parts[1] ?? '' };
      return { page: 'runs', month: MONTH.test(month) ? month : '' };
    case 'issues':
      if (parts.length === 2 && ID.test(parts[1] ?? '')) return { page: 'issue', id: parts[1] ?? '', view: oneOf(VIEWS, params.get('view')) };
      return { page: 'issues', month: MONTH.test(month) ? month : '', filter: oneOf(FILTERS, params.get('show')) };
    case 'sources':
      return { page: 'sources' };
    case 'models':
      return { page: 'models', days: oneOf(RANGES, params.get('days')) };
    case 'backup':
      return { page: 'backup' };
    default:
      return { page: 'overview' };
  }
}

const query = (entries: Record<string, string>): string => {
  const text = new URLSearchParams(Object.entries(entries).filter(([, value]) => value !== '')).toString();
  return text ? `?${text}` : '';
};

export const runHref = (name: string | undefined): string => `#/runs/${(name ?? '').replace(/^runs\//, '')}`;
export const runsHref = (month = ''): string => `#/runs${query({ month })}`;
export const issueHref = (name: string | undefined, view: ReaderView = 'read'): string =>
  `#/issues/${(name ?? '').replace(/^editions\//, '')}${query({ view: view === 'read' ? '' : view })}`;
export const issuesHref = (month = '', filter: IssueFilter = 'all'): string =>
  `#/issues${query({ month, show: filter === 'all' ? '' : filter })}`;
export const modelsHref = (days: UsageRange): string => `#/models${query({ days: days === 7 ? '' : String(days) })}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(routeOf(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
