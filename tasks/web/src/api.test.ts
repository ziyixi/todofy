import { afterEach, expect, it, vi } from 'vitest';
import type { HttpCall } from '@ziyixi/proto/http-client';
import { send } from './api';
afterEach(() => vi.unstubAllGlobals());
it('sends the first write directly with a fixed custom header and same-origin credentials', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  await send({ httpMethod: 'POST', url: '/api/tasks/v1/tasks', body: '{}' } as HttpCall);
  expect(fetcher).toHaveBeenCalledOnce();
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe('/api/tasks/v1/tasks');
  expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('1');
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
});
it('sends JSON metadata for a bodyless mutation and omits the custom header on GET', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({})));
  vi.stubGlobal('fetch', fetcher);
  await send({ httpMethod: 'DELETE', url: '/api/tasks/v1/tasks/synthetic' } as HttpCall);
  await send({ httpMethod: 'GET', url: '/api/tasks/v1/tasks' } as HttpCall);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe('application/json');
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('X-CSRF-Token')).toBe('1');
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
