import { useEffect, useState } from 'react';

/** A page of the console, from the location hash: no Worker route per page, and a reload keeps the page. */
export type Route =
  | { readonly page: 'overview' }
  | { readonly page: 'runs'; readonly month: string }
  | { readonly page: 'run'; readonly id: string };

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MONTH = /^\d{4}-\d{2}$/;

export function routeOf(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?', 2);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'runs') {
    if (parts.length === 2 && RUN_ID.test(parts[1] ?? '')) return { page: 'run', id: parts[1] ?? '' };
    const month = new URLSearchParams(query).get('month') ?? '';
    return { page: 'runs', month: MONTH.test(month) ? month : '' };
  }
  return { page: 'overview' };
}

export const runHref = (name: string | undefined): string => `#/runs/${(name ?? '').replace(/^runs\//, '')}`;
export const runsHref = (month = ''): string => (month ? `#/runs?month=${month}` : '#/runs');

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
